import type { Pod, PodList, K8sEvent, EventList, ContainerStatus } from './k8s-types';
import { rules, type AnalysisContext } from './rules';

export type PodHealthStatus = 'healthy' | 'issue-found' | 'inconclusive';

export interface ContainerSummary {
  name: string;
  ready: boolean;
  restartCount: number;
  stateSummary: string;
}

export interface PodDiagnosis {
  podName: string;
  namespace?: string;
  phase?: string;
  containers: ContainerSummary[];
  status: PodHealthStatus;
  ruleId?: string;
  summary: string;
  detail?: string;
}

function eventsForPod(pod: Pod, events: K8sEvent[]): K8sEvent[] {
  return events
    .filter(
      (e) =>
        e.involvedObject?.kind === 'Pod' &&
        e.involvedObject?.name === pod.metadata.name &&
        (!pod.metadata.namespace || !e.involvedObject.namespace || e.involvedObject.namespace === pod.metadata.namespace),
    )
    .slice()
    .sort((a, b) => {
      const at = new Date(a.lastTimestamp ?? a.firstTimestamp ?? 0).getTime();
      const bt = new Date(b.lastTimestamp ?? b.firstTimestamp ?? 0).getTime();
      return bt - at;
    });
}

function summarizeContainerState(cs: ContainerStatus): string {
  const s = cs.state;
  if (s?.waiting) return `waiting: ${s.waiting.reason ?? 'Unknown'}`;
  if (s?.running) return 'running';
  if (s?.terminated) return `terminated: ${s.terminated.reason ?? 'Unknown'} (exit ${s.terminated.exitCode})`;
  return 'unknown';
}

function isHealthy(pod: Pod, events: K8sEvent[]): boolean {
  const status = pod.status;
  if (!status) return false;
  if (status.phase === 'Succeeded') return true;
  if (status.phase !== 'Running') return false;

  const readyCondition = status.conditions?.find((c) => c.type === 'Ready');
  if (readyCondition && readyCondition.status !== 'True') return false;

  const containerStatuses = status.containerStatuses ?? [];
  if (containerStatuses.length === 0) return false;
  if (!containerStatuses.every((cs) => cs.ready)) return false;

  const hasWarnings = events.some((e) => e.type === 'Warning');
  return !hasWarnings;
}

export function analyzePod(pod: Pod, allEvents: K8sEvent[]): PodDiagnosis {
  const events = eventsForPod(pod, allEvents);
  const containerStatuses = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const containers: ContainerSummary[] = containerStatuses.map((cs) => ({
    name: cs.name,
    ready: cs.ready,
    restartCount: cs.restartCount,
    stateSummary: summarizeContainerState(cs),
  }));

  const base = {
    podName: pod.metadata.name,
    namespace: pod.metadata.namespace,
    phase: pod.status?.phase,
    containers,
  };

  if (isHealthy(pod, events)) {
    return {
      ...base,
      status: 'healthy',
      summary: 'Pod is running and ready; no issues detected.',
    };
  }

  const ctx: AnalysisContext = { pod, events, containerStatuses };

  for (const rule of rules) {
    const match = rule.match(ctx);
    if (match) {
      return {
        ...base,
        status: 'issue-found',
        ruleId: rule.id,
        summary: match.summary,
        detail: match.detail,
      };
    }
  }

  // Honest fallback: we could not confidently match a known failure
  // pattern. Rather than guess, surface the raw signal so a human can
  // take it from here.
  const rawSignals: string[] = [`phase=${pod.status?.phase ?? 'Unknown'}`];
  for (const cs of containerStatuses) {
    rawSignals.push(`container ${cs.name}: ${summarizeContainerState(cs)}, restarts=${cs.restartCount}, ready=${cs.ready}`);
  }
  for (const cond of pod.status?.conditions ?? []) {
    if (cond.status !== 'True') {
      rawSignals.push(`condition ${cond.type}=${cond.status}${cond.reason ? ` (${cond.reason})` : ''}${
        cond.message ? `: ${cond.message}` : ''
      }`);
    }
  }
  for (const e of events.slice(0, 5)) {
    rawSignals.push(`event[${e.type ?? 'Unknown'}] ${e.reason ?? 'Unknown'}: ${e.message ?? ''}`);
  }
  if (events.length === 0) {
    rawSignals.push('(no events found for this pod)');
  }

  return {
    ...base,
    status: 'inconclusive',
    summary: 'Inconclusive - no known failure pattern matched this pod. Here is the raw signal for manual review:',
    detail: rawSignals.join('\n'),
  };
}

export function analyzeNamespace(podList: PodList, eventList: EventList): PodDiagnosis[] {
  const events = eventList.items ?? [];
  return (podList.items ?? []).map((pod) => analyzePod(pod, events));
}
