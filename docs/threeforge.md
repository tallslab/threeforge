# threeforge — the complete reference

This document describes everything threeforge is and does, module by module, and how each part works. Shorter
entry points: [README.md](../README.md) (overview and quick start), [AGENTS.md](../AGENTS.md) (for AI agents),
[docs/bench.md](bench.md) (benchmark baselines), [docs/design.md](design.md) (the history of phases 1–6).

## 1. What it is

threeforge is a **frame-budget compiler and diagnostics layer for three.js games** (three r186, `three/webgpu`
with its WebGL2 fallback). It is not an engine and has no editor. three.js stays the renderer. threeforge does
three things:

1. **Compiles** a naively assembled scene into a cheap one at load time: it merges static meshes into batches or
   baked meshes, instances repeated geometry, culls per instance with a BVH, switches LODs, and keeps the original
   objects editable and reversible.
2. **Measures** every cost category of a frame in one ledger: draw calls by reason, measured overdraw, skinning,
   lighting and shadows, per-frame JavaScript, memory. It reconciles its own count with the renderer's, so a
   non-zero `unattributed` means the model is wrong, never the scene.
3. **Explains** what to fix: per-tier budgets turn into hints with a remedy each, readable by a person on the
   overlay or by an AI agent through JSON, a CLI and an MCP server.

Everything is proven on a fixed benchmark suite of eight scenes and on 104 public glTF assets, on both backends,
with a regression gate that fails the build on a 10 % regression.

Principles: three.js renders; a wrong deletion is visible and a missed one is invisible (so every removal is
conservative, counted and reversible); measurements are real, never estimated where a measurement is possible;
agents get the same data as people, as JSON with exit codes.

## 2. Install and first use

```bash
npm i -D threeforge                          # the library (peer: three >= 0.180)
npm i -D playwright && npx playwright install chromium   # only for the CLI / MCP
```

```ts
import { DrawCallLedger, MaterialRegistry, World, exposeToAgents, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);                     // patches renderObject/render on this renderer instance

tag.static(crate);                           // never moves: batched or baked by compile()
tag.dynamic(player);                         // moves: left alone (or synced into a batch with dynamics: 'batch-sync')

const world = new World(scene, { registry, ledger, policy: 'tagged' });
const report = world.compile({ coordinateSystem: renderer.coordinateSystem });
await world.warmup(renderer, camera);        // build every pipeline now, not on the first visible frame
exposeToAgents({ ledger, world, renderer, scene, camera }); // window.__threeforge for the CLI and agents

renderer.render(scene, camera);
const frame = ledger.frame();                // FrameSnapshot v2: six cost sections + hints
```

```bash
npx threeforge analyze scene.glb --backend webgpu --tier phone-mid --json
npx threeforge inspect http://localhost:5173 --compile --json
```

## 3. Architecture

| Directory | Responsibility |
|---|---|
| `src/tags.ts` | `tag.static(obj)`, `tag.dynamic(obj)`, `tag.of(obj)`; stored in `userData.forge` |
| `src/registry` | `MaterialRegistry`: material keys (program, variant, colour) and canonical sharing |
| `src/ledger` | `DrawCallLedger`, the v2 snapshot, reasons, expected GPU draws, sections (skinning, lighting), memory estimate, measured overdraw, budgets and tiers, hints |
| `src/compiler` | `classify` (rules), `batchStatics` (batches, instancing, bake), `bake` (geometry bake), `culling` (BVH, hooks), `instancing` (compacted InstancedMesh), `geometryCompat`, `World` (compile/decompile/resolve/warmup) |
| `src/lod` | meshoptimizer LOD generation |
| `src/character` | the character assembler (gear merged onto one skeleton, one atlas) |
| `src/overlay` | text formatting of a snapshot and the DOM overlay |
| `src/agent` | `exposeToAgents` (the `window.__threeforge` hook) |
| `src/cli` | the `threeforge` CLI, the MCP server, JSON schemas, hint remedies (node only, optional peers loaded lazily) |
| `cli-app` | the harness page shipped inside the package for `threeforge analyze` |
| `test/app` | the development harness (`pnpm dev`) with every test scene and benchmark scene |
| `test/scenes`, `test/app/scenes` | deterministic scenes (naive, field, forest, character) and the eight benchmark scenes |
| `test/unit`, `test/e2e` | Vitest units (node, fake renderer) and Playwright specs on both backends |
| `bench` | baselines and results of the benchmark suite |
| `scripts` | asset download, bench runner/gate/table, agent docs generator, decoder copy |

