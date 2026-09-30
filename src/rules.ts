import type { Pod, K8sEvent, ContainerStatus, ContainerStateTerminated } from './k8s-types';

/**
 * The rule engine. Each Rule inspects the real, documented fields of a
 * Pod's status (phase, conditions, containerStatuses[].state/lastState,
 * restartCount) together with the Events involving that pod, and - if the
 * specific combination of signals it looks for is present - returns a
 * plain-English diagnosis. Rules are evaluated in order; the first match
 * wins, so more specific rules (e.g. OOMKilled) are listed before more
 * generic ones (e.g. "container is crash-looping for some reason").
 */

export interface AnalysisContext {
  pod: Pod;
  /** Events already filtered to this pod, most-recent first. */
  events: K8sEvent[];
  /** containerStatuses + initContainerStatuses combined. */
  containerStatuses: ContainerStatus[];
}

export interface RuleMatch {
  summary: string;
  detail: string;
}

export interface Rule {
  id: string;
  description: string;
  match(ctx: AnalysisContext): RuleMatch | null;
}

function includesAny(haystack: string | undefined, needles: string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function findEvent(
  events: K8sEvent[],
  opts: { reasons?: string[]; messageIncludesAny?: string[] },
): K8sEvent | undefined {
  return events.find((e) => {
    if (opts.reasons && !opts.reasons.includes(e.reason ?? '')) return false;
    if (opts.messageIncludesAny && !includesAny(e.message, opts.messageIncludesAny)) return false;
    return true;
  });
}

function containersWithWaitingReason(statuses: ContainerStatus[], reasons: string[]): ContainerStatus[] {
  return statuses.filter((cs) => cs.state?.waiting?.reason && reasons.includes(cs.state.waiting.reason));
}

function lastTerminated(cs: ContainerStatus): ContainerStateTerminated | undefined {
  return cs.state?.terminated ?? cs.lastState?.terminated;
}

/** Extracts the container name from an event's involvedObject.fieldPath, e.g. "spec.containers{app}" -> "app". */
function containerNameFromFieldPath(fieldPath: string | undefined): string | undefined {
  if (!fieldPath) return undefined;
  const match = /^spec\.(?:containers|initContainers)\{(.+)\}$/.exec(fieldPath);
  return match?.[1];
}

/**
 * Picks the containerStatus that a matched event actually concerns, using
 * involvedObject.fieldPath when the event carries one. Falls back to
 * undefined (letting the caller decide a default) when the event has no
 * fieldPath or it doesn't correspond to any candidate - this keeps behavior
 * unchanged for events/clusters that never set fieldPath.
 */
function containerForEvent(statuses: ContainerStatus[], event: K8sEvent | undefined): ContainerStatus | undefined {
  const name = containerNameFromFieldPath(event?.involvedObject?.fieldPath);
  if (!name) return undefined;
  return statuses.find((cs) => cs.name === name);
}

export const rules: Rule[] = [
  // 1. OOMKilled - checked before the generic CrashLoopBackOff rules below,
  // because a pod that is being OOM-killed usually also shows
  // waiting.reason === "CrashLoopBackOff" and we want the more specific,
  // more actionable diagnosis to win.
  {
    id: 'oom-killed',
    description: 'A container is being killed for exceeding its memory limit (OOMKilled).',
    match(ctx) {
      const cs = ctx.containerStatuses.find((c) => lastTerminated(c)?.reason === 'OOMKilled');
      if (!cs) return null;
      const t = lastTerminated(cs)!;
      return {
        summary: `Container "${cs.name}" is being OOMKilled (exit code ${t.exitCode}) - it exceeded its memory limit.`,
        detail: `Kubernetes killed the container after it used more memory than its configured limit (restartCount=${cs.restartCount}). Raise the container's memory limit/request, or investigate a memory leak / undersized limit in the application.`,
      };
    },
  },

  // 2. CrashLoopBackOff with exit 143 (SIGTERM) - the process was asked to
  // stop (failed liveness probe, deploy rollout, or it didn't exit within
  // the grace period) rather than crashing on its own.
  {
    id: 'crashloop-sigterm',
    description: 'CrashLoopBackOff where the container last exited with code 143 (SIGTERM).',
    match(ctx) {
      const cs = containersWithWaitingReason(ctx.containerStatuses, ['CrashLoopBackOff']).find(
        (c) => lastTerminated(c)?.exitCode === 143,
      );
      if (!cs) return null;
      return {
        summary: `Container "${cs.name}" is in CrashLoopBackOff after last exiting with code 143 (SIGTERM).`,
        detail: `The container was sent a termination signal (a failed liveness probe, a rollout, or it didn't shut down within its grace period) and Kubernetes is now restarting it repeatedly (restartCount=${cs.restartCount}). Check for a liveness-probe "Killing"/"Unhealthy" event and whether the app shuts down cleanly on SIGTERM.`,
      };
    },
  },

  // 3. CrashLoopBackOff, generic - the process is exiting on its own
  // (typically exit code 1, but any code not covered by a more specific
  // rule above lands here).
  {
    id: 'crashloop-generic',
    description: 'CrashLoopBackOff where the container keeps exiting on its own with a non-zero exit code.',
    match(ctx) {
      const cs = containersWithWaitingReason(ctx.containerStatuses, ['CrashLoopBackOff'])[0];
      if (!cs) return null;
      const t = lastTerminated(cs);
      return {
        summary: `Container "${cs.name}" is in CrashLoopBackOff${
          t ? ` (last exit code ${t.exitCode})` : ''
        } - it keeps crashing shortly after starting.`,
        detail: `The application process inside the container is exiting on its own (restartCount=${cs.restartCount}). This is usually an application-level error - check "kubectl logs ${ctx.pod.metadata.name} -c ${cs.name} --previous" for the actual error/stack trace.`,
      };
    },
  },

  // 4. ImagePullBackOff / ErrImagePull - tag or image does not exist.
  {
    id: 'imagepull-manifest-unknown',
    description: "ImagePullBackOff because the image tag/manifest doesn't exist in the registry.",
    match(ctx) {
      const candidates = containersWithWaitingReason(ctx.containerStatuses, ['ImagePullBackOff', 'ErrImagePull']);
      if (candidates.length === 0) return null;
      const ev = findEvent(ctx.events, {
        reasons: ['Failed'],
        messageIncludesAny: ['manifest unknown', 'not found', 'repository does not exist', 'name unknown'],
      });
      if (!ev) return null;
      const cs = containerForEvent(candidates, ev) ?? candidates[0];
      return {
        summary: `Container "${cs.name}" can't pull its image - the tag doesn't exist in the registry.`,
        detail: `Event: "${ev.message}". Double-check the image name/tag (${
          cs.image ?? 'unknown'
        }) - it likely doesn't exist in the target registry, or a typo was pushed.`,
      };
    },
  },

  // 5. ImagePullBackOff / ErrImagePull - registry auth failure.
  {
    id: 'imagepull-auth',
    description: "ImagePullBackOff because the cluster can't authenticate to a private registry.",
    match(ctx) {
      const candidates = containersWithWaitingReason(ctx.containerStatuses, ['ImagePullBackOff', 'ErrImagePull']);
      if (candidates.length === 0) return null;
      const ev = findEvent(ctx.events, {
        reasons: ['Failed'],
        messageIncludesAny: [
          'no basic auth credentials',
          'unauthorized',
          'pull access denied',
          'authentication required',
          '403',
        ],
      });
      if (!ev) return null;
      const cs = containerForEvent(candidates, ev) ?? candidates[0];
      return {
        summary: `Container "${cs.name}" can't pull its image - the cluster can't authenticate to the registry.`,
        detail: `Event: "${ev.message}". This image is likely private; check that a valid imagePullSecrets entry is attached to the pod or its service account.`,
      };
    },
  },

  // 6. CreateContainerConfigError - missing ConfigMap.
  {
    id: 'config-configmap-missing',
    description: 'CreateContainerConfigError because a referenced ConfigMap does not exist.',
    match(ctx) {
      const cs = containersWithWaitingReason(ctx.containerStatuses, ['CreateContainerConfigError'])[0];
      if (!cs) return null;
      const waitingMsg = cs.state?.waiting?.message ?? '';
      const ev = findEvent(ctx.events, { messageIncludesAny: ['configmap'] });
      if (!includesAny(waitingMsg, ['configmap']) && !ev) return null;
      const message = waitingMsg || ev?.message || '';
      return {
        summary: `Container "${cs.name}" can't start - it references a ConfigMap that doesn't exist.`,
        detail: `Message: "${message}". Create the missing ConfigMap, or fix the name referenced in envFrom/env/volumes on the pod spec.`,
      };
    },
  },

  // 7. CreateContainerConfigError - missing Secret.
  {
    id: 'config-secret-missing',
    description: 'CreateContainerConfigError because a referenced Secret does not exist.',
    match(ctx) {
      const cs = containersWithWaitingReason(ctx.containerStatuses, ['CreateContainerConfigError'])[0];
      if (!cs) return null;
      const waitingMsg = cs.state?.waiting?.message ?? '';
      const ev = findEvent(ctx.events, { messageIncludesAny: ['secret'] });
      if (!includesAny(waitingMsg, ['secret']) && !ev) return null;
      const message = waitingMsg || ev?.message || '';
      return {
        summary: `Container "${cs.name}" can't start - it references a Secret that doesn't exist.`,
        detail: `Message: "${message}". Create the missing Secret, or fix the name referenced in envFrom/env/volumes on the pod spec.`,
      };
    },
  },

  // 8. Readiness probe failing - container is up but not serving traffic.
  {
    id: 'readiness-probe-failing',
    description: 'Container is running but failing its readiness probe.',
    match(ctx) {
      const ev = findEvent(ctx.events, { reasons: ['Unhealthy'], messageIncludesAny: ['readiness probe failed'] });
      if (!ev) return null;
      const cs =
        containerForEvent(ctx.containerStatuses, ev) ??
        ctx.containerStatuses.find((c) => c.state?.running) ??
        ctx.containerStatuses[0];
      return {
        summary: `Container "${cs?.name ?? 'unknown'}" is running but failing its readiness probe, so it isn't receiving traffic.`,
        detail: `Event: "${ev.message}". The process is up but not reporting ready on the configured readiness check - verify the probe's path/port and how long the app takes to become ready.`,
      };
    },
  },

  // 9. Liveness probe failing - container gets killed and restarted.
  {
    id: 'liveness-probe-restart',
    description: 'Container is being restarted because it keeps failing its liveness probe.',
    match(ctx) {
      const ev =
        findEvent(ctx.events, { reasons: ['Unhealthy'], messageIncludesAny: ['liveness probe failed'] }) ??
        findEvent(ctx.events, { reasons: ['Killing'], messageIncludesAny: ['liveness probe failed', 'failed liveness probe'] });
      if (!ev) return null;
      const cs = containerForEvent(ctx.containerStatuses, ev) ?? ctx.containerStatuses[0];
      return {
        summary: `Container "${cs?.name ?? 'unknown'}" is being restarted because it keeps failing its liveness probe.`,
        detail: `Event: "${ev.message}". Kubernetes considers the container unhealthy and restarts it (restartCount=${
          cs?.restartCount ?? '?'
        }) - check whether the app hangs/deadlocks under load, or whether the probe is too aggressive (timeout/period too short).`,
      };
    },
  },

  // 10. PVC not bound - pod can't start because storage isn't available.
  {
    id: 'pvc-unbound',
    description: "Pod can't start because a PersistentVolumeClaim it depends on isn't bound.",
    match(ctx) {
      // A pod that has already been scheduled and started (Running/Succeeded/...)
      // cannot currently have an unresolved "can't start, PVC not bound" problem -
      // any such event still sitting in the cluster's retention window is stale.
      if (ctx.pod.status?.phase !== 'Pending') return null;
      const ev = findEvent(ctx.events, {
        reasons: ['FailedScheduling', 'FailedMount', 'FailedAttachVolume'],
        messageIncludesAny: ['persistentvolumeclaim', 'pvc'],
      });
      if (!ev) return null;
      return {
        summary: "Pod can't start because a PersistentVolumeClaim it depends on isn't bound.",
        detail: `Event: "${ev.message}". Check that the referenced PVC exists in this namespace and that a StorageClass/PersistentVolume is available to satisfy it.`,
      };
    },
  },

  // 11. FailedScheduling - insufficient cpu/memory across all nodes.
  {
    id: 'insufficient-resources',
    description: 'FailedScheduling because no node has enough free CPU/memory for the pod.',
    match(ctx) {
      // A pod that is already Running/Succeeded/... has, by definition, already
      // been scheduled - a lingering FailedScheduling event can't describe its
      // current state.
      if (ctx.pod.status?.phase !== 'Pending') return null;
      const ev = findEvent(ctx.events, {
        reasons: ['FailedScheduling'],
        messageIncludesAny: ['insufficient cpu', 'insufficient memory'],
      });
      if (!ev) return null;
      const resource = includesAny(ev.message, ['insufficient cpu']) ? 'CPU' : 'memory';
      return {
        summary: `Pod can't be scheduled - no node currently has enough free ${resource} to fit this pod's requests.`,
        detail: `Event: "${ev.message}". Lower the pod's resource requests, add capacity to the cluster, or free up ${resource} on existing nodes.`,
      };
    },
  },

  // 12. FailedScheduling - node selector/affinity/taint mismatch.
  {
    id: 'unschedulable-node-affinity',
    description: "FailedScheduling because no node matches the pod's node selector/affinity, or all matches are tainted.",
    match(ctx) {
      // Same reasoning as the other FailedScheduling-driven rules above: once
      // a pod is actually running, it has already been placed on a node.
      if (ctx.pod.status?.phase !== 'Pending') return null;
      const ev = findEvent(ctx.events, {
        reasons: ['FailedScheduling'],
        messageIncludesAny: ["didn't match", 'node(s) had taint', "node(s) didn't match", 'node affinity'],
      });
      if (!ev) return null;
      return {
        summary: "Pod can't be scheduled - no node satisfies its node selector/affinity rules, or all matching nodes are tainted.",
        detail: `Event: "${ev.message}". Review the pod's nodeSelector/affinity rules and any taints on candidate nodes; add matching tolerations if that's intentional.`,
      };
    },
  },
];
