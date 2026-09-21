import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { blockers, markdown, totals } from '../../scripts/advisory-report.mjs';

const spec = (title: string, status: string, line = 5, tags: string[] = []) => ({
  title,
  file: 'memory.spec.ts',
  line,
  tags,
  tests: [{ projectName: 'webgpu', status, annotations: [], results: [{ status }] }],
});
const rendered = (status = 'expected') => spec('an empty scene renders', status, 3, ['adapter']);
const document = (specs: unknown[], errors: Array<{ message: string }> = []) => ({
  suites: [{ title: 'memory.spec.ts', specs, suites: [] }],
  errors,
});

describe('advisory report', () => {
  it('counts passed, failed, flaky and skipped tests and names the failed ones', () => {
    const report = document([
      spec('a', 'expected'),
      spec('b', 'unexpected', 40),
      spec('c', 'skipped'),
      spec('d', 'flaky'),
      spec('e', 'unexpected', 80),
    ]);
    expect(totals(report, 'adapter')).toMatchObject({
      passed: 1,
      failed: 2,
      flaky: 1,
      skipped: 1,
      failures: ['memory.spec.ts:40 b', 'memory.spec.ts:80 e'],
    });
  });

  it('lets failed tests through when the adapter check rendered and the run had no error of its own', () => {
    const t = totals(document([rendered(), spec('b', 'unexpected', 40)]), 'adapter');
    expect(blockers(t)).toEqual([]);
    expect(blockers(totals(document([rendered('flaky')]), 'adapter'))).toEqual([]);
  });

  it('blocks when the adapter check failed although a test that needs no GPU passed', () => {
    const report = document([spec('schema prints', 'expected'), rendered('unexpected')]);
    expect(blockers(totals(report, 'adapter'))).toEqual([
      'the @adapter check did not pass: memory.spec.ts:3 an empty scene renders (unexpected)',
    ]);
  });

  it('blocks when the adapter check was skipped or never ran', () => {
    expect(blockers(totals(document([spec('a', 'expected'), rendered('skipped')]), 'adapter'))).toEqual([
      'the @adapter check did not pass: memory.spec.ts:3 an empty scene renders (skipped)',
    ]);
    expect(blockers(totals(document([spec('a', 'expected')]), 'adapter'))).toEqual([
      'no test tagged @adapter ran, so nothing shows that the adapter initialized and rendered',
    ]);
  });

  it('blocks on an error of the run itself, such as a failed global teardown', () => {
    const report = document([rendered()], [{ message: 'Error: global teardown failed\n    at teardown.mjs:1:40' }]);
    const t = totals(report, 'adapter');
    expect(t.failed).toBe(0);
    expect(blockers(t)).toEqual(['the run itself failed: Error: global teardown failed']);
  });

  it('writes the counts, every failed test and every blocking reason under the name of the leg', () => {
    const t = totals(document([spec('a', 'expected'), spec('b', 'unexpected', 40)]), 'adapter');
    const text = markdown('corpus webgpu', t, blockers(t));
    expect(text).toContain('### corpus webgpu (advisory)');
    expect(text).toContain('1 failed, 0 flaky, 0 skipped, 1 passed');
    expect(text).toContain('- memory.spec.ts:40 b');
    expect(text).toContain('Blocking, not advisory:');
    expect(text).toContain('- no test tagged @adapter ran');
  });

  it('says that an advisory leg proves nothing about native WebGPU', () => {
    const t = totals(document([rendered()]), 'adapter');
    expect(markdown('corpus webgpu', t, [])).toContain('not a native WebGPU adapter');
    expect(markdown('corpus webgpu', t, [])).not.toContain('Blocking');
  });
});

/**
 * The script as the workflow calls it: it runs the test command itself and judges the report whatever that command
 * returned. The stand-in command writes `report` (or nothing) to the report path and exits with `status`.
 */
describe('advisory report around a test command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-advisory-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const reportPath = join(dir, 'run.json');

  const judge = (report: unknown, status: number | 'SIGKILL') => {
    const write = report
      ? `require('fs').writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(report))});`
      : '';
    const end = status === 'SIGKILL' ? `process.kill(process.pid, 'SIGKILL')` : `process.exit(${status})`;
    const args = ['scripts/advisory-report.mjs', reportPath, 'corpus webgpu', 'adapter', '--'];
    return spawnSync(process.execPath, [...args, process.execPath, '-e', write + end], { encoding: 'utf8' });
  };

  it('blocks a skipped adapter check although the test command itself exited 0', () => {
    const run = judge(document([spec('schema prints', 'expected'), rendered('skipped')]), 0);
    expect(run.stdout).toContain('::error::corpus webgpu: the @adapter check did not pass');
    expect(run.status).toBe(1);
  });

  it('passes a clean run and a run whose only failures are ordinary tests', () => {
    const clean = judge(document([rendered()]), 0);
    expect(clean.stdout).not.toContain('::warning::');
    expect(clean.status).toBe(0);
    const failed = judge(document([rendered(), spec('b', 'unexpected', 40)]), 1);
    expect(failed.stdout).toContain('::warning::corpus webgpu: 1 failed');
    expect(failed.status).toBe(0);
  });

  it('blocks a test command that was killed or exited outside 0 and 1, whatever its report says', () => {
    const report = document([rendered(), spec('b', 'unexpected', 40)]);
    expect(judge(report, 'SIGKILL').stdout).toContain('the test command ended abnormally (SIGKILL)');
    expect(judge(report, 'SIGKILL').status).toBe(1);
    expect(judge(report, 130).stdout).toContain('the test command ended abnormally (exit 130)');
    expect(judge(report, 130).status).toBe(1);
  });

  it('blocks an exit of 1 that no failed test and no error of the run accounts for', () => {
    const run = judge(document([rendered()]), 1);
    expect(run.stdout).toContain('the test command exited 1, but its report shows no failed test and no error');
    expect(run.status).toBe(1);
  });

  it('blocks a test command that wrote no report, and never reads one left from an earlier run', () => {
    writeFileSync(reportPath, JSON.stringify(document([rendered()])));
    const run = judge(null, 0);
    expect(run.stdout).toContain('the test command wrote no report');
    expect(run.status).toBe(1);
  });
});

describe('the corpus workflow', () => {
  it('hands its advisory leg to the script, which judges the report after every run', () => {
    const lines = readFileSync('.github/workflows/assets.yml', 'utf8')
      .split('\n')
      .filter((line) => line.includes('advisory-report.mjs') && !line.trim().startsWith('#'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ adapter -- "\$\{tests\[@\]\}"$/);
    expect(lines[0]).not.toContain('||');
  });
});