Data flow: the app tags meshes → `World.compile()` classifies every mesh, registers materials, groups statics and
builds batches / baked meshes / instanced meshes, hides the originals, installs culling and sync hooks → three.js
renders → the ledger records every `renderObject` call with a reason and rebuilds the snapshot at the end of the
outermost `render()` → the overlay, the CLI, the bench runner and agents read `ledger.frame()`.

## 4. The ledger (`DrawCallLedger`)

### How it hooks in

`ledger.attach(renderer)` replaces three instance methods on the renderer: `renderObject` (called once per render
item after culling and sorting, in every pass, including shadow maps and post-processing), `render` and
`renderAsync` (frame boundaries). The outermost `render()` call is one frame; nested calls are passes of it.
`detach()` restores the originals. Nothing global is patched.

### Passes

Each submission carries a pass id: `main`, `shadow:<light name>` (the camera matches a light's shadow camera),
`override` (a scene with `overrideMaterial`), `fullscreen` (a non-scene root, for example a post-processing quad),
`nested:<render target name>` (a nested render of the main scene, for example a reflector), `scene:<name>` (a
different scene). Renderer-internal work (three's output colour transform quad) is attributed as
`renderer-internal` and excluded from `sceneSubmissions`.

### Reasons and flags

Every submission gets one reason: `batched`, `baked`, `instanced`, `unique-material`, `dynamic`, `skinned`,
`morph`, `transparent`, `multi-material-group`, `untagged`, `unsupported-material`, `renderer-internal`,
`fullscreen-pass`, `occlusion-proxy`, `points`, `sprite`, `line`, `unclassified`, or `excluded:<rule>`. The compiler
annotates objects it left alone (`ledger.annotate(object, reason)`) so the ledger says why. Flags add detail:
`shadow-caster`, `double-sided-transparent`, `custom-hook`, `render-order`, `layers`, `transparent`.

### Reconciliation

For each submission the ledger predicts the GPU draw commands it will issue on this backend: 1 for a mesh, N for a
`BatchedMesh` on WebGPU or on WebGL without `WEBGL_multi_draw` (1 with multi-draw), 0 for an `InstancedMesh` with
`count = 0`, ×2 for double-sided transparent materials that are not `forceSinglePass`. `reportedDrawCalls` is the
change in `renderer.info.render.drawCalls` inside the frame; `unattributed = reportedDrawCalls − gpuDraws` and is
asserted to be 0 in every test. `drawCommands` counts multi-draw ranges individually.

### The snapshot (`ledger.frame()`), schema version 2

```
schemaVersion: 2
env:       three, backend (webgl2|webgpu), multiDraw, tier, gpu, dpr, viewport
totals:    submissions, sceneSubmissions, gpuDraws, reportedDrawCalls, unattributed, programSwitches, programs,
           triangles, instances, instancesDrawn, drawCommands
passes:    [{ id, submissions, gpuDraws }]
byReason:  { reason: { submissions, gpuDraws, top: [first 5 names] } }
programs:  { programHash: { type, description, submissions } }
overdraw:  opaque, transparent (fragments per pixel, measured), transparentSubmissions, measured
skinning:  submissions, vertices, bones, skeletons, maxBones, morphTargets
lighting:  lights { directional, point, spot, hemisphere, ambient, other }, shadowLights, shadowPasses,
           shadowCasters, shadowTexels, shadowSubmissions
js:        renderMs, frameMs, objects, autoUpdatedMatrices
memory:    textures { count, bytes }, geometries { count, bytes }, renderTargets { count, bytes }, estimated: true
hints:     [{ category, severity, code, message, objects }]
items?:    per-submission records with ledger.frame({ items: true })
```

- **overdraw** is measured, not estimated: `ledger.measureOverdraw(scene, camera)` renders the scene twice into a
  1/8-resolution half-float target with an additive count material (no depth test, both faces), once for the opaque
  render list (`renderer.transparent = false`) and once for the transparent list, reads the target back and averages
  the red channel: fragments per pixel. three copies `alphaTest` and `alphaMap` onto override materials, so cutouts
  count only their visible texels. Attribution is paused during the measurement. Call it on demand.
- **skinning** sums the main pass's skinned submissions: vertices, bones per unique skeleton (indexed per frame, no
  uuids in the snapshot), the largest bone count, morph targets.
- **lighting** scans the main scene's visible lights; `shadowTexels` = Σ `mapSize.x · mapSize.y · faces` with 6
  faces for point lights (a cube target); casters are the unique objects in `shadow:*` passes.
- **js**: `renderMs` is the outermost `render()` duration, `frameMs` the median interval between the last 60 outermost
  renders, `objects` and `autoUpdatedMatrices` come from a traversal repeated at most every 60 frames
  (`ledger.rescan()` forces it).
- **memory** estimates bytes: textures `w · h · 4 · bytesPerChannel · (mipmaps ? 4/3 : 1) · (cube ? 6 : 1)`, compressed
  textures Σ mip bytes, geometries Σ attribute and index bytes, render targets from shadow maps and the renderer's
  half-float frame-buffer target. `ledger.measureMemory()` recounts now.
- **hints** are recomputed every frame from the snapshot and the budgets of the environment's tier.

Other methods: `ledger.report()` (text), `ledger.budget({ maxSubmissions })` → `{ pass, actual, max, offenders }`,
`ledger.setEnvironment({ tier, gpu, dpr, viewport })`, `ledger.budgets()`.

### Tiers, budgets and hints

`detectTier({ gpu, deviceMemory, cores, touch, dpr })` returns `desktop` (no touch), `phone-low` (Adreno 1xx–5xx and
60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR, VideoCore, or ≤ 2 GB) or `phone-mid`. Budgets per tier
(`BUDGETS`, `budgetsFor(tier, overrides)`):

| metric | desktop | phone-mid | phone-low |
|---|---|---|---|
| sceneSubmissions | 400 | 150 | 80 |
| triangles | 5 M | 1.5 M | 500 k |
| transparent overdraw (fragments / pixel) | 3 | 2 | 1.5 |
| skinned vertices | 400 k | 150 k | 60 k |
| shadow texels | 4 M | 1 M | 262 k |
| texture bytes | 512 MB | 192 MB | 96 MB |
| frame ms | 16.6 | 16.6 | 33 |

Hint codes (`hintsFor`, remedies in `npx threeforge explain --all`): `over-budget-submissions`,
`over-budget-triangles`, `untagged`, `unique-materials`, `unsupported-material`, `programs`, `transparent-overdraw`,
`skinned-vertices`, `point-light-shadow`, `shadow-texels`, `transmission`, `texture-bytes`, `static-auto-update`.

### Overlay

`createOverlay(ledger, { budget, parent, intervalMs })` from `threeforge/overlay` shows the head line (backend, tier,
submissions against the budget), the six cost rows, a diagnostics line (unattributed, program switches, programs),
reasons by count and the hints. `formatOverlay`, `formatCostRows` and `formatHints` are the pure formatters.

## 5. Material registry (`MaterialRegistry`)

`register(material)` returns the canonical material for its key without mutating the input. Three keys are computed
(`computeMaterialKeys`): **programKey** mirrors three's `RenderObject.getMaterialCacheKey()` (type, custom program
cache key, which texture slots are set with their mapping/channel/colour space, booleans, enums, feature gates such as
transmission or clearcoat as on/off, defines, node cache keys); **variantKey** adds every non-colour uniform and the
texture identities and transforms; **colorKey** is the colour. Outcomes: `new`, `merged` (same variant and colour),
`color-variant` (batchable through per-instance colour), `uniform-variant`, `shader-variant`, `unsupported`
(`ShaderMaterial` / `RawShaderMaterial` do not render on `WebGPURenderer`), `unregistered`. `describe(material)`
gives the hashes and outcome; `canonicalOf`, `keys`, and `stats()` (`registered, canonical, merged, unsupported,
programs, byProgram[]`). `programs` is checked against `renderer.info.memory.programs` in the tests: shader variants
counted by the registry are real programs.

