export interface TemporalRow {
  title: string;
  file: string;
  project: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped' | 'excluded';
  details: string[];
}
/** Every test of a Playwright JSON report, one entry per project, with its spec's title, file, line and tags. */
export function testsOf(
  report: unknown,
): Array<{ title: string; file: string; line: number; tags: string[]; projectName: string; status: string }>;
/** Both arguments are Playwright JSON reports: the `--list` one and the run's. */
export function summarize(listed: unknown, report: unknown): TemporalRow[];
export function markdown(rows: TemporalRow[]): string;
