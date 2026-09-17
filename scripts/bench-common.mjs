// What bench-run, bench-baseline, bench-gate and bench-table share: the two backends and where a backend's results and
// committed baseline live.
import { existsSync, readFileSync } from 'node:fs';

export const BACKENDS = ['webgl2', 'webgpu'];

/** The backend named as the first argument, or both. */
export function backendsFromArgv(argv = process.argv) {
  return argv[2] ? [argv[2]] : BACKENDS;
}

export function resultPath(backend) {
  return `bench/results/local.${backend}.json`;
}

export function baselinePath(backend) {
  return `bench/baselines/${backend}.json`;
}

/** The committed baseline of `backend`, parsed, or `null` when none is committed. */
export function readBaseline(backend) {
  const path = baselinePath(backend);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