## 6. Tags and classification

`tag.static(obj)` and `tag.dynamic(obj)` write `userData.forge`; a tag on an ancestor applies to its subtree.
`classify(root, { policy, animations })` decides per mesh, in this order: skinned → morph targets → `ShaderMaterial`
(unsupported) → dynamic tag → parented under a bone → animated by a clip (pass `animations`: clips, or
`{ root, clips }` per animated root so shared bone names resolve correctly) → exclusion rules → static tag → policy
`auto` (untagged plain meshes become static) → `untagged`. Exclusion rules (`exclusionRule`): `invisible`,
`already-instanced`, `transmission` (three scales volume thickness by the object matrix, which a batch cannot
provide), `dynamic-geometry` (`DynamicDrawUsage` / `StreamDrawUsage` attributes), `multi-material`, `layers`,
`render-order`, `custom-hook` (own `onBeforeRender`/`onAfterRender`), `draw-range`, `frustum-culled-off`, `mirrored`
(negative determinant). Every excluded mesh shows up in the ledger as `excluded:<rule>`.

## 7. The scene compiler (`World`)

### `compile()` step by step

1. Install scene hooks when the nested-pass policy is `reuse-main` (see culling).
2. Classify every mesh; record the counts of meshes and distinct materials (`before`).
3. Collect statics; with `dynamics: 'batch-sync'` also collect dynamics that pass every batch rule.
4. `batchStatics`: register materials, group statics by **variant key + geometry attribute signature + castShadow +
   receiveShadow (+ chunk cell)**. Per group: geometry repeated at least `instanceThreshold` times in an opaque group
   becomes a compacted `InstancedMesh` per geometry; the rest becomes one `BatchedMesh` (or, with `bake`, one baked
   `Mesh`); a group of one mesh stays a mesh with the canonical material (`unique-material`). Batches use the
   canonical material itself when every instance is white, else a white clone with per-instance colour.
   Non-indexed geometries get an index on a clone (`ensureIndexed`); indices promote to Uint32 as needed.
