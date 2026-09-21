// node scripts/temporal-report.mjs <list.json> <run.json> [out.md]: which temporal tests ran, which were skipped and
// why, which the run never selected, and where a failed one wrote its frames. Both inputs are Playwright JSON reports:
// the listing from `--list --reporter=json`, the run from `--reporter=json`.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATUS = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };

function testsOf(document) {
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs)
      for (const test of spec.tests) tests.push({ title: spec.title, file: spec.file, line: spec.line, ...test });
    // A suite with no nested describe has no `suites` key at all.
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of document.suites) walk(suite);
  return tests;
}

const keyOf = (test) => `${test.file}:${test.line} ${test.title} [${test.projectName}]`;

function detailsOf(test) {
  const described = (type) => test.annotations.filter((a) => a.type === type).map((a) => a.description);
  return [
    ...described('skip'),
    ...described('pixel-checks').map((d) => `pixel checks ${d}`),
    ...described('temporal-artifacts').map((d) => `frames: ${d}`),
  ];
}

/** One row per listed test and project. A listed test the run does not contain was excluded by its selection. */
export function summarize(listed, report) {
  const ran = new Map(testsOf(report).map((test) => [keyOf(test), test]));
  return testsOf(listed).map((test) => {
    const found = ran.get(keyOf(test));
    return {
      title: test.title,
      file: test.file,
      project: test.projectName,
      status: found ? STATUS[found.status] : 'excluded',
      details: found ? detailsOf(found) : [],
    };
  });
}

export function markdown(rows) {
  const lines = ['### Temporal tests', '', '| test | project | status | detail |', '|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.title} | ${r.project} | ${r.status} | ${r.details.join('; ')} |`);
  for (const project of new Set(rows.map((r) => r.project))) {
    const own = rows.filter((r) => r.project === project);
    if (own.every((r) => r.status === 'skipped'))
      lines.push('', `${project}: every temporal test was skipped, so no pixels were checked on this adapter.`);
  }
  const excluded = rows.filter((r) => r.status === 'excluded').length;
  if (excluded > 0) lines.push('', `${excluded} listed temporal test(s) were not selected by this run.`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [listPath, runPath, outPath] = process.argv.slice(2);
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const text = markdown(summarize(read(listPath), read(runPath)));
  console.log(text);
  if (outPath) writeFileSync(outPath, text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
