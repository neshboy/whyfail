import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../src/cli';

const fixture = (name: string, file: 'pods.json' | 'events.json') =>
  path.join(__dirname, 'fixtures', name, file);

describe('CLI argument handling and offline (--from-file) mode', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints help and exits 0 for --help', () => {
    const code = main(['--help']);
    expect(code).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('USAGE');
  });

  it('analyzes a fixture pair via --from-file and prints the specific diagnosis', () => {
    const code = main(['--from-file', fixture('oom-killed', 'pods.json'), fixture('oom-killed', 'events.json')]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls.join('\n');
    expect(output).toContain('cache-worker');
    expect(output).toContain('OOMKilled');
  });

  it('prints the honest inconclusive fallback via --from-file for the unmatched fixture', () => {
    const code = main(['--from-file', fixture('inconclusive', 'pods.json'), fixture('inconclusive', 'events.json')]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls.join('\n');
    expect(output).toContain('Inconclusive');
  });

  it('exits 1 with a helpful message for an unrecognized argument', () => {
    const code = main(['--bogus']);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain('Unrecognized argument');
  });

  it('exits 1 when --from-file is missing its two required paths', () => {
    const code = main(['--from-file', fixture('oom-killed', 'pods.json')]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain('--from-file requires two arguments');
  });

  it('exits 1 with a clear message when the input files do not exist', () => {
    const code = main(['--from-file', 'nope-pods.json', 'nope-events.json']);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain('failed to read/parse input files');
  });
});

describe('CLI live-cluster mode (real kubectl shell-out)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('either analyzes a real reachable cluster, or fails honestly and points at --from-file', () => {
    // This genuinely shells out to `kubectl get pods/events -n default -o json`.
    // On a machine with no reachable cluster it must fail honestly (never
    // fabricate pod data); on a machine with a real cluster it should
    // actually work end-to-end.
    const code = main(['-n', 'default']);
    if (code === 0) {
      expect(logSpy.mock.calls.join('\n')).toContain('Whyfail report');
    } else {
      expect(code).toBe(1);
      const err = errorSpy.mock.calls.join('\n');
      expect(err).toContain('--from-file');
    }
  });
});

describe('built CLI binary (dist/cli.js) end-to-end smoke test', () => {
  it('runs as a real executable script and prints a report for --from-file input', () => {
    const distPath = path.join(__dirname, '..', 'dist', 'cli.js');
    const output = execFileSync(
      process.execPath,
      [distPath, '--from-file', fixture('imagepull-auth', 'pods.json'), fixture('imagepull-auth', 'events.json')],
      { encoding: 'utf-8' },
    );
    expect(output).toContain('internal-tool');
    expect(output).toContain("can't authenticate");
  });
});
