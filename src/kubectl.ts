import { execFileSync } from 'node:child_process';
import type { PodList, EventList } from './k8s-types';

/** Raised when kubectl is missing, or a command against a live cluster fails. */
export class KubectlError extends Error {}

function runKubectl(args: string[]): string {
  try {
    // execFileSync with an argv array (never a shell string) - avoids any
    // shell interpolation/injection risk from namespace names etc.
    return execFileSync('kubectl', args, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 64,
      // Capture stdout/stderr into buffers instead of letting the child
      // inherit our stderr - otherwise kubectl's own error logging would
      // print once "live" and then again inside our formatted error below.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === 'ENOENT') {
      throw new KubectlError('kubectl was not found on PATH.');
    }
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    throw new KubectlError(`kubectl command failed: ${stderr.trim()}`);
  }
}

export function fetchPods(namespace: string): PodList {
  const out = runKubectl(['get', 'pods', '-n', namespace, '-o', 'json']);
  return JSON.parse(out) as PodList;
}

export function fetchEvents(namespace: string): EventList {
  const out = runKubectl(['get', 'events', '-n', namespace, '-o', 'json']);
  return JSON.parse(out) as EventList;
}