5. Attach BVH culling to every batch (`culling: 'bvh'`), with LOD ranges when `lod` is set.
6. Install matrix sync for batch-synced dynamics and occlusion proxies when enabled.
7. Hide the originals: moved to layer 31 with `matrixAutoUpdate = false` (`originals: 'hide'`), or removed from the
   graph (`originals: 'detach'`); parent indices are recorded so `decompile()` restores the exact order.
8. Annotate everything left alone (excluded rule, `unique-material`, `dynamic`) and swap canonical materials onto
   remaining meshes (`materials: 'canonical'`; `'keep'` leaves each mesh's own instance).
9. Return the `CompileReport`: `before`, `after { batches, instanced, baked, meshes }`, `bake` summary, `groups[]`
   (kind, chunk, lods, program and variant hashes, instances, geometries, transparency, shadow flags, bake report),
   `skipped[]` with rules, registry stats, culling mode, `synced`, `lod`, `occlusion`, `nestedPasses`.

### Options

| option | default | what it does |
|---|---|---|
| `registry`, `ledger` | new / none | share the registry with the ledger so reasons and programs agree |
| `policy` | `'tagged'` | `'auto'` batches untagged plain meshes too |
| `originals` | `'hide'` | `'detach'` removes originals from the graph (large scenes) |
| `culling` | `'bvh'` | `'linear'` keeps three's own per-instance culling |
| `instanceThreshold` | 64 | repeats of one geometry in an opaque group that become an InstancedMesh |
| `dynamics` | `'separate'` | `'batch-sync'` folds batchable dynamics into batches and syncs their matrices each frame |
| `chunkSize` | off | one batch per world-space cell (tight bounds, streamable) |
| `lod` | off | `{ distances: [d1, d2] }` switches to LOD ranges generated by `prepareLods` |
| `occlusion` | false | occlusion-query proxies per batch / instanced group (`object.occlusionTest` + `renderer.isOccluded`) |
| `animations` | none | clips or `{ root, clips }` so animated meshes classify as dynamic |
| `nestedPasses` | `'auto'` | `'reuse-main'` on WebGPU, `'per-pass'` on WebGL2 (see culling) |
| `materials` | `'canonical'` | `'keep'` leaves each mesh's material instance |
| `bake` | off | `true` or `BakeOptions`: baked mesh per finished group (section 8) |

### Culling, instancing, chunks, LOD, occlusion

- **BVH culling** (`attachBvhCulling`): a `bvh.js` tree of instance boxes replaces `BatchedMesh`'s linear
  per-instance test. The hook mirrors three's own `onBeforeRender` (fills `_multiDrawStarts/Counts`, the indirect
  texture) and is prepended with `prependRenderHook`, never overwriting the object's hook; hooks are marked with
  `FORGE_HOOK`. The handle offers `move(id)`, `insert(id)`, `remove(id)`, `detach()`.
