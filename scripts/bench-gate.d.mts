// The gate reads whatever `metricsOf` produced, so the type is that one rather than a copy: this declaration had
// drifted, missing particles, fillMegapixels, objects, autoUpdatedMatrices and shadowPassesPerFrame.
import type { BenchMetrics } from '../test/app/benchMetrics.js';

export type { BenchMetrics };
export interface BenchFile {
  schemaVersion: number;
  env: Record<string, unknown>;
  scenes: Record<string, { naive: BenchMetrics; optimized: BenchMetrics }>;
}
export interface CompareRow {
  scene: string;
  variant: 'naive' | 'optimized';
  metric: string;
  before: number | undefined;
  after: number | undefined;
  ratio: number | null;
}
export const DETERMINISTIC: string[];
export const TIMING: string[];
export function compare(
  baseline: BenchFile,
  result: BenchFile,
  options: { gateTiming: boolean; tolerance: number },
): { rows: CompareRow[]; failures: string[] };
export function table(result: BenchFile): string;
