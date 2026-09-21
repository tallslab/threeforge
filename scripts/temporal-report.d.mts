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
/** The descriptions of a test's annotations of one type. */
export function described(test: { annotations: Array<{ type: string; description?: string }> }, type: string): string[];
/** Both arguments are Playwright JSON reports: the `--list` one and the run's. */
export function summarize(listed: unknown, report: unknown): TemporalRow[];
export function markdown(rows: TemporalRow[]): string;
