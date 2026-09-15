# Changelog

## Unreleased

- `analyze`'s harness page now disposes its PMREM environment generator, `RoomEnvironment` and Draco/KTX2 loaders after use; every `analyze` document previously carried a false `unreferenced-resources` hint (13 geometries, 4 textures) even for a single skinned mesh like the Fox.
- `analyze` and `optimize` now exit 3 promptly when Chromium cannot launch; before, the exit-3 message printed and the process never exited because the static server stayed open.
- `analyze`, `inspect` and `optimize` bound every `page.evaluate` by `--timeout` and exit 4 with `page: <step> timed out after <ms> ms`; a hook whose `frameAsync` never settled used to hang past `--timeout`.
- The CLI closes its static server and browser on every path, newest first, each close bounded to 5 s; the first error is reported. A finished command (all but `mcp`) exits at most 5 s after flushing its output even if a handle lingers.
- `window.__threeforge.frameAsync()` rejects when the render throws; it used to stay pending forever.
- Programmatic `analyzeAsset`, `analyzeAssetWithShots`, `inspectApp` and `optimizeAsset` take an optional trailing `deps` (`{ launch, serve, appDir }`, type `CliDeps`).
- The static server (`analyze`'s harness/asset host) no longer crashes the process on a malformed request URL, such as a texture named `100%.jpg`: a request whose path fails to decode now falls back to the literal, undecoded path when it names a real file inside the root, and answers 400 otherwise. It also compares real paths (`realpathSync`), so a symlink inside the root that resolves outside it now answers 403 instead of being served, and any other unexpected error in a request answers 500 instead of taking the server down.
- The CLI parser is declarative (`COMMAND_SPECS` in `src/cli/args.ts`). Boolean flags no longer swallow the next argument (`analyze --json scene.glb`, `inspect --compile <url>` and `optimize --simplify scene.glb` now parse), `--` ends the flags, and the usage text plus the AGENTS.md command and flag tables are generated from the specs.
- `RANGES` and `validateInput(command, input)` in `src/cli/args.ts` hold the input bounds and cross-field rules for the CLI (and the MCP server next).
- `inspect` still compiles by default; the docs now show `[--no-compile]` instead of an opt-in `[--compile]` (still accepted). `--timeout`, `--headed`, `--simplify-error`, `--texture-quality` and `decoders` are documented.
- With `--json`, the document is written to stdout before the human summary is built, so a summary that throws no longer loses the JSON.
- Inputs that now exit 2 (usage error, nothing on stdout):

| input | before | now |
|---|---|---|
| unknown flag (`explain untagged --jsonn`) | ignored, exit 0 | exit 2 with `did you mean --json?` |
| a flag of another command (`inspect <url> --tier desktop`, `inspect <url> --bake`, `decoders <dir> --json`) | ignored | exit 2, naming the commands that take it |
| `--no-<flag>` of a flag without a negation (`--no-json`) | ignored | exit 2 |
| single-dash flag (`analyze a.glb -json`) | taken as a positional, then ignored | exit 2 with the `--json` suggestion |
| a flag before the command (`threeforge --frames 5 analyze a.glb`) | parsed | exit 2 |
| extra positional (`analyze a.glb b.glb`, `mcp serve`, `schema snapshot analyze`) | ignored | exit 2 |
| `explain <code> --all` | printed every remedy | exit 2 |
| `help <unknown command>` | printed the help | exit 2 |
| value on a boolean flag (`--json=yes`, `--no-compile=1`) | the flag was set | exit 2 |
| flag given twice or with its negation (`--frames 5 --frames 6`, `--compile --no-compile`) | the last value won; `--no-<flag>` always won | exit 2 |
| `--frames 0`, `--frames 2.5`, `--frames=` | clamped to 1, rounded | exit 2 (an integer ≥ 1) |
| `--timeout` below 1000, fractional, or above 2147483647 | accepted (`0` disabled Playwright's timeout; above 2^31 - 1 a Node timer fires at once) | exit 2 |
| `--budget 1.5`, `--budget=` | accepted (the empty value as 0) | exit 2 (an integer ≥ 0) |
| `--views` fractional or above 64 | rounded, accepted | exit 2 (an integer from 0 to 64) |
| `--texture-size` 0, fractional or above 16384 | accepted (0 meant no resize), rounded | exit 2 (an integer from 1 to 16384) |
| `--texture-quality` 0, above 100 or fractional | passed to sharp | exit 2 (an integer from 1 to 100) |
| `--parity` above 100 | accepted | exit 2 (0 to 100) |
| `--simplify-error` above 1 | accepted | exit 2 (0 to 1) |
| malformed numbers (`--frames 0x10`, `--frames ''`) | `0x10` read as 16, empty as 0 | exit 2 |
| `--out=` (empty) | resolved to the working directory | exit 2 |
| `optimize --budget N --no-verify` | the budget was silently not judged | exit 2: the budget is judged on the verified render |

- A frame snapshot's `byReason[reason].top` names, and a hint's `message` and `objects`, are capped at 120 and 300 characters (`src/ledger/text.ts`): a single long or malicious node/material/light name can no longer balloon an `analyze`/`inspect`/`optimize` document or the hint it appears in.
- Every `page.evaluate` result the CLI reads (harness state, `compile()`, and `inspect`'s frame measurements) is cleaned before use: ANSI escapes, control characters and bidi/zero-width formatting characters are stripped, and strings, arrays and nesting depth are capped (`sanitizeDeep`, `src/cli/untrusted.ts`) — `inspect`'s target is any page, not only one using threeforge's own caps.
- CLI progress lines and the human summary (stderr with `--json`, stdout otherwise) are cleaned the same way, line by line; page errors keep only the first 5, each capped at 300 characters, with a `(+N more)` suffix for the rest.
- The MCP tools `analyze_asset`, `inspect_app` and `optimize_asset` now return a second `content` text block after the JSON, marking any name, hint text, `env.gpu` or page error in it as data from the asset or page, not instructions; `explain_hint` is unchanged. The same paragraph is in AGENTS.md.

## 0.8.0 — 2026-09-14

- `createLoader(renderer, options)`: a GLTFLoader with Draco, KTX2 (formats detected on the renderer) and meshopt in one call; `disposeLoader`; `threeforge decoders <dir>` copies three's decoder files.
- `ResourceTracker` (reference-counted release across owners, registry materials untouched), `collectResources`, `unreferencedResources`.
- `Streamer`: chunk residency by camera distance over `world.chunks()` and uncompiled static tiles; unloaded chunks free their GPU copies.
- Ledger: `memory.unreferenced` (renderer-held resources the scene no longer reaches), `memory.chunks`; budget `geometryBytes`; hints `geometry-bytes`, `unreferenced-resources`. Zen benchmark rebuilt on 64 textured ground tiles with fog and streamed in the optimized variant (baselines promoted). `docs/memory.md`.

## 0.7.0 — 2026-09-14

- `bakeAnimationTexture`: every clip of a skinned prototype baked to one float texture of bone matrices (multiple skeletons side by side), transform and pose restored.
- `AnimatedInstances`: crowds as one instanced draw per part with a per-instance clip, time offset and speed, animated on the GPU from the texture; instance matrices in one `InstancedInterleavedBuffer`.
- Ledger: reason `vat-instanced`, `skinning.vatInstances` / `vatVertices`; budget `bones`; hints `bones-over-budget`, `skinned-crowd`. Crowd benchmark optimized with animated instances (baselines promoted: 401 → 17 submissions, skinned vertices 271 k → 0). `docs/skinning.md`.

## 0.6.0 — 2026-09-14

- `DayNight`: sun, gradient sky dome, hemisphere light, fog and background from the hour of day; the shadow map re-renders only when the sun moved `everyDegrees`.
- `ShadowBudget`: shadow maps fitted to the tier's texel budget, point shadows off on phones, an off-switch by tier, `freeze(light)` for static shadows.
- Bake carries and welds every UV set (lightmaps survive). Bench metric `shadowPassesPerFrame` (baselines promoted: day/night 1 → 0.5).

## 0.5.0 — 2026-09-14

- Freezing at compile (`freeze`, default on): unbatched statics and all-static ancestors get `matrixAutoUpdate = false`; `world.markDirty(object)` moves a frozen static and updates its batch, instance or bake; `world.onDirty(listener)`.
- `RenderScheduler`: render on change (invalidate, camera, watched objects, mixers, resize, keep-alive) with `stats`, `lastReason` and `js.skipped` in the ledger.
- Ledger: `js.hiddenOriginals`, `js.skipped`; budget `objects`; hints `js-objects`, `detach-originals`; bench metrics `objects`, `autoUpdatedMatrices` (baselines promoted).

## 0.4.0 — 2026-09-14

- Sprite batching in `World.compile()`: sprites sharing a material become one instanced `SpriteNodeMaterial` draw synced from the originals every frame (`sprites`, `spriteThreshold` options; reason `sprite-batch`). Lake benchmark: 3 548 → 7 submissions.
- `ParticleBudget` (caps points and sprite batches to the tier's particle budget, scales point sizes) and `ResolutionScaler` (dynamic pixel ratio on the median frame time).
- Ledger: `overdraw.particles`, `overdraw.pixels`; budget `particles`; hints `particles-over-budget`, `sprites-unbatched`; bench metrics `particles`, `fillMegapixels`. `docs/vfx.md` conventions.
- Device bench page (`bench-app/`, deployed by the `pages` workflow): runs the eight benchmark scenes on any device, shows the `pnpm bench` metrics plus real frame times, and submits the result as a GitHub issue; the `bench-results` workflow validates it, stores it under `bench/devices/` and regenerates `docs/devices.md`. Not part of the npm package.

## 0.3.0 — 2026-09-14

- `threeforge optimize <file>`: glTF-Transform build-time pipeline with three presets (`safe` never changes a pixel; `balanced` adds quantize and WebP textures; `aggressive` adds simplify), per-step reports, load-time requirements (`requires`), verification by rendering the original and the optimized file through the harness and compiling both, and a verdict that fails on lost pixels, clips, skins or morph targets. `optimize_asset` on the MCP server, `schema optimize`, `optimizeAsset` in `threeforge/cli`.
- `@gltf-transform/{core,functions,extensions}` are dependencies; `sharp` (texture compression) and `draco3dgltf` (Draco inputs) are optional peers.

## 0.2.0 — 2026-09-13

- Ledger v2: six cost sections (draw calls, measured overdraw, skinning, lighting, js, memory), device tiers, budgets and hints.
- Benchmark suite: eight scenes with naive and optimized variants, `pnpm bench` regression gate, committed baselines.
- Bake: `World({ bake })` merges each finished static group into one mesh, removing seams and duplicates (and, opt-in, buried faces), welding matching vertices; rebake on hide, `bakeDebug()`, CLI `--bake --views N` multi-view parity.
- For AI agents: `npx threeforge analyze|inspect|explain|schema|mcp`, `exposeToAgents()` hook, `AGENTS.md`, `llms.txt`.
- Warm-up renders a scissored frame instead of `compileAsync` (three r186 mis-compiles two-pass materials).

## 0.1.0

- Material registry, draw-call ledger, static batching, auto-instancing, spatial chunks, BVH culling, LOD, occlusion proxies, character assembler; verified on 104 public glTF assets on both backends.
