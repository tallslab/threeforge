export interface TemporalRow {
  title: string;
  file: string;
  project: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped' | 'excluded';
  details: string[];
}
/** Both arguments are Playwright JSON reports: the `--list` one and the run's. */
export function summarize(listed: unknown, report: unknown): TemporalRow[];
export function markdown(rows: TemporalRow[]): string;
