// pnpm bench:baseline [backend]: promote the last results to the committed baseline and refresh docs/bench.md.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { baselinePath, resultPath } from './bench-gate.mjs';

const backends = process.argv[2] ? [process.argv[2]] : ['webgl2', 'webgpu'];
for (const backend of backends) {
  if (!existsSync(resultPath(backend))) {
    console.error(`no results for ${backend}; run pnpm bench ${backend} first`);
    process.exit(2);
  }
  copyFileSync(resultPath(backend), baselinePath(backend));
  console.log(`baseline ${backend} <- ${resultPath(backend)}`);
}
spawnSync('node', ['scripts/bench-table.mjs'], { stdio: 'inherit' });