- **Instancing** (`createCulledInstancedMesh`): master matrices and colours are kept aside; every frame the visible
  instances are compacted to the front of `instanceMatrix`/`instanceColor` and `count` is set, so culled instances
  cost nothing. LOD levels are separate InstancedMeshes chosen by distance. Handle: `setMatrixAt`, `setVisibleAt`,
  `getVisibleAt`, `detach`.
- **Chunks** (`chunkSize`): groups are split by cell, which gives batches tight bounds (whole-object frustum
  culling), per-cell shadow casting and a natural unit for streaming.
- **LOD** (`generateLods(geometry, { ratios, error, lockBorder })`, `prepareLods(root, options)`, `lodsOf`): meshoptimizer
  `simplify` (with `simplifySloppy` fallback), welding non-indexed meshes first; levels are extra geometry ranges in
  the batch or extra InstancedMeshes, picked by `levelFor(distance, distances)`.
- **Nested passes**: a BatchedMesh whose visible set changes twice in one frame on WebGPU (a reflection pass, then
  the main pass, same material) draws the main pass with the nested pass's instance list; `reuse-main` culls once per
  frame with the outermost camera. Shadow passes are fine (own bind group).
- **Occlusion** (`occlusion: true`): a proxy box per batch / instanced group carries `occlusionTest`; its own
  `onAfterRender` reads `renderer.isOccluded()` and hides the target next frame.

### Runtime API

`world.resolve(intersection)` maps a raycast hit on a batch (`batchId`), an instanced mesh (`instanceId` through the
compaction table) or a baked mesh (`faceIndex` through per-triangle origins) back to the original mesh.
`world.setVisible(original, visible)` hides an instance wherever it went (a baked module rebakes its group).
`world.slotOf(mesh)`, `world.batchedMeshes`, `world.instancedMeshes`, `world.bakedMeshes`, `world.cullingOf(batch)`,
`world.mainCamera`, `world.bakeDebug()`. `world.decompile()` removes everything it built, disposes what it owns,
restores layers, matrices, materials and parent order, and allows `compile()` again.

### Warm-up

