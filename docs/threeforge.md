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
if (import.meta.env.DEV) exposeToAgents({ ledger, world, renderer, scene, camera }); // window.__threeforge, development only

renderer.render(scene, camera);
const frame = ledger.frame();                // FrameSnapshot v2: six cost sections + hints
```

```bash
npx threeforge analyze scene.glb --backend webgpu --tier phone-mid --json
npx threeforge inspect http://localhost:5173 --json
```

## 3. Architecture

| Directory | Responsibility |
|---|---|
| `src/tags.ts` | `tag.static(obj)`, `tag.dynamic(obj)`, `tag.of(obj)`; stored in `userData.forge` |
| `src/registry` | `MaterialRegistry`: material keys (program, variant, colour) and canonical sharing |
| `src/ledger` | `DrawCallLedger`, the v2 snapshot, reasons, expected GPU draws, sections (skinning, lighting), memory estimate, measured overdraw, budgets and tiers, hints |
| `src/compiler` | `classify` (rules), `batchStatics` (batches, instancing, bake), `bake` (geometry bake), `culling` (BVH, hooks), `instancing` (compacted InstancedMesh), `geometryCompat`, `World` (compile/decompile/resolve/warmup) |
| `src/lod` | meshoptimizer LOD generation |
| `src/overdraw` | `ParticleBudget` (particle caps per tier) and `ResolutionScaler` (dynamic drawing-buffer scale) |
| `src/scheduler` | `RenderScheduler` (render on change) |
| `src/lighting` | `DayNight` (sun, sky dome, hemisphere, fog, quantized shadow updates) and `ShadowBudget` (map sizes per tier, frozen shadows) |
| `src/character` | the character assembler (gear merged onto one skeleton, one atlas) |
| `src/overlay` | text formatting of a snapshot and the DOM overlay |
| `src/agent` | `exposeToAgents` (the `window.__threeforge` hook) |
| `src/cli` | the `threeforge` CLI (`analyze`, `inspect`, `optimize`, `explain`, `schema`, `mcp`, `decoders`), the MCP server, JSON schemas, hint remedies, the glTF-Transform pipeline (node only, optional peers loaded lazily) |
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
skinning:  submissions, vertices, bones, skeletons, maxBones, morphTargets, vatInstances, vatVertices
lighting:  lights { directional, point, spot, hemisphere, ambient, other }, shadowLights, shadowPasses,
           shadowCasters, shadowTexels, shadowSubmissions
js:        renderMs, frameMs, objects, autoUpdatedMatrices
memory:    textures { count, bytes }, geometries { count, bytes }, renderTargets { count, bytes },
           unreferenced { geometries, textures }, chunks { total, resident }, estimated: true
hints:     [{ category, severity, code, message, objects }]
items?:    per-submission records with ledger.frame({ items: true })
```

- **overdraw** is measured, not estimated: `ledger.measureOverdraw(scene, camera)` renders the scene twice into a
  1/8-resolution half-float target with an additive count material (no depth test, both faces), once for the opaque
  render list (`renderer.transparent = false`) and once for the transparent list, reads the target back and averages
  the red channel: fragments per pixel. three copies `alphaTest` and `alphaMap` onto override materials, so cutouts
  count only their visible texels. Attribution is paused during the measurement. Call it on demand.
- **skinning** sums the main pass's skinned submissions: vertices, bones per unique skeleton (indexed per frame, no
  uuids in the snapshot), the largest bone count, morph targets; `vatInstances` and `vatVertices` count the
  characters drawn as animated instances (`kind: 'vat'`, reason `vat-instanced`), which need no CPU bones.
- **lighting** scans the main scene's visible lights; `shadowTexels` = Σ `mapSize.x · mapSize.y · faces` with 6
  faces for point lights (a cube target); casters are the unique objects in `shadow:*` passes.
- **js**: `renderMs` is the outermost `render()` duration, `frameMs` the median interval between the last 60 outermost
  renders, `objects`, `autoUpdatedMatrices` and `hiddenOriginals` (batched originals parked on layer 31) come from a
  traversal repeated at most every 60 frames; `skipped` is the ticks a `RenderScheduler` skipped among its last 60
  (`ledger.rescan()` forces it).
- **memory** estimates bytes: textures `w · h · 4 · bytesPerChannel · (mipmaps ? 4/3 : 1) · (cube ? 6 : 1)`, compressed
  textures Σ mip bytes, geometries Σ attribute and index bytes, render targets from shadow maps and the renderer's
  half-float frame-buffer target. `ledger.measureMemory()` recounts now.
- **memory.unreferenced** counts the geometries and textures the renderer still holds (`info.memory` counts) that the
  scene no longer reaches, minus what three allocates for itself (one geometry, two frame-buffer textures, two per
  shadow map); reachable includes BatchedMesh and skeleton textures and `material.userData.forgeTextures`. Recounted
  with the graph statistics; `measureMemory()` recounts now. **memory.chunks** is the attached Streamer's residency,
  read live.
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
| particles per frame | 60 k | 15 k | 5 k |
| objects walked per frame | 20 k | 5 k | 2 k |

