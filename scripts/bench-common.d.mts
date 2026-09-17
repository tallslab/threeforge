import type { BenchFile } from './bench-gate.d.mts';

export const BACKENDS: readonly string[];
/** The backend named as the first argument, or both. */
export function backendsFromArgv(argv?: readonly string[]): string[];
export function resultPath(backend: string): string;
export function baselinePath(backend: string): string;
/** The committed baseline of `backend`, parsed, or `null` when none is committed. */
export function readBaseline(backend: string): BenchFile | null;