`world.warmup(renderer, camera, { mode })` builds every pipeline before the first visible frame. Default `frame`
renders one real frame under a 1×1 scissor: the only way in three r186 to get exactly the pipelines the first frame
uses. `async` runs `renderer.compileAsync()` (yields between objects) and then disposes and rebuilds the materials
three compiles wrong that way (transparent double-sided and transmissive ones; see section 13). Result:
`{ mode, textures, repaired }`.

## 8. Bake: one mesh per finished group

`new World(scene, { bake: true | options })` replaces the `BatchedMesh` of each finished static group with one
world-space `Mesh` (`bakeGeometries` in `src/compiler/bake.ts`):

1. **Gather**: positions and normals transformed to world space (mirrored matrices flip winding), uv when every
   module has it, colour from vertex colours × instance tint (then the material becomes a `vertexColors` clone).
2. **Contact seams**: triangles are grouped by plane, split into the two facing sides and merged into islands along
   shared edges; an island whose boundary edges equal an island's on the other side is a seam between two touching
   modules and both go, whatever their triangulation. Partial overlaps stay.
3. **Duplicates**: exact same triangle twice (a module placed twice) keeps one.
4. **Buried faces** (opt-in `removeBuried`): 24 rays over the front hemisphere from each face, cast against a BVH of
   the whole group (three-mesh-bvh); the face is buried only if every ray is blocked within `distance` measured along
   the face normal (default 0.1 units): solid right in front of it. Room interiors and open backsides survive;
   double-sided materials must be blocked on both sides.
5. **Weld**: vertices merge only when position (`tolerance`, default 1e-4), normal (`normalAngle`, default 0.5°),
   uv (exact) and colour (`colorTolerance`, default 1/255) agree, so shading never changes.

Control and inspection: `mesh.userData.forgeBake = false` passes a module through untouched; the compile report's
`bake` block counts seams, duplicates, buried faces, welded vertices and excluded entries; `world.bakeDebug()`
returns the removed faces as red unlit meshes; hiding a module rebakes its group; `decompile()` restores. Instanced
groups and batch-synced dynamics are never baked. The CLI's `analyze --bake --views N` bakes and checks pixel parity
from N+1 camera angles. Verified: the village bake is pixel-identical; a 6×3 modular wall loses exactly its 27
seams; a block 5 cm inside a solid goes only with `removeBuried`; the 2CylinderEngine assembly stays identical over
four views on both backends.

## 9. Character assembler

`assembleCharacter({ skeleton, wardrobe, equipped, atlas: { size }, material })` merges skinned parts onto one shared
skeleton: bones are remapped by name, textures are packed into a k×k grid atlas (a `DataTexture` in node, an
`OffscreenCanvas` in the browser) with uv clamping and a half-texel inset, and one skinned mesh with one material
results. `equip(part)` / `unequip(part)` rebuild only the vertex buffer; the draw count never changes. The report
gives the atlas cells (`cellOf`), bones, vertices; `dispose()` frees the atlas. This is the "PolyMorph lesson": gear
swaps change data, not draw calls.

## 10. For AI agents: hook, CLI, MCP

- **Hook**: `exposeToAgents({ ledger, world, renderer, scene, camera })` publishes `window.__threeforge` with
  `version`, `schemaVersion`, `frame()`, `frameAsync()` (waits one animation frame so shadow maps update, renders if it
  can), `compile()` / `decompile()`, `measureOverdraw()`, `measureMemory()`, `hints()`, `report()`. Returns a disposer.