Hint codes (`hintsFor`, remedies in `npx threeforge explain --all`): `over-budget-submissions`,
`over-budget-triangles`, `untagged`, `unique-materials`, `unsupported-material`, `programs`, `transparent-overdraw`,
`skinned-vertices`, `point-light-shadow`, `shadow-texels`, `transmission`, `transparent-batch-order`, `texture-bytes`,
`static-auto-update`, `particles-over-budget`, `sprites-unbatched`, `js-objects`, `detach-originals`,
`bones-over-budget`, `skinned-crowd`, `geometry-bytes`, `unreferenced-resources`.

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
`auto` (untagged plain meshes become static) → `untagged`. Exclusion rules (`exclusionRule(mesh, root?)`): `invisible`,
`invisible-ancestor` (an ancestor up to `root` with `visible = false`, via `isVisibleInGraph`; the mesh's own
visibility is `invisible` above), `already-instanced`, `material-invisible` (`material.visible === false`),
`transmission` (three scales volume thickness by the object matrix, which a batch cannot provide), `dynamic-geometry`
(`DynamicDrawUsage` / `StreamDrawUsage` attributes), `multi-material`, `layers`, `render-order`, `group-render-order`
(the *nearest* `isGroup` ancestor has `renderOrder !== 0`: three's `Renderer._projectObject` reassigns
`groupOrder = object.renderOrder` at every `isGroup` object on the way down — a plain overwrite, not accumulated —
so only the closest Group's value reaches the mesh; a farther Group's `renderOrder` and any non-Group `Object3D`'s
`renderOrder` in between are never read for this), `clipping-group` (an enabled `isClippingGroup` ancestor at *any*
depth — clipping contexts chain, `getGroupContext` builds each one from its parent — WebGPU-only per three's docs,
but the shared `Renderer.js` `_projectObject` that reads it backs both the WebGL2 and WebGPU backends here), `custom-hook` (own
`onBeforeRender`/`onAfterRender`), `draw-range`, `frustum-culled-off`, `mirrored` (negative determinant). Every
excluded mesh shows up in the ledger as `excluded:<rule>`. `root` is optional; without it the three ancestor-scoped
rules (`invisible-ancestor`, `group-render-order`, `clipping-group`) are skipped, since there is no boundary to walk
to. `spriteRule(sprite, root?)` shares the same ancestor walker (`ancestorExclusionRule`) for `group-render-order`
and `clipping-group`, plus its own `material-invisible`, `multi-material`, `sprite-center`, `layers`, `render-order`
and `custom-hook`.

## 7. The scene compiler (`World`)

### `compile()` step by step

1. Install the `PassTracker` scene hooks (always): render depth, open passes and the main camera, for batch culling,
   instancing and sprite batches (see culling).
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
   graph (`originals: 'detach'`); parent indices are recorded so `decompile()` restores the exact order. Then freeze
   (`freeze: true`): unbatched static meshes and every ancestor whose whole subtree is static get
   `matrixAutoUpdate = false` too (`after.frozen`).
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
| `nestedPasses` | `'auto'` | `'per-pass'` on both backends; `'reuse-main'` is the other policy (see culling) |
| `materials` | `'canonical'` | `'keep'` leaves each mesh's material instance |
| `bake` | off | `true` or `BakeOptions`: baked mesh per finished group (section 8) |
| `sprites` | `'batch'` | sprites sharing a material become one instanced billboard draw synced each frame; `'keep'` leaves them |
| `spriteThreshold` | 4 | sprites a material needs before its group is batched |
| `freeze` | true | `matrixAutoUpdate = false` on unbatched statics and all-static ancestors; move them with `markDirty` |
| `transparent` | `'batch'` | transparent statics batch/bake like any other group; `'keep'` routes them aside as individual meshes, annotated `transparent-kept` |

