// pnpm bench [backend]: run the benchmark suite on one or both backends, then gate against the baselines.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resultPath } from './bench-gate.mjs';

const backends = process.argv[2] ? [process.argv[2]] : ['webgl2', 'webgpu'];
let failed = false;
for (const backend of backends) {
  rmSync(resultPath(backend), { force: true });
  const run = spawnSync('pnpm', ['exec', 'playwright', 'test', 'test/e2e/bench.spec.ts', `--project=${backend}`], {
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`bench ${backend}: the Playwright run failed`);
    failed = true;
  }
  const gate = spawnSync('node', ['scripts/bench-gate.mjs', backend], { stdio: 'inherit' });
  if (gate.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