- **CLI** (`npx threeforge`, no arguments prints AGENTS.md):
  - `analyze <file.glb|.gltf> [--backend webgl2|webgpu] [--tier auto|desktop|phone-mid|phone-low] [--budget N]
    [--frames 30] [--no-compile] [--bake] [--bake-buried] [--views N] [--json]`: serves the shipped harness page and the
    asset's folder from a built-in static server on 127.0.0.1, launches headless Chromium through Playwright
    (headless shell for WebGL2, full Chromium with WebGPU flags otherwise), loads the asset with Draco/KTX2/meshopt
    support, measures N frames, overdraw and memory, screenshots the default framing plus the orbit views, compiles,
    measures and screenshots again, computes pixel parity per view, and prints one JSON document.
  - `inspect <url> [--frames 30] [--compile] [--budget N] [--json]`: drives the agent's own dev server through the
    hook; same document without asset facts and parity.
  - `explain <code> | --all`: `{ code, category, severity, meaning, fix, api, docs }` per hint code.
  - `schema [snapshot|analyze|inspect|all]`: JSON Schema (draft 2020-12) of everything printed.
  - `mcp`: stdio Model Context Protocol server with `analyze_asset`, `inspect_app`, `explain_hint`.
- **The document**: `{ schemaVersion: 1, tool, version, command, input, env, asset, before, after, compile, parity,
  hints, verdict, timings }`. `verdict.pass` is false over the budget, with an error-severity hint, or when parity is
  lost. Exit codes: 0 pass, 1 verdict failed, 2 usage/input, 3 environment (install command in the message),
  4 page error/timeout. `--json` prints JSON on stdout and the human summary on stderr.
- **Programmatic**: `import { analyzeAsset, inspectApp, explain } from 'threeforge/cli'`.
- Playwright, `@modelcontextprotocol/sdk` and `zod` are optional peers imported lazily; game code never pays for them.

## 11. Benchmark suite and regression gate

Eight scenes in `test/app/scenes`, each with a naive assembly and an optimized path (`world.compile()` plus the
budgets the scene stresses):

| id | scene | stresses |
|---|---|---|
| `village` | 300 props from 40 shapes, 40 materials, 10 dynamics, 2 skinned | static batching, registry |
| `forest` | terrain, 5 000 trees of 3 species, 2 000 grass patches | instancing, LOD, culling |
| `crowd` | 200 skinned Kenney mini characters, all animating | skinning budget (VAT next) |
| `bossfight` | arena, 12 fighters, 16 blocky characters, 30 VFX systems, shadowed lights | overdraw, transparency |
| `lake` | reflective water, 2 000 rain sprites, fog, wet ground | fill rate, weather |
| `daynight` | the village under a sun cycle with a 2048² shadow map | lighting, shadows |
| `zen` | 50 000 low-poly objects over 2 km² in 250 m chunks | chunking, memory |
| `rpg` | portrait 9:16, one character, gear swapped every 30 frames | character assembler |

`pnpm bench [backend]` measures 10 warm-up and 60 measured frames per variant (medians), one overdraw and memory
measurement, writes `bench/results/local.<backend>.json` and fails when any deterministic metric (submissions, GPU
draws, triangles, programs, overdraw, skinned vertices, shadow casters and texels, memory bytes) is worse than
`bench/baselines/<backend>.json` by 10 % or more; timing is recorded and gated only with `FORGE_GPU=native` (CI
runners render on SwiftShader). `pnpm bench:baseline` promotes results and rewrites `docs/bench.md` and the README
table. Current baselines: village 303 → 28, forest 5 706 → 13, bossfight 2 780 → 424, daynight 605 → 55,
zen 10 879 → 125, rpg 4 → 1; crowd and lake wait for the skinning and overdraw modules.

## 12. Development, tests, CI, release

- `pnpm dev` opens the harness (`test/app`, `window.__forge`) with query parameters: `scene=naive|field|character|
  gltf&asset=<name>|biome|arena|empty` or a bench scene with `variant=naive|optimized`, `backend`, `compile=1`,
  `overlay=1&budget=30`, `animate=1`, `dynamics=batch-sync`, `lod=1`, `chunk=40`, `culling=linear`, `threshold=N`,
  `occlusion=1`, `wall=1`, `shadows=0`, `freeze=1`, `materials=keep`, `nested=per-pass`, `bake=1|buried`, `env=0`,
  `bloom=1`, `assemble=1`, `fighters`, `blocky`, `vfx=0`, `t`, `density`, `count`, `tier`.
