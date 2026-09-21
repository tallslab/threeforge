export interface AdvisoryTotals {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  /** `file:line title [device ...]` of every failed test: whether its page still had its WebGPU device. */
  failures: string[];
  /** What the bare-canvas control measured on this adapter. */
  control: string[];
  /** First line of every error of the run itself, outside any test. */
  errors: string[];
  /** The tests carrying the tag that must pass whatever else failed. */
  required: { tag: string; tests: Array<{ name: string; status: string }> };
}
/** `report` is a Playwright JSON report. */
export function totals(report: unknown, tag: string): AdvisoryTotals;
/** `ended`: the test command's exit status or signal name; left out when an existing report is judged. */
export function blockers(totals: AdvisoryTotals, ended?: number | string): string[];
export function markdown(leg: string, totals: AdvisoryTotals, blocking: string[]): string;
