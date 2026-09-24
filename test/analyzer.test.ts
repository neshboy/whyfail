import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeNamespace } from '../src/analyzer';
import type { PodList, EventList } from '../src/k8s-types';

function loadFixture(name: string): { pods: PodList; events: EventList } {
  const dir = path.join(__dirname, 'fixtures', name);
  const pods = JSON.parse(readFileSync(path.join(dir, 'pods.json'), 'utf-8')) as PodList;
  const events = JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf-8')) as EventList;
  return { pods, events };
}

/**
 * Each of these fixtures pairs a hand-built kubectl-shaped pods.json /
 * events.json with the single rule it is designed to trigger. This is the
 * core contract of Whyfail's rule engine: given real Kubernetes signal
 * shapes, it must produce the one specific, correct diagnosis - not a
 * neighboring one, and not a guess.
 */
const expectedRuleMatches: Array<{ fixture: string; ruleId: string; summaryIncludes: string }> = [
  { fixture: 'oom-killed', ruleId: 'oom-killed', summaryIncludes: 'OOMKilled' },
  { fixture: 'crashloop-sigterm', ruleId: 'crashloop-sigterm', summaryIncludes: 'code 143' },
  { fixture: 'crashloop-generic', ruleId: 'crashloop-generic', summaryIncludes: 'CrashLoopBackOff' },
  { fixture: 'imagepull-manifest-unknown', ruleId: 'imagepull-manifest-unknown', summaryIncludes: "doesn't exist in the registry" },
  { fixture: 'imagepull-auth', ruleId: 'imagepull-auth', summaryIncludes: "can't authenticate" },
  { fixture: 'config-configmap-missing', ruleId: 'config-configmap-missing', summaryIncludes: 'ConfigMap' },
  { fixture: 'config-secret-missing', ruleId: 'config-secret-missing', summaryIncludes: 'Secret' },
  { fixture: 'readiness-probe-failing', ruleId: 'readiness-probe-failing', summaryIncludes: 'readiness probe' },
  { fixture: 'liveness-probe-restart', ruleId: 'liveness-probe-restart', summaryIncludes: 'liveness probe' },
  { fixture: 'pvc-unbound', ruleId: 'pvc-unbound', summaryIncludes: 'PersistentVolumeClaim' },
  { fixture: 'insufficient-resources', ruleId: 'insufficient-resources', summaryIncludes: 'CPU' },
  { fixture: 'unschedulable-node-affinity', ruleId: 'unschedulable-node-affinity', summaryIncludes: 'node selector/affinity' },
];

describe('rule engine diagnoses each distinct real-world failure fixture correctly', () => {
  for (const { fixture, ruleId, summaryIncludes } of expectedRuleMatches) {
    it(`diagnoses "${fixture}" as ${ruleId}`, () => {
      const { pods, events } = loadFixture(fixture);
      const [result] = analyzeNamespace(pods, events);
      expect(result.status).toBe('issue-found');
      expect(result.ruleId).toBe(ruleId);
      expect(result.summary).toContain(summaryIncludes);
    });
  }
});

describe('honest fallbacks', () => {
  it('reports "inconclusive" rather than guessing when no rule matches', () => {
    const { pods, events } = loadFixture('inconclusive');
    const [result] = analyzeNamespace(pods, events);
    expect(result.status).toBe('inconclusive');
    expect(result.ruleId).toBeUndefined();
    expect(result.summary.toLowerCase()).toContain('inconclusive');
    // The raw signal must still be surfaced so a human can take it from here.
    expect(result.detail).toContain('FailedCreatePodSandBox');
  });

  it('reports "healthy" for a pod with no failure signal at all', () => {
    const { pods, events } = loadFixture('healthy');
    const [result] = analyzeNamespace(pods, events);
    expect(result.status).toBe('healthy');
    expect(result.ruleId).toBeUndefined();
  });
});

describe('rule priority ordering', () => {
  it('prefers the OOMKilled diagnosis over the generic CrashLoopBackOff one when both signals are present', () => {
    const { pods, events } = loadFixture('oom-killed');
    const [result] = analyzeNamespace(pods, events);
    // This fixture's container is *also* waiting on CrashLoopBackOff, which
    // would otherwise satisfy the generic crashloop rule - OOMKilled must win.
    expect(result.ruleId).toBe('oom-killed');
    expect(result.ruleId).not.toBe('crashloop-generic');
  });

  it('prefers the specific exit-143 crashloop diagnosis over the generic one', () => {
    const { pods, events } = loadFixture('crashloop-sigterm');
    const [result] = analyzeNamespace(pods, events);
    expect(result.ruleId).toBe('crashloop-sigterm');
    expect(result.ruleId).not.toBe('crashloop-generic');
  });
});

describe('multi-pod namespaces', () => {
  it('produces one independent diagnosis per pod when analyzing several pods at once', () => {
    const a = loadFixture('oom-killed');
    const b = loadFixture('healthy');
    const combinedPods: PodList = { items: [...a.pods.items, ...b.pods.items] };
    const combinedEvents: EventList = { items: [...a.events.items, ...b.events.items] };

    const results = analyzeNamespace(combinedPods, combinedEvents);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.podName === a.pods.items[0].metadata.name)?.ruleId).toBe('oom-killed');
    expect(results.find((r) => r.podName === b.pods.items[0].metadata.name)?.status).toBe('healthy');
  });
});
