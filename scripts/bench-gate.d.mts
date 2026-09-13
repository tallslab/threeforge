export interface BenchMetrics {
  sceneSubmissions: number;
  gpuDraws: number;
  triangles: number;
  programs: number;
  overdrawOpaque: number;
  overdrawTransparent: number;
  skinnedVertices: number;
  shadowCasters: number;
  shadowTexels: number;
  textureBytes: number;
  geometryBytes: number;
  renderTargetBytes: number;
  renderMs: number;
  frameMs: number;
  unattributed: number;
}
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
export function compare(baseline: BenchFile, result: BenchFile, options: { gateTiming: boolean; tolerance: number }): { rows: CompareRow[]; failures: string[] };
export function table(result: BenchFile): string;
export function resultPath(backend: string): string;
export function baselinePath(backend: string): string;
