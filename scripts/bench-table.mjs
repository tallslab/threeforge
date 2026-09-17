// Renders docs/bench.md from the committed baselines and refreshes the one-line summary docs/threeforge.md quotes
// between its bench markers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BACKENDS, readBaseline } from './bench-common.mjs';
import { table } from './bench-gate.mjs';

const sections = [];
for (const backend of BACKENDS) {
  const b = readBaseline(backend);
  if (!b) continue;
  sections.push(
    `### ${backend}\n\n${b.env?.gpu ?? 'unknown GPU'} · tier ${b.env?.tier ?? '?'} · three ${b.env?.three ?? '?'}\n\n${table(b)}`,
  );
}
const body = sections.length
  ? sections.join('\n\n')
  : '_No baselines yet: run `pnpm bench` then `pnpm bench:baseline`._';
// Notes on what the gated numbers mean. They live here, not in docs/bench.md, because this script rewrites that file
// whole.
const notes = [
  '## How the numbers are measured',
  '',
  'Each variant runs 10 warm-up frames, then 60 measured frames, then one `measureOverdraw()` and a final frame. The columns do not all come from the same window, and two gated metrics are not columns at all:',
  '',
  "- **`programs`** (gated, not a column) is read from the last measured frame, *before* `measureOverdraw()` runs. The overdraw count materials are real materials: their shader stages count in `renderer.info.memory.programs`, and three releases a stage only once its `usedTimes` reaches 0 (`Pipelines._releaseProgram`), so they are still counted in the final frame. Reading the metric before the measurement keeps it a count of the shaders the *app* compiled, which is why it stays in the gate list. Read after the measurement, as it was, any change to `src/ledger/overdraw.ts` moved a gated number that has nothing to do with the scene. Note what the number *is*: `renderer.info.memory.programs` is a cumulative count of the shader programs the renderer currently holds, not a per-frame cost. It does not rise and fall with what a frame draws, so read it as how many variants the scene made three build, not as work done each frame. Only the CI runner's capture point is enforced: `test/e2e/bench.spec.ts` asserts the recorded value sits at or below the post-measurement frame's, and strictly below it on `zen`. The device bench page captures the same metric at the same point but is guarded only by a comment (`bench-app/runner.ts`), because the page exposes no post-measurement frame to compare against; pinning it there needs a page change first.",
  '- **`shadow texels`** is the mean over the 60 measured frames, so a frozen or quantized map counts on the share of them it renders on. `shadowCasters` (gated, not a column) and every memory column instead come from the single final frame. The two windows differ; that predates these tables.',
  "- **`textureBytes`** applies a ×1.333 generated-mip factor only to textures that ask for one. The naive variants of `village`, `forest`, `lake` and `rpg` carry no such factor at all: their textures are procedural `DataTexture`s, whose `generateMipmaps` is `false` by three's default (`rpg`'s 320 bytes are five 4×4 RGBA gear textures, `lake`'s 1024 the 16×16 raindrop streak, and `forest` has no texture to count). A change to the mip factor therefore cannot move those four numbers, and their absence from such a diff is the expected result rather than a bug.",
].join('\n');
const doc = `# Benchmark baselines\n\nGenerated from \`bench/baselines/*.json\` by \`pnpm bench:table\`, which \`pnpm bench:baseline\` runs after promoting results; edit \`scripts/bench-table.mjs\`, not this file. Each row is one scene, naive assembly then optimized through threeforge. Timing columns are medians of 60 frames on the machine that produced the baseline and are gated only with \`FORGE_GPU=native\`.\n\n${body}\n\n${notes}\n`;
writeFileSync('docs/bench.md', doc);
/** Replaces whatever sits between the bench markers of `path`; leaves a file carrying no markers alone. */
function splice(path, text) {
  if (!existsSync(path)) return false;
  const source = readFileSync(path, 'utf8');
  const start = '<!-- bench:start -->';
  const end = '<!-- bench:end -->';
  if (!source.includes(start) || !source.includes(end)) return false;
  const before = source.slice(0, source.indexOf(start) + start.length);
  const after = source.slice(source.indexOf(end));
  writeFileSync(path, `${before}\n${text}\n${after}`);
  return true;
}

// docs/threeforge.md quotes the headline submission counts in prose. Generated from the same baselines so it cannot
// drift the way the hand-typed list did: it still read bossfight 424, daynight 55 and zen 125 long after the
// baselines said 370, 28 and 88. Both backends agree on sceneSubmissions, so the first one present wins.
function summaryLine() {
  for (const backend of BACKENDS) {
    const b = readBaseline(backend);
    if (!b) continue;
    const scenes = Object.entries(b.scenes ?? {}).filter(([, v]) => v?.naive && v?.optimized);
    if (scenes.length === 0) continue;
    const parts = scenes.map(([scene, v]) => `${scene} ${v.naive.sceneSubmissions} → ${v.optimized.sceneSubmissions}`);
    return `Current baselines (${backend}, scene submissions naive → optimized): ${parts.join(', ')}.`;
  }
  return '_No baselines yet: run `pnpm bench` then `pnpm bench:baseline`._';
}

splice('docs/threeforge.md', summaryLine());
console.log('docs/bench.md written');
