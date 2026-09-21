# Benchmark baselines

Generated from `bench/baselines/*.json` by `pnpm bench:table`, which `pnpm bench:baseline` runs after promoting results; edit `scripts/bench-table.mjs`, not this file. Each row is one scene, naive assembly then optimized through threeforge. Timing columns are medians of 60 frames on the machine that produced the baseline and are gated only with `FORGE_GPU=native`.

### webgl2

ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver) · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | particles | fill MPix | objects / auto-matrices | skinned verts | shadow texels | shadow passes/frame | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 29 | 36.7k → 36.7k | 0.71 / 0.01 → 0.71 / 0.01 | 0 → 0 | 0.34 → 0.34 | 310 / 310 → 325 / 34 | 158 → 158 | 0 → 0 | 0.00 → 0.00 | 4 → 5 | 1.7 → 0.9 | 18.1 → 16.9 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 105.1k | 0.84 / 0.00 → 0.79 / 0.00 | 0 → 0 | 0.40 → 0.38 | 7.0k / 7.0k → 7.0k / 15 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 15.9 → 2.1 | 121.9 → 106.2 |
| crowd | 401 → 17 (23.6×) | 402 → 18 | 151.6k → 151.6k | 0.86 / 0.00 → 0.86 / 0.00 | 0 → 0 | 0.41 → 0.41 | 2.2k / 2.2k → 19 / 18 | 271.0k → 0 | 0 → 0 | 0.00 → 0.00 | 15 → 18 | 3.3 → 0.6 | 35.4 → 32.9 |
| bossfight | 2780 → 370 (7.5×) | 2787 → 294 | 161.7k → 175.7k | 1.04 / 0.64 → 1.04 / 0.64 | 7.6k → 7.6k | 0.81 → 0.81 | 1.5k / 1.5k → 1.5k / 442 | 16.4k → 16.4k | 3.67M → 3.67M | 3.00 → 3.00 | 110 → 110 | 16.1 → 8.6 | 123.1 → 139.2 |
| lake | 3548 → 7 (506.9×) | 3549 → 8 | 8.0k → 8.2k | 0.63 / 0.70 → 0.63 / 0.70 | 1.8k → 1.8k | 0.64 → 0.64 | 2.0k / 2.0k → 2.0k / 2.0k | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 11 → 11 | 16.1 → 1.5 | 90.5 → 76.0 |
| daynight | 605 → 28 (21.6×) | 606 → 29 | 73.4k → 36.7k | 0.71 / 0.01 → 0.71 / 0.01 | 0 → 0 | 0.34 → 0.34 | 310 / 310 → 325 / 34 | 158 → 158 | 4.19M → 2.10M | 1.00 → 0.50 | 20 → 21 | 3.2 → 1.3 | 33.3 → 28.6 |
| zen | 3540 → 88 (40.2×) | 3541 → 62 | 63.2k → 60.9k | 0.64 / 0.00 → 0.64 / 0.00 | 0 → 0 | 0.31 → 0.31 | 50.1k / 50.1k → 226 / 194 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 91 → 47 | 26.8 → 1.1 | 100.0 → 73.3 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.24 / 0.00 → 0.24 / 0.00 | 0 → 0 | 0.09 → 0.09 | 10 / 10 → 6 / 6 | 326 → 326 | 0 → 0 | 0.00 → 0.00 | 3 → 3 | 0.4 → 0.3 | 16.7 → 16.6 |

### webgpu