Transparent statics batch by default, but three sorts a `BatchedMesh` back-to-front by its own bounding-sphere
centre, not per instance: a transparent batch composites in creation order relative to other transparent
submissions in the same pass, not by true per-object depth against them. `transparent: 'keep'` opts a scene out of
this (its transparent statics stay individual meshes, each sorted by three like any other transparent object), at
the cost of one draw per mesh instead of one per batch; the `transparent-batch-order` hint (info) names it whenever
a threeforge transparent batch shares the main pass with another transparent submission.

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
- **Nested passes** (shadow maps, reflections, portals): three renders them from inside another render, a shadow map
  from the first `receiveShadow` object's draw. Every material of a batch reads one index texture; on WebGPU its
  upload lands at once while a pass is submitted only when it ends, and on WebGL that receiving batch draws right
  after the shadow render returns. So batches keep a **stable prefix**: `PassTracker` (scene hooks, marked) knows
  which passes are open, and a nested pass on a batch an open pass has already culled leaves that pass's index rows
  untouched, zeroes the counts of the rows its camera does not need, appends the ids it lacks (LOD by the main
  camera's distance; sorted for its camera when the batch sorts) and marks the texture only when an appended row
  changed; the counts and `_multiDrawCount` come back when the nested render ends (or when the tracker heals after
  a render that threw). `nestedPasses` decides a batch no open pass has culled yet: `per-pass` (the default on both
  backends) culls it for the nested camera, `reuse-main` appends to the rows of its last outermost cull. On WebGPU a
  nested pass issues one draw command per slot, zero-count ones included.
  Compacted instanced meshes keep a stable prefix too, the same under both policies. Above the uniform-buffer limit
  three keeps their matrices in one vertex buffer that syncs once per frame per render object and is checked for
  upload at most once per render call (a nested render advances the call count, so a draw after it cannot upload
  what changed since): a nested pass that reaches a mesh before the outermost render did compacts it for the main
  camera first; a shadow pass keeps the enclosing rows and appends, once per frame and in the same rows for every
  shadow pass, the instances any shadow-casting light reaches (directional and spot frusta, a point light's cube of
  half-size `distance || shadow.camera.far`); any other nested pass draws the enclosing rows; `count` and
  `visibleIds` come back when the nested render ends. On that vertex buffer an outermost compaction marks only the
  rows it changed (`addUpdateRange`), while a nested pass that writes rows marks the whole matrix and colour buffers:
  a receiver's render object runs the instance `OnBeforeFrameUpdate` event before its `ShadowNode` (the position
  stack is flowed before the stage loop in `NodeBuilder.build`), so the shadow render object's own sync replaces the
  main pass's synced ranges before they upload, and the main pass cannot upload again in that render call.

  | Nested pass | Batch, `per-pass` | Batch, `reuse-main` | Compacted instanced mesh (either policy) |
  |---|---|---|---|
  | an open pass culled the object | keep its rows, zero the unneeded, append the missing | same | shadow: keep its rows, append the frame's shadow casters; other: draw its rows |
  | no open pass culled it yet | fresh cull for the nested camera | append to the last outermost rows | compact for the main camera first, then as above |
  | outermost render | fresh cull | fresh cull | compact (skipped while the view and rows are unchanged) |
  | end of the nested render | counts restored | counts restored | `count`, `visibleIds` restored |

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

### Overdraw modules: sprite batching, ParticleBudget, ResolutionScaler

- **Sprite batching** (`src/compiler/sprites.ts`, `src/compiler/spriteBatch.ts`): `compile()` collects every
  `Sprite`, groups them by material keys (`variantHash` and colour), and for each group of at least
  `spriteThreshold` builds one `Mesh` over an `InstancedBufferGeometry` unit quad with a `SpriteNodeMaterial` copied
  from the group's `SpriteMaterial`; `positionNode` and `scaleNode` read per-instance attributes. The originals go
  to the hidden layer and keep auto-updating; a `FORGE_HOOK` render hook on the batch copies their world
  positions and scales into the attributes once per frame, for the main camera only (an invisible sprite gets
  scale 0; instances outside the four side planes of the frustum are left out, so the count matches what three
  would have drawn), sorted back to front by projected depth when the material blends normally (what three does
  for sprites), and sets `instanceCount`. Nested passes (reflections) draw the main camera's list on both
  backends: three refreshes an object's attributes only on its first render object of a frame, so a second fill
  for a nested camera would be what the main pass draws (section 13). Reason
  `sprite-batch`, name `forge:sprites:<programHash>:<n>`, `after.spriteBatches` in the report; skipped sprites
  carry `sprite-center`, `layers`, `render-order`, `material-invisible`, `group-render-order`, `clipping-group`,
  `custom-hook` or `sprite-threshold`. `decompile()` restores.
- **`ParticleBudget`** (`src/overdraw/ParticleBudget.ts`): `new ParticleBudget({ tier, particles?, pointSizeScale? })
  .apply(root)` counts every `Points` object (what its `drawRange` draws), every sprite batch (its instances) and
  every single sprite; over the tier's `particles` budget, points and batches shrink by one common ratio (points
  through `setDrawRange`, batches through `userData.forge.cap`, which the sync hook honours by keeping the nearest
  instances) so the total fits alongside the single sprites, which cannot be capped. `PointsMaterial.size` is
  multiplied by `pointSizeScale` (0.75 on `phone-low`). Returns `{ tier, budget, before, after, ratio, systems }`;
  `release()` restores; `apply()` again re-derives from the originals.
- **`ResolutionScaler`** (`src/overdraw/ResolutionScaler.ts`): `new ResolutionScaler(renderer, { target?, tier?,
  min, max, step, window, ledger? })`; `update(frameMs)` every frame; every `window` frames the median decides:
  above `target × 1.05` the scale steps down, below `target × 0.7` it steps up, clamped to `[min, max]`; a change
  calls `renderer.setPixelRatio(base × scale)` (three resizes the drawing buffer) and updates the ledger's
  `env.dpr`. `set(scale)`, `dispose()`. Overdraw per pixel is unchanged; `overdraw.pixels` shrinks.
- **Ledger**: `overdraw.particles`, `overdraw.pixels`; hints `particles-over-budget`, `sprites-unbatched`; bench
  metrics `particles` and `fillMegapixels` (fragments per pixel × pixels). Conventions for effects: `docs/vfx.md`.

### Per-frame JS: freezing, `markDirty`, `RenderScheduler`

