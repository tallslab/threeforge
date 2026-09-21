// node scripts/advisory-report.mjs <run.json> <leg> <tag> [-- <test command>]: what a leg really did when its failed
// tests do not fail the job. With a command it runs that first and judges the report whatever the command returned:
// Playwright exits 0 with the <tag> check skipped, so judging only after a failure would miss that. Prints the counts
// as a workflow warning and lists every failed test in the run summary. These stay blocking and exit 1: an error of
// the run itself (Playwright's top-level `errors`: a global setup or teardown, a timeout of the whole run); the check
// tagged <tag> not passing (a count of passed tests would not do: the CLI's help and schema tests need no GPU); a
// command that was killed, exited outside 0 and 1, exited 1 with nothing in the report to account for it, or wrote
// no report.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testsOf } from './temporal-report.mjs';

const nameOf = (test) => `${test.file}:${test.line} ${test.title}`;

export function totals(report, tag) {
  const tests = testsOf(report);
  const count = (status) => tests.filter((test) => test.status === status).length;
  const failures = tests.filter((test) => test.status === 'unexpected').map(nameOf);
  return {
    passed: count('expected'),
    failed: failures.length,
    flaky: count('flaky'),
    skipped: count('skipped'),
    failures,
    errors: report.errors.map((error) => error.message.split('\n')[0]),
    required: {
      tag,
      tests: tests.filter((test) => test.tags.includes(tag)).map((t) => ({ name: nameOf(t), status: t.status })),
    },
  };
}

/**
 * Why the leg fails although its failed tests are advisory; empty when it may pass. `ended` is how the test command
 * ended, an exit status or a signal name, and is left out when an existing report is judged.
 */
export function blockers(t, ended) {
  const { tag, tests } = t.required;
  const reasons = t.errors.map((message) => `the run itself failed: ${message}`);
  if (ended !== undefined && ended !== 0 && ended !== 1)
    reasons.push(`the test command ended abnormally (${typeof ended === 'number' ? `exit ${ended}` : ended})`);
  if (ended === 1 && t.failed === 0 && t.errors.length === 0)
    reasons.push('the test command exited 1, but its report shows no failed test and no error of the run');
  if (tests.length === 0)
    reasons.push(`no test tagged @${tag} ran, so nothing shows that the adapter initialized and rendered`);
  // Flaky is a pass on a retry: the adapter did come up and draw.
  for (const test of tests)
    if (test.status !== 'expected' && test.status !== 'flaky')
      reasons.push(`the @${tag} check did not pass: ${test.name} (${test.status})`);
  return reasons;
}

const countsOf = (t) => `${t.failed} failed, ${t.flaky} flaky, ${t.skipped} skipped, ${t.passed} passed`;

export function markdown(leg, t, blocking) {
  const lines = [
    `### ${leg} (advisory)`,
    '',
    `${countsOf(t)}.`,
    'This adapter is software, not a native WebGPU adapter: a release still needs the native run in docs/release.md.',
    '',
    ...t.failures.map((failure) => `- ${failure}`),
  ];
  if (blocking.length > 0) lines.push('', 'Blocking, not advisory:', '', ...blocking.map((reason) => `- ${reason}`));
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [runPath, leg, tag, separator, ...command] = process.argv.slice(2);
  let ended;
  if (separator === '--') {
    // A report left by an earlier run must not be judged in place of the one this command failed to write.
    rmSync(runPath, { force: true });
    const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    ended = run.signal ?? run.status ?? run.error.code;
  }
  if (!existsSync(runPath)) {
    console.log(`::error::${leg}: the test command wrote no report`);
    process.exit(1);
  }
  const t = totals(JSON.parse(readFileSync(runPath, 'utf8')), tag);
  const blocking = blockers(t, ended);
  const text = markdown(leg, t, blocking);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  if (t.failed > 0) console.log(`::warning::${leg}: ${countsOf(t)} (advisory, see docs/design.md)`);
  for (const reason of blocking) console.log(`::error::${leg}: ${reason}`);
  if (blocking.length > 0) process.exit(1);
}