apple metal-3 · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | particles | fill MPix | objects / auto-matrices | skinned verts | shadow texels | shadow passes/frame | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 304 | 36.7k → 36.7k | 0.71 / 0.01 → 0.71 / 0.01 | 0 → 0 | 0.34 → 0.34 | 310 / 310 → 325 / 34 | 158 → 158 | 0 → 0 | 0.00 → 0.00 | 4 → 5 | 1.8 → 1.3 | 16.6 → 16.8 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 105.1k | 0.84 / 0.00 → 0.79 / 0.00 | 0 → 0 | 0.40 → 0.38 | 7.0k / 7.0k → 7.0k / 15 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 15.9 → 2.1 | 17.0 → 16.7 |
| crowd | 401 → 17 (23.6×) | 402 → 18 | 151.6k → 151.6k | 0.86 / 0.00 → 0.86 / 0.00 | 0 → 0 | 0.41 → 0.41 | 2.2k / 2.2k → 19 / 18 | 271.0k → 0 | 0 → 0 | 0.00 → 0.00 | 15 → 18 | 3.2 → 0.8 | 16.6 → 16.7 |
| bossfight | 2780 → 370 (7.5×) | 2787 → 1082 | 161.7k → 175.7k | 1.04 / 0.63 → 1.04 / 0.63 | 7.6k → 7.6k | 0.80 → 0.80 | 1.5k / 1.5k → 1.5k / 442 | 16.4k → 16.4k | 3.67M → 3.67M | 3.00 → 3.00 | 110 → 110 | 14.8 → 8.9 | 16.7 → 16.5 |
| lake | 3548 → 7 (506.9×) | 3549 → 34 | 8.0k → 8.2k | 0.63 / 0.69 → 0.63 / 0.69 | 1.8k → 1.8k | 0.63 → 0.63 | 2.0k / 2.0k → 2.0k / 2.0k | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 11 → 11 | 15.7 → 1.9 | 16.5 → 16.6 |
| daynight | 605 → 28 (21.6×) | 606 → 304 | 73.4k → 36.7k | 0.71 / 0.01 → 0.71 / 0.01 | 0 → 0 | 0.34 → 0.34 | 310 / 310 → 325 / 34 | 158 → 158 | 4.19M → 2.10M | 1.00 → 0.50 | 20 → 21 | 2.9 → 1.4 | 16.7 → 16.6 |
| zen | 3540 → 88 (40.2×) | 3541 → 62 | 63.2k → 60.9k | 0.64 / 0.00 → 0.64 / 0.00 | 0 → 0 | 0.31 → 0.31 | 50.1k / 50.1k → 226 / 194 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 91 → 47 | 26.6 → 1.2 | 27.1 → 16.7 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.24 / 0.00 → 0.24 / 0.00 | 0 → 0 | 0.09 → 0.09 | 10 / 10 → 6 / 6 | 326 → 326 | 0 → 0 | 0.00 → 0.00 | 3 → 3 | 0.5 → 0.5 | 16.7 → 16.6 |

## How the numbers are measured

Each variant runs 10 warm-up frames, then 60 measured frames, then one `measureOverdraw()` and a final frame. The columns do not all come from the same window, and two gated metrics are not columns at all:

- **`programs`** (gated, not a column) is read from the last measured frame, *before* `measureOverdraw()` runs. The overdraw count materials are real materials: their shader stages count in `renderer.info.memory.programs`, and three releases a stage only once its `usedTimes` reaches 0 (`Pipelines._releaseProgram`), so they are still counted in the final frame. Reading the metric before the measurement keeps it a count of the shaders the *app* compiled, which is why it stays in the gate list. Read after the measurement, as it was, any change to `src/ledger/overdraw.ts` moved a gated number that has nothing to do with the scene. Note what the number *is*: `renderer.info.memory.programs` is a cumulative count of the shader programs the renderer currently holds, not a per-frame cost. It does not rise and fall with what a frame draws, so read it as how many variants the scene made three build, not as work done each frame. Only the CI runner's capture point is enforced: `test/e2e/bench.spec.ts` asserts the recorded value sits at or below the post-measurement frame's, and strictly below it on `zen`. The device bench page captures the same metric at the same point but is guarded only by a comment (`bench-app/runner.ts`), because the page exposes no post-measurement frame to compare against; pinning it there needs a page change first.
- **`shadow texels`** is the mean over the 60 measured frames, so a frozen or quantized map counts on the share of them it renders on. `shadowCasters` (gated, not a column) and every memory column instead come from the single final frame. The two windows differ; that predates these tables.
- **`textureBytes`** applies a ×1.333 generated-mip factor only to textures that ask for one. The naive variants of `village`, `forest`, `lake` and `rpg` carry no such factor at all: their textures are procedural `DataTexture`s, whose `generateMipmaps` is `false` by three's default (`rpg`'s 320 bytes are five 4×4 RGBA gear textures, `lake`'s 1024 the 16×16 raindrop streak, and `forest` has no texture to count). A change to the mip factor therefore cannot move those four numbers, and their absence from such a diff is the expected result rather than a bug.
