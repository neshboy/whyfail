import type { PodDiagnosis } from './analyzer';

const STATUS_LABEL: Record<PodDiagnosis['status'], string> = {
  healthy: '[OK]',
  'issue-found': '[ISSUE]',
  inconclusive: '[?]',
};

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

// Strips ANSI/control escape sequences (keeping \n and \t) from cluster-sourced
// free text (event messages, condition messages, container waiting/terminated
// messages) before it reaches the terminal. Without this, a hostile or
// compromised workload could embed escape codes (e.g. via an exec-probe's own
// output, which kubelet surfaces verbatim in "Unhealthy" event messages) to
// spoof or hide lines in the very diagnostic report an operator is reading.
function stripControlSequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

export function formatReport(results: PodDiagnosis[], namespace?: string): string {
  const lines: string[] = [];
  const title = `Whyfail report${namespace ? ` - namespace "${namespace}"` : ''}`;
  lines.push(title);
  lines.push('='.repeat(title.length));

  if (results.length === 0) {
    lines.push('');
    lines.push('No pods found.');
    return lines.join('\n');
  }

  let healthy = 0;
  let issues = 0;
  let inconclusive = 0;

  for (const r of results) {
    if (r.status === 'healthy') healthy++;
    else if (r.status === 'issue-found') issues++;
    else if (r.status === 'inconclusive') inconclusive++;

    lines.push('');
    lines.push(`${STATUS_LABEL[r.status]} Pod: ${r.podName}  (phase: ${r.phase ?? 'Unknown'})`);
    for (const c of r.containers) {
      lines.push(`    - container ${c.name}: ${c.stateSummary}, ready=${c.ready}, restarts=${c.restartCount}`);
    }
    lines.push(`    Diagnosis: ${r.summary}`);
    if (r.detail) {
      lines.push(indent(r.detail, '    '));
    }
  }

  lines.push('');
  lines.push('-'.repeat(title.length));
  lines.push(`Summary: ${results.length} pod(s) - ${healthy} healthy, ${issues} diagnosed, ${inconclusive} inconclusive.`);

  return stripControlSequences(lines.join('\n'));
}