What three pays in JavaScript every frame (r186): `render()` walks every descendant in `updateMatrixWorld()`
(the recursion is unconditional; an object with `matrixAutoUpdate` recomposes its local matrix and forces its
subtree's world matrices) and again in the render-list build (`visible` objects, hidden originals included).
Only `matrixAutoUpdate = false` cuts the recomposing and only removing objects from the graph (`originals:
'detach'`) cuts the walks.

- **Freezing** (`src/compiler/freeze.ts`, `freezableObjects`): at compile, unbatched static-tagged meshes and the
  topmost ancestors whose subtree is entirely static (hidden unsynced originals, static meshes, plain containers;
  nothing dynamic-tagged, animated, lit, skinned, bone or sprite inside) get `matrixAutoUpdate = false` after one
  last `updateMatrix()`. A container freezes only when it also holds at least one such static leaf: an empty
  container, an anchor `Object3D` with no children, and a light's `target` (added straight to the scene, as
  `DayNight` does for the sun) are never frozen, since nothing would ever move their matrix again. `decompile()`
  restores the flags. The village drops from 310 to 34 recomposed matrices per frame with identical pixels.
- **`world.markDirty(object)`** moves a frozen static on demand: recomposes every local matrix under `object`,
  recomputes the world matrices, pushes each batched original in the subtree into its batch (`BatchedMesh`
  matrix and BVH leaf, `InstancedMesh` through its culling handle, a baked group by rebaking once; sprite
  batches follow on their own) and returns the number of instances updated. `world.onDirty(listener)` reports
  `markDirty`, `setVisible`, `compile` and `decompile` (a `RenderScheduler` subscribes to it).