- `pnpm test` (Vitest, 199 units against a fake renderer that mirrors the backends' draw counting), `pnpm e2e`
  (Playwright, projects `webgl2` and `webgpu`; screenshot baselines without platform suffixes), `pnpm budget` (naive
  scene ≤ 30 submissions), `pnpm assets` / `pnpm assets:kits` (public glTF corpus and Kenney kits, gitignored),
  `pnpm assets:report` (104 assets compiled with pixel parity on each backend), `pnpm bench`, `pnpm build` (library
  via tsc plus the CLI harness page via Vite), `pnpm typecheck`.
- CI (`.github/workflows/ci.yml`): unit job, bench job per backend (assets cached, build, e2e, bench gate), publish
  job on `v*` tags with `npm publish --provenance` (needs the `NPM_TOKEN` secret; see `docs/release.md`).
- Repository rules for agents working in the repo: `CONTRIBUTING.md`.

## 13. What we learned about three r186 (and how threeforge works around it)

- `renderer.compileAsync()` queues `renderObject()` work and builds it after `material.side` is restored and the render
  context is null: transparent double-sided and transmissive materials compile as single-pass DoubleSide and
  transmission binds a viewport texture no frame writes. `needsUpdate` cannot fix the cached render objects;
  `material.dispose()` can. threeforge's warm-up renders a scissored real frame instead (`docs/upstream-compileAsync.md`).
- Shadow maps and the transmission backdrop re-render once per node frame id, which advances only on animation-frame
  ticks: measurements must come from a frame after a real tick (`frameAsync()` everywhere).
- On WebGPU a batch whose visible set changes twice per frame (reflection then main) draws the main pass with the
  nested pass's list: `nestedPasses: 'reuse-main'`.
- Transmissive materials cannot be batched (thickness scales with the object matrix); reflectors fill their target
  one frame late; `KTX2Loader` needs `detectSupportAsync(renderer)`; `RenderObject.getDrawParameters()` returns null for
  a zero-instance InstancedMesh (no draw, no count); `ShaderMaterial` does not render on `WebGPURenderer`.
- Half-float render targets read back as raw 16-bit halves on both backends, and WebGPU returns rows padded to 256
  bytes: the overdraw target uses 32-texel row multiples and decodes halves.
- three's experimental `SceneOptimizer` batches everything including skinned meshes and disposes shared geometry; it
  was measured as the spike baseline (`docs/spike-scene-optimizer.md`) and not used.

## 14. Limits and roadmap

Skinned meshes are measured but not yet instanced (baked animation textures, SP4); sprites and particles are counted
and their overdraw measured but not yet budgeted or scaled (SP3: `ResolutionScaler`, `ParticleBudget`, transparency
hints); lighting helpers (`DayNight`, `ShadowBudget`) are SP5; per-frame JS (`RenderScheduler`, static-subtree matrix
freezing) is SP6; memory and streaming (`ResourceTracker`, loader pipeline, chunk `Streamer`) is SP7;
`threeforge optimize model.glb` (glTF-Transform build-time pipeline) follows the agent CLI; the device bench page with
GitHub-native result submission follows the release. Specs live in `docs/superpowers/specs`, plans in
`docs/superpowers/plans`.

## 15. Glossary

- **submission**: one render item three processed (a mesh, a material group of a mesh, a batch, a sprite) in one pass.
- **sceneSubmissions**: submissions attributable to the user's scene; the budgeted number.
- **gpuDraws**: draw commands those submissions issue on this backend; **drawCommands** counts multi-draw ranges.
- **unattributed**: reported draw calls the ledger's model did not predict; always 0 in the tests.
- **program**: a compiled shader variant, as counted by `renderer.info.memory.programs`.
- **tier**: `desktop`, `phone-mid`, `phone-low`; drives budgets and hints.
- **seam**: two coincident faces with opposite winding between touching modules; removed by the bake.
- **buried face**: a face with solid geometry right in front of it in every direction; removed only on request.
