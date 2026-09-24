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

  for (const r of results) {
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

  const healthy = results.filter((r) => r.status === 'healthy').length;
  const issues = results.filter((r) => r.status === 'issue-found').length;
  const inconclusive = results.filter((r) => r.status === 'inconclusive').length;

  lines.push('');
  lines.push('-'.repeat(title.length));
  lines.push(`Summary: ${results.length} pod(s) - ${healthy} healthy, ${issues} diagnosed, ${inconclusive} inconclusive.`);

  return lines.join('\n');
}