- **`RenderScheduler`** (`src/scheduler/RenderScheduler.ts`): `new RenderScheduler({ renderer, scene, camera,
  ledger?, world?, mixers?, watch?, keepAliveMs?, onRender? })`, `start()` drives `renderer.setAnimationLoop`,
  `tick(time)` renders only when `invalidate()` was called, the camera's world or projection matrix changed, a
  watched object moved, a mixer has running actions (mixers are updated every tick), the drawing buffer was
  resized, or `keepAliveMs` elapsed; otherwise three does nothing for that tick. Baselines are re-captured after
  each render (three recomputes the camera's projection on its first WebGPU frame). `stats`, `lastReason`,
  `skippedRecently()` (what `js.skipped` reports through `ledger.attachScheduler`), `stop()`, `dispose()`.
- **Ledger**: `js.hiddenOriginals`, `js.skipped`; budget `objects`; hints `js-objects` (over budget) and
  `detach-originals` (1 000 or more hidden originals: `originals: 'detach'`); bench metrics `objects` and
  `autoUpdatedMatrices`.

### Lighting: `DayNight`, `ShadowBudget`, lightmaps

- **`DayNight`** (`src/lighting/DayNight.ts`): one sun on a circle (rise 6, set 18, a faint moon below), a
  gradient sky dome (`sky-dome`, vertex colours, static-tagged so it freezes and draws once), a hemisphere light,
  fog and background following the horizon; `setTime(hours)` drives all of it and requests a shadow-map render
  only when the sun moved `everyDegrees` (default 0.5) since the last one, through `shadow.needsUpdate` with
  `autoUpdate` off. `refreshShadow()`, `dispose()`. The day/night benchmark renders the map every second frame.
- **`ShadowBudget`** (`src/lighting/ShadowBudget.ts`): `apply(scene)` switches shadows off on the `off` tiers,
  drops point-light shadows off phones, then halves the largest map until the texel sum fits the tier's
  `shadowTexels` budget (floor `minMapSize`); three resizes the targets on the next shadow render. `release()`
  restores. `ShadowBudget.freeze(light)` returns a `refresh()` for static lights.
- **Lightmaps**: the registry keys `lightMap` and its channel, `attributeSignature` includes `uv1`, and the bake
  carries and welds every UV set, so lightmapped statics batch and bake without losing their coordinates.
  Authoring notes: `docs/lighting.md`.
- **Bench**: `shadowPassesPerFrame` (mean over the measured frames) is gated; the optimized day/night and boss
  fight apply `ShadowBudget` for the detected tier.

### Skinning: `bakeAnimationTexture`, `AnimatedInstances`

- **`bakeAnimationTexture(prototype, clips, { fps })`** (`src/skinning/bakeAnimationTexture.ts`): plays every clip
  on the prototype at the origin (`LoopOnce`, clamped, so the last row is the end pose) and copies every distinct
  skeleton's `boneMatrices` into one RGBA float `DataTexture`: a row per frame, four texels per bone, skeletons
  after each other (`parts[i].boneOffset`); `clips[i]` = `{ name, start, frames, duration }`, `parts[i]` =
  `{ mesh, matrix, boneOffset }`. The prototype's transform and pose are restored.
- **`AnimatedInstances({ animation, count, material? })`** (`src/skinning/AnimatedInstances.ts`): one `Mesh` per
  part over an `InstancedBufferGeometry` sharing the part's buffers, `MeshStandardNodeMaterial` with a TSL
  `positionNode` that fetches the instance's four bone matrices for its current row (`clipStart + floor(mod((time
  × speed + offset) × fps, frames))`), applies `bindMatrixInverse × Σ bone × weight × bindMatrix` and the instance
  matrix, and assigns `normalLocal`. The instance matrices live in one `InstancedInterleavedBuffer` (four separate
  attributes would exceed WebGPU's eight vertex buffers; a plain `InterleavedBuffer` is read per vertex, because
  both backends take the per-instance step from `isInstancedInterleavedBuffer`). `setMatrixAt` folds the part's
  offset in, `setClipAt(i, clip, { offset, speed })`, `setTime(seconds)`, `addTo`, `dispose`. Meshes are
  `forge:vat:<part>` with `userData.forge = { kind: 'vat', instances }` (untagged: a tag overwrites the marker).
- **Ledger**: reason `vat-instanced`, `skinning.vatInstances` / `vatVertices`, budget `bones`, hints
  `bones-over-budget` and `skinned-crowd` (50 skinned draws). Authoring notes: `docs/skinning.md`.
- **Bench**: the optimized crowd bakes each of its eight prototypes and replaces its 25 characters with one
  `AnimatedInstances`: 401 → 17 submissions, 271 k skinned vertices → 0.

### Memory and load: `createLoader`, `ResourceTracker`, `Streamer`

- **`createLoader(renderer, { decoders, draco, ktx2, meshopt })`** (`src/load/createLoader.ts`): a `GLTFLoader` with
  Draco, KTX2 (`detectSupport` after `renderer.init()`) and meshopt wired; the addons import lazily.
  `disposeLoader(loader)` ends the worker pools. `threeforge decoders <dir>` (`src/cli/decoders.ts`) copies the
  decoder files from the installed three.
- **`ResourceTracker`** (`src/memory/ResourceTracker.ts`): `track(root | geometry | texture | material, owner?)`,
  `release(owner)` disposes what no other owner holds (never a material the registry knows) and detaches an
  Object3D owner, `dispose()`, `stats()`. `collectResources(root)` and `unreferencedResources(info, scene,
  allowance)` are the building blocks (`src/memory/resources.ts`).
- **`Streamer`** (`src/streaming/Streamer.ts`): residency of `world.chunks()` (batches, instanced groups and baked
  meshes carry `userData.forgeChunk`) plus uncompiled static scene children placed by position, keyed by x and z.
  Resident while the ground-plane distance from the camera to the cell's box is at most `radius` (default
  `camera.far`), unloaded past `radius + margin × chunkSize` (first update strict). Unload removes the objects and
  disposes the geometries and textures no resident chunk shares, including a BatchedMesh's matrix, indirect and
  colour textures (never `BatchedMesh.dispose()`, which nulls them); load re-adds them and three re-uploads. `assign`,
  `userData.forgeStream = false`, `stats()`, `onChange`, `dispose()`. `ledger.attachStreamer(streamer)`.
- **Ledger**: `memory.unreferenced`, `memory.chunks`; budget `geometryBytes` (256 / 96 / 48 MB); hints
  `geometry-bytes` and `unreferenced-resources` (eight or more). Authoring notes: `docs/memory.md`.
- **Bench**: zen's ground is 64 tiles with a 512² texture each (85 MB) under fog to 600 m; the optimized variant
  streams them: 32 of 64 chunks resident at the start camera, pixel-identical to naive.

## 8. Bake: one mesh per finished group

`new World(scene, { bake: true | options })` replaces the `BatchedMesh` of each finished static group with one
world-space `Mesh` (`bakeGeometries` in `src/compiler/bake.ts`; every UV set present in all entries, `uv` to `uv3`,
is carried and compared by the weld):

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
  It lets any script on the page call `compile()`/`decompile()` and read the ledger, so call it as
  `if (import.meta.env.DEV) exposeToAgents(...)` (Vite) or behind your own flag, never unconditionally in a shipped
  build; bundlers other than Vite need their own dev check.
- **CLI** (`npx threeforge` with no arguments, `threeforge help [<command>]`, or `--help` on any command prints
  AGENTS.md). Every command's positionals and flags are declared once in `COMMAND_SPECS` (`src/cli/args.ts`); the
  parser, the usage text printed after a usage error, and the AGENTS.md command and flag tables come from it.
  - `analyze <file.glb|.gltf> [--backend webgl2|webgpu] [--tier auto|desktop|phone-mid|phone-low] [--budget N]
    [--frames N] [--no-compile] [--timeout ms] [--headed] [--bake] [--bake-buried] [--views N] [--json]`: serves the
    shipped harness page and the asset's folder from a built-in static server on 127.0.0.1, launches headless Chromium
    through Playwright (headless shell for WebGL2, full Chromium with WebGPU flags otherwise), loads the asset with
    Draco/KTX2/meshopt support, measures N frames (default 30), overdraw and memory, screenshots the default framing
    plus the orbit views, compiles, measures and screenshots again, computes pixel parity per view, and prints one
    JSON document.
  - `inspect <url> [--backend webgl2|webgpu] [--budget N] [--frames N] [--no-compile] [--timeout ms] [--headed]
    [--json]`: drives the agent's own dev server through the hook, compiling through it unless `--no-compile`
    (`--compile` is accepted and is the default); same document without asset facts and parity. There is no
    `--tier`: the app measures itself at the tier its own ledger detects.
  - `optimize <file.glb|.gltf> [--out out.glb] [--preset safe|balanced|aggressive] [--no-<step>|--<step>]
    [--simplify [ratio]] [--simplify-error e] [--compress none|meshopt] [--textures [webp|avif|none]]
    [--texture-size N] [--texture-quality Q] [--no-verify] [--parity pct] [--views N] [--budget N] [--backend …]
    [--tier …] [--frames N] [--no-compile] [--timeout ms] [--headed] [--json]`: the build-time pipeline, see below.
  - `explain [<hint-code>] [--all] [--json]`: `{ code, category, severity, meaning, fix, api, docs }` for one hint
    code, or every remedy with `--all` (a code or `--all`, not both).
  - `decoders <dir>`: copies three's Draco decoder and Basis transcoder into `<dir>/{draco,basis}` for `createLoader` (no JSON output, no flags).
  - `schema [snapshot|analyze|inspect|optimize|all] [--json]`: JSON Schema (draft 2020-12) of everything printed (always JSON).
  - `mcp`: stdio Model Context Protocol server with `analyze_asset`, `inspect_app`, `optimize_asset`, `explain_hint` (no arguments).
- **Flags** (`parseArgs`, `src/cli/args.ts`):
  - Flags follow the command, before or after its argument. A value flag takes `--flag value` or `--flag=value`; a
    boolean flag never takes one (`analyze --json scene.glb` parses), and a negatable one also accepts
    `--no-<flag>`. `--simplify` and `--textures` take a value only after `=` or when the next argument is a valid
    value (a number, a format), so `optimize --simplify scene.glb` keeps the file. `--` ends the flags.
  - `--timeout ms` bounds each page step (the load, every evaluate, the whole N-frame measurement, `compile()`;
    default 60000, a step over it exits 4). `--headed` shows the browser. `--simplify-error e` is the simplify error
    limit as a fraction of the mesh radius (default 0.001). `--texture-quality Q` is the encoder quality (default 85).
    `--textures none` and `--compress none` leave those steps out.
  - Usage errors (exit 2, nothing on stdout; the message and the usage text on stderr): an unknown flag (the nearest
    flag of the command is suggested, or the commands that take it are named), a flag before the command, an extra
    positional, a value on a boolean flag, a missing value, a flag given twice or with its negation, a malformed
    number (hex, `Infinity`, empty), a number outside `RANGES`, `inspect --tier`, `explain <code> --all`, and
    `optimize --budget` with `--no-verify` (the budget is judged on the verified render).
  - `RANGES` (by input field; `validateInput(command, input)` checks them plus the cross-field rules and is exported
    for the MCP server): `frames` an integer ≥ 1, `timeout` an integer from 1000 to 2147483647 (a longer Node timer
    fires at once), `budget` an integer ≥ 0, `views` an integer from 0 to 64, `parity` 0 to 100, `simplify` in
    (0, 1], `simplifyError` 0 to 1, `textureSize` an integer from 1 to 16384, `textureQuality` an integer from 1 to 100.
- **The document**: `{ schemaVersion: 1, tool, version, command, input, env, asset, before, after, compile, parity,
  hints, verdict, timings }`. `verdict.pass` is false over the budget, with an error-severity hint, when parity is
  lost, or when the harness page raised an error (`analyze`; one reason quotes up to five, cleaned and capped; `inspect`
  does not judge its app's page errors). Exit codes: 0 pass, 1 verdict failed, 2 usage/input, 3 environment (install command in the message),
  4 page error/timeout. `--json` writes the JSON document to stdout before the human summary is built
  (`printDocument`), then the summary to stderr; a summary that throws leaves a note on stderr and the document intact.
- **Programmatic**: `import { analyzeAsset, inspectApp, optimizeAsset, explain } from 'threeforge/cli'`.
- Playwright, `@modelcontextprotocol/sdk` and `zod` are optional peers imported lazily; game code never pays for them.

### Build-time optimize (`threeforge optimize`)

`src/cli/pipeline.ts` (pure), `src/cli/transform.ts` (glTF-Transform), `src/cli/optimize.ts` (the command).

- **Steps**, in the order glTF-Transform recommends: `dedup` (identical accessors, meshes, materials, textures become
  one), `instance` (repeated meshes → `EXT_mesh_gpu_instancing`), `palette` (materials that differ only by factors
  become one material sampling a nearest-filtered palette texture; textured materials are left alone), `flatten`,
  `join` (meshes sharing a material merge; implies flatten), `weld` (exact duplicate vertices), `simplify`
  (meshoptimizer, ratio and error), `resample` (redundant animation keyframes), `prune` (unused properties),
  `textures` (sharp: WebP or AVIF, longest side, quality), `quantize` (`KHR_mesh_quantization`), `meshopt`
  (`EXT_meshopt_compression`, replaces quantize because it quantizes itself).
- **Presets**: `safe` = dedup, palette, weld, resample, prune (nothing an eye can see changes; the Fox and the
  Buggy e2e assert 0 % pixel difference). `balanced` = safe + quantize + textures webp 2048 px. `aggressive` =
  balanced + simplify 0.5 + textures 1024 px. `--<step>` / `--no-<step>` override a preset; `--simplify`,
  `--textures`, `--compress meshopt` enable their step with the given value. `--instance`, `--join` and
  `--compress meshopt` are never in a preset: the first two change the node graph game code may address by name,
  the third needs `loader.setMeshoptDecoder`. A preset's texture step without `sharp` installed is skipped with a
  note; an explicit `--textures` without it is an environment error (exit 3), as is a Draco input without
  `draco3dgltf`. The output never uses Draco.
- **Inputs and `--out`** (`src/cli/gltf-uris.ts`): every `images[].uri` and `buffers[].uri` of the input (a `.gltf`, or
  a `.glb`'s JSON chunk) must be a `data:` URI or a relative path that stays inside the input's directory, also by real
  path (symlinks followed). An absolute path, any other scheme (`file:`, `http:`, `C:`), a backslash, a NUL or invalid
  percent-encoding exits 2 before glTF-Transform reads anything. `--out` must end in `.glb` or `.gltf` (any case; a
  `.glb` is always written binary) and must not be the input file (same device and inode: a hard link, a symlink, a
  case variant) or one of its resources. A `.gltf` output whose resource URIs would leave its directory, or whose
  resource would land on the input or on one of the input's resources (same path, or same device and inode), exits 2
  before anything is written: glTF-Transform keeps each resource's URI, so a `.gltf` output beside a `.gltf` input
  would rewrite the input's `.bin` and textures. Write it to another directory, or as `.glb`.
- **Report**: `stats.before/after` (bytes, nodes, meshes, primitives, materials, textures, texture bytes, accessors,
  vertices, triangles, animations, skins, morph targets, extensions), one `steps[]` entry per step with the counts
  before and after and the time, `requires[]` (each extension of the output with the loader piece it needs and the
  line of code, `code: null` when `GLTFLoader` handles it alone), and `verify` when on (default): the original and
  the optimized file go through `analyze` with the same framing, frames and views; `verify.parity` compares the two
  naive renders view by view, `verify.original` / `verify.optimized` are the full analyze documents, `verify.delta`
  is after minus before for bytes, materials, vertices, triangles, naive and compiled scene submissions, load time
  and estimated GPU memory.
- **Verdict**: fails on parity over `--parity` (default 0.5 %), a lost animation, skin or morph target (checked in
  the glTF document and, when verified, in what the harness loaded), `--budget` exceeded by the optimized file's
  compiled submissions, an error-severity hint on the optimized file, or a page error in either verified render. Deltas are never judged: a
  palette texture can grow a file that then draws in one call.
- **Limits**: no atlasing across materials that differ by textures (the biome case still needs one batch per
  texture set), no KTX2 encoding (needs `toktx`), no `MSFT_lod` chains, no Draco output.

## 11. Benchmark suite and regression gate

Eight scenes in `test/app/scenes`, each with a naive assembly and an optimized path (`world.compile()` plus the
budgets the scene stresses):

| id | scene | stresses |
|---|---|---|
| `village` | 300 props from 40 shapes, 40 materials, 10 dynamics, 2 skinned | static batching, registry |
| `forest` | terrain, 5 000 trees of 3 species, 2 000 grass patches | instancing, LOD, culling |
| `crowd` | 200 skinned Kenney mini characters, all animating | skinning budget, animated instances |
| `bossfight` | arena, 12 fighters, 16 blocky characters, 30 VFX systems, shadowed lights | overdraw, transparency |
| `lake` | reflective water, 2 000 rain sprites, fog, wet ground | fill rate, weather |
| `daynight` | the village under a sun cycle with a 2048² shadow map | lighting, shadows |
| `zen` | 50 000 low-poly objects over 2 km² on 64 textured ground tiles, 250 m chunks, fog to 600 m | chunk streaming, memory |
| `rpg` | portrait 9:16, one character, gear swapped every 30 frames | character assembler |

`pnpm bench [backend]` measures 10 warm-up and 60 measured frames per variant (medians), one overdraw and memory
measurement, writes `bench/results/local.<backend>.json` and fails when any deterministic metric (submissions, GPU
draws, triangles, programs, overdraw, skinned vertices, shadow casters and texels, memory bytes) is worse than
`bench/baselines/<backend>.json` by 10 % or more; timing is recorded and gated only with `FORGE_GPU=native` (CI
runners render on SwiftShader). `pnpm bench:baseline` promotes results and rewrites `docs/bench.md` and the README
table. Current baselines: village 303 → 28, forest 5 706 → 13, bossfight 2 780 → 424, daynight 605 → 55,
zen 10 879 → 125, rpg 4 → 1, crowd 401 → 17, lake 3 548 → 7.

### Device bench page

`bench-app/` is a static page (`pnpm bench:app` to run it, `pnpm build:bench-app` to build it, the `pages` workflow
deploys it to GitHub Pages) that runs the same eight scenes on the visitor's device. It imports `BENCH_SCENES`
unchanged (the two scenes that fetch files take their URLs from `BenchContext.url()`, so the page works under a
Pages base path) and `test/app/benchMetrics.ts`, which the CI runner also imports, so the metrics cannot drift.
It picks WebGPU when `navigator.gpu` exists and `renderer.init()` succeeds, else WebGL2 (`?backend=webgl2` forces
it); each scene gets a fresh registry and ledger, runs 10 warm-up and 60 measured frames with the deterministic
clock, one overdraw measurement, then `decompile()` and disposal of every geometry, material and texture before
the next scene, so phones do not run out of GPU memory. A two-second fill-rate probe (transparent fullscreen layers,
doubled until a frame misses vsync) is reported as `env.fillRateGPix`, informational. The result
(`{ schemaVersion: 1, kind: 'device', id, createdAt, env, scenes }`, `scenes` identical to a `pnpm bench` result)
is submitted as a prefilled GitHub issue (metrics travel as arrays in `metricKeys` order to keep the URL short; a
copy-and-paste fallback uses the issue template). `scripts/bench-ingest.mjs` extracts the JSON fence, expands the
wire form, validates it with `scripts/bench-schema.mjs` (exact key sets, finite non-negative numbers, capped
strings, known scenes, `unattributed === 0`), writes `bench/devices/<id>.json`; `scripts/bench-devices.mjs`
rewrites `docs/devices.md` and `bench/devices/index.json` (served as `devices.json` on the page). The
`bench-results` workflow runs on issues titled `bench:` or labelled `bench-result`, commits, and closes the issue
with the file name; a rejected result gets the validation errors as a comment. Device numbers are published, never
gated.

## 12. Development, tests, CI, release

- `pnpm dev` opens the harness (`test/app`, `window.__forge`) with query parameters: `scene=naive|field|character|
  gltf&asset=<name>|biome|arena|empty|vat` (the animated-instances twin of `asset`; `vatClip`, `vatTime`) or a
  bench scene with `variant=naive|optimized`, `backend`, `compile=1`,
  `overlay=1&budget=30`, `animate=1`, `dynamics=batch-sync`, `lod=1`, `chunk=40`, `culling=linear`, `threshold=N`,
  `occlusion=1`, `wall=1`, `shadows=0`, `freeze=1`, `materials=keep`, `nested=per-pass|reuse-main`, `bake=1|buried`, `env=0`,
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
- On WebGPU a batch whose index rows change after a pass recorded its draw (a reflection or shadow map rendered from
  inside that pass re-culls it) draws that pass with the new rows, and on WebGL the receiver that triggered a shadow
  map draws the shadow camera's list: batches and compacted instanced meshes keep the enclosing rows as a stable
  prefix (section 7). An instance matrix buffer above the uniform-buffer limit is one `InstancedInterleavedBuffer`
  per mesh, synced once per frame per render object (`nodes/accessors/Instance.js`), and `Geometries.updateAttribute`
  checks it at most once per `info.render.calls`, which a nested render advances and nothing restores: a mesh a
  nested pass reaches first is compacted for the main camera before that pass draws it.
- `renderer.compileAsync()` calls the scene's `onBeforeRender` but never its `onAfterRender`: `warmup({ mode: 'async' })`
  resets the pass tracker afterwards so the warm-up frame counts as an outermost render.
- Transmissive materials cannot be batched (thickness scales with the object matrix); reflectors fill their target
  one frame late; `KTX2Loader` needs `detectSupportAsync(renderer)`; `RenderObject.getDrawParameters()` returns null for
  a zero-instance InstancedMesh (no draw, no count); `ShaderMaterial` does not render on `WebGPURenderer`.
- Half-float render targets read back as raw 16-bit halves on both backends, and WebGPU returns rows padded to 256
  bytes: the overdraw target uses 32-texel row multiples and decodes halves.
- three's experimental `SceneOptimizer` batches everything including skinned meshes and disposes shared geometry; it
  was measured as the spike baseline (`docs/spike-scene-optimizer.md`) and not used.
- After `onBeforeRender`, `_renderObjectDirect` refreshes geometry attributes, nodes and bindings only when
  `needsRefresh()` says the render object is new this frame; a second render object of the same object (a
  reflection pass) gets a shared refresh without attribute uploads. Attributes written in a hook for a nested
  pass are therefore what the main pass draws: sprite batches fill their instance attributes once per frame, for
  the main camera, and nested passes reuse that list (the lake's raindrops stayed at 0.3 % pixel difference only
  after this).

## 14. Limits and roadmap

Overdraw modules shipped in 0.4.0, per-frame JS (freezing, `markDirty`, `RenderScheduler`) in 0.5.0, lighting
(`DayNight`, `ShadowBudget`, lightmap path) in 0.6.0 and skinning (`bakeAnimationTexture`, `AnimatedInstances`)
in 0.7.0 (section 7); animated instances play one clip per instance without blending or root motion; soft-particle materials are documented, not built (`docs/vfx.md`); cascaded
shadow maps (three's `CSMShadowNode`) are not wired yet; per-frame JS (`RenderScheduler`, static-subtree matrix
freezing) is SP6; memory and load (`createLoader`, `ResourceTracker`, chunk `Streamer`) shipped in 0.8.0 (section 7):
the Streamer keeps CPU copies and re-uploads, it does not fetch chunk data on demand (that needs incremental compile);
`threeforge optimize` shipped in 0.3.0 (section 10) and the device bench page with GitHub-native results is in
section 11. Specs live in `docs/superpowers/specs`, plans in
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
