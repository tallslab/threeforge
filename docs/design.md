# threeforge design

Phases 1 to 6 built the draw-call category and are recorded first. The frame-budget work that followed (0.2.0 to
0.8.0) organised the library by cost category; the decisions each of those sub-projects made are recorded under
"Sub-project design notes" at the end. `docs/threeforge.md` is the reference for every option named here.

## The problem

A three.js scene assembled the obvious way costs one draw call per mesh, and loaders hand you a fresh material per
mesh even when they are identical by value. `BatchedMesh` and the experimental `SceneOptimizer` addon exist, but
nothing classifies a scene, applies batching with safe defaults, keeps it reversible, and explains what is left.

## Modules

| module | file | job |
|---|---|---|
| MaterialRegistry | `src/registry/MaterialRegistry.ts`, `materialKey.ts` | dedup materials by value; program / variant / colour keys; stats |
| DrawCallLedger | `src/ledger/DrawCallLedger.ts`, `reasons.ts`, `names.ts`, `snapshot.ts`, `expectedDraws.ts` | attribute every render item to a reason; reconcile with `renderer.info`; pooled records and cached display names keep the per-submission path allocation-free |
| classify | `src/compiler/classify.ts` | per-mesh decision with the rule that fired |
| batchStatics | `src/compiler/batchStatics.ts`, `geometryCompat.ts` | one `BatchedMesh` per material variant / attribute signature / shadow flags; large single-geometry groups become `InstancedMesh` |
| culling | `src/compiler/culling.ts` | BVH per-instance frustum culling hook for `BatchedMesh` (bvh.js); `prependRenderHook` |
| instancing | `src/compiler/instancing.ts` | `InstancedMesh` with BVH-driven compaction of visible instances |
| World | `src/compiler/World.ts` | `compile()`, `decompile()`, `resolve()`, `setVisible()`, `warmup()`, dynamic batch-sync, occlusion proxies |
| lod | `src/lod/generateLods.ts` | `generateLods` / `prepareLods` / `lodsOf` on meshoptimizer (node and browser) |
| character | `src/character/assembleCharacter.ts` | one skinned mesh + one atlas for a body and its gear; equip/unequip rebuild vertices only |
| overlay | `src/overlay/index.ts` | dev panel driven by `ledger.frame()` |

## Material keys

`programKey` mirrors what three's `RenderObject.getMaterialCacheKey()` looks at: type, `customProgramCacheKey()`,
which texture slots are set (plus mapping, channel, colour space), booleans, state enums (side, blending, depth,
stencil), feature gates as 0/non-0 (transmission, clearcoat, sheen, alphaTest), defines, node cache keys.
`variantKey` adds every uniform value and texture identity/transform/sampler state. `colorKey` is `color` alone,
because colour is the only per-instance property `BatchedMesh` offers. Same variant, different colour: one batch.

`ShaderMaterial`/`RawShaderMaterial` cannot render in `WebGPURenderer`; they are reported as `unsupported`.
Keys are computed at registration; a material mutated later is not re-keyed.

## Ledger mechanics (three r186 facts this depends on)

- Every render-object function three installs, including `ShadowNode`'s, ends in `renderer.renderObject(...)`.
  The ledger replaces `renderObject` and `render` on the renderer **instance** and never touches
  `setRenderObjectFunction`, which `ShadowNode` swaps and restores every shadow pass.
- `renderAsync` (deprecated since r181) needs no patch of its own: the ledger leaves it alone, and a unit test checks
  three's source for that. The mechanism is stated once, in `docs/threeforge.md` section 4 ("How it hooks in").
- The outermost `render()` is a frame; nested `render()` calls are passes. A pass is `shadow:<light>` when its
  camera is a light's shadow camera, `override` under `scene.overrideMaterial`, `fullscreen` for non-Scene roots
  (post-processing quads), `main` for the frame's first Scene, `scene:<name>` for further scenes.
- Expected GPU draws are computed **after** the original `renderObject` returns, because `BatchedMesh` fills
  `_multiDrawCount` inside its own `onBeforeRender`.
- `renderer.info.render.drawCalls` is sampled as a delta inside the `render` wrapper, so `info.autoReset`
  running on three's own animation loop cannot skew it. (`info.render.calls` is cumulative in this renderer.)
- three renders the scene into an internal framebuffer target and blits through a `QuadMesh` named
  "Output Color Transform". That quad is not in the user's scene, so it is `renderer-internal` and excluded from
  `sceneSubmissions`.

## Compile pipeline

1. `classify()` updates world matrices and decides per mesh: skinned, morph, shader-material, dynamic tag
   (own or ancestor), exclusion rules (invisible, an invisible ancestor, an invisible material, multi-material,
   layers, renderOrder, the nearest ancestor Group's non-zero renderOrder, an enabled ClippingGroup ancestor at any
   depth, own onBeforeRender, drawRange, frustumCulled off, negative determinant), static tag, or `auto` policy,
   else `untagged`.
2. Statics are grouped by `(variantKey, attribute signature, castShadow, receiveShadow)`. Non-indexed geometries
   get a sequential index on a clone (`ensureIndexed`), originals untouched. Groups of one stay plain meshes.
3. Each group becomes a `BatchedMesh` at the scene root: buffers sized from unique geometries, world matrix and
   colour per instance, a white clone of the canonical material, `sortObjects` only for transparent batches,
   bounds precomputed, shadow flags copied.
4. Originals move to layer 31 with `matrixAutoUpdate = false` (default) or are detached (`originals: 'detach'`).
   Parent links and mixers keep working; default cameras and raycasters no longer see them.
5. Every remaining single-material mesh gets the registry's canonical material.
6. Excluded statics are annotated in the ledger so their submissions read `excluded:<rule>`.

`decompile()` reverses all of it; `resolve(hit)` maps a `batchId` (or a compacted `instanceId`) back to the original mesh.

## Phase 2: culling, instancing, dynamics

- **BVH culling** (`culling: 'bvh'`, default). `attachBvhCulling` installs an own-property `onBeforeRender` on each
  batch that mirrors three's implementation exactly (same arrays, same sort, same wireframe/byte handling) but
  queries a `bvh.js` tree of instance boxes instead of scanning every instance, then applies three's own sphere test
  to the candidates. Result: a subset of the linear scan, never a superset. Array cameras and reversed depth fall
  back to the prototype. Hooks are marked with `FORGE_HOOK` so the ledger does not report them as custom hooks.
  Measured: 20k instances, linear scan vs BVH, BVH more than 2x faster in node; on the real renderer the field
  scene renders in 9 ms instead of 44 ms of CPU per frame.
- **Instancing** (`instanceThreshold`, default 64). Inside an opaque group, a geometry repeated at least the
  threshold becomes an `InstancedMesh`. `InstancedMesh` has no per-instance culling, so `createCulledInstancedMesh`
  keeps master matrix/colour arrays, queries a BVH each cull, copies the visible instances to the front of
  `instanceMatrix`/`instanceColor` and sets `count`. It re-uploads only when the visible set changes. Hit
  `instanceId`s are compacted indices; `visibleIds` maps them back. Transparent groups are never instanced (no
  per-instance sort). Field scene: 3892 draw commands become 4.
- **Dynamic batch-sync** (`dynamics: 'batch-sync'`). Tagged dynamics that pass every batch rule join batches as
  instances and stay hidden with `matrixAutoUpdate` on. A pre-render hook compares each synced `matrixWorld` with
  the last copy (16 floats) and, on change, writes it into the batch (`setMatrixAt` + BVH `move`) or the instanced
  master. The batch's own `frustumCulled` is turned off because a mover can leave the precomputed bounds. Colour
  changes are not synced. Naive scene: 28 becomes 18 submissions, and the compiled screenshot stays within 0.2 % of
  the naive render's pixels (`compile.spec.ts`: `maxDiffPixelRatio: 0.002` at Playwright's default colour threshold).
- **`setVisible(original, bool)`** routes to `setVisibleAt` on batches, the visibility mask on instanced meshes,
  or `visible` on plain meshes.
- **LOD** (`lod: { distances }` after `await prepareLods(scene, { ratios })`). Levels are generated with
  meshoptimizer: vertices are welded by position first (so seams and non-indexed triangle soups get topology),
  `simplify` runs against an error budget, and low-poly meshes that stall fall back to `simplifySloppy`; unused
  vertices are compacted away. Levels never grow. At compile time a batch adds every level as extra geometry
  ranges and the BVH culling hook picks the range by camera distance per instance (`levelFor`), so no per-instance
  state changes and raycasting keeps the full-detail geometry. An instanced group becomes one `InstancedMesh` per
  level; the shared cull partitions visible instances by distance into the level buffers, recomputed only when
  the camera state or the master data changed. Field scene: 140,589 rendered triangles become 51,517 with the
  same instances drawn. Batches need `culling: 'bvh'`; shadow cameras pick levels by their own distance.
- **Occlusion** (`occlusion: true`). One proxy box per batch or instanced group, drawn after the opaque pass
  (`renderOrder 1`) with colour and depth writes off and `occlusionTest` on. The proxy's own `onAfterRender`
  hook asks `renderer.isOccluded(proxy)`, which must run inside `renderObject()` while the main render context is
  current (the scene-level hook fires after three restores the outer context and sees nothing), and toggles the
  targets' `visible` for the next frame. It does so in the outermost render only: nested passes never change it.
  Query results resolve asynchronously, two renders late at best, so a reveal can pop. A query cannot see its target
  from inside the box or past a near plane that cuts the box, so for such a render the proxy's `onBeforeRender` turns
  its `occlusionTest` off (no query, so no late answer) and the hook shows the targets. `warmup()` issues no query
  either: its 1×1 scissor would make every query count nothing. Batches holding batch-synced movers get no proxy
  (`report.occlusion.skippedSynced` counts them). One outermost camera per frame is assumed. Works on both backends
  (WebGL `ANY_SAMPLES_PASSED`, WebGPU query sets). Cost: one
  cheap submission per target, reported as `occlusion-proxy`; it pays when targets are heavy, so pair it with a
  `chunkSize` that keeps chunks large. Measured: naive scene chunked at 40 units with a wall over half the field,
  60 batch submissions become 28. Per-instance occlusion is not possible; level meshes share one proxy.
- **Spatial chunks** (`chunkSize`). Each material group is split by world-space cell (floor of the instance
  position over the cell size on all three axes). Every chunk batch gets tight bounds, so three's whole-object
  frustum test rejects entire cells before per-instance culling runs, and a cell is a natural unit to add or
  remove when streaming. Cells with a single mesh stay plain meshes. Off by default: with BVH culling the win is
  streaming granularity, not culling.

## Test scene arithmetic

500 props over 12 primitives (four are non-indexed), 40 recipes: 24 solid colours (merge into one batch via
per-instance colour), 4 roughness/metalness pairs, 6 textured, 2 map + normalMap, 4 transparent (2 opacities).
490 static, 10 dynamic, plus a ground plane and two skinned dummies.

| | scene submissions |
|---|---|
| naive | 503 |
| compiled | 15 batches + ground + 10 dynamic + 2 skinned = 28 |
| compiled, `dynamics: 'batch-sync'` | 15 batches + ground + 2 skinned = 18 |
| with shadows on, compiled | 28 main + 27 shadow = 55 |
| field scene, 20k instances, naive | 3892 (frustum-visible meshes) |
| field scene, compiled | 3 instanced meshes, 4 draw commands, ~3896 instances drawn |

Pixel parity is asserted against `test/e2e/__screenshots__/naive-webgl2.png` before and after compile.

## Phase 4: character assembler

`assembleCharacter({ skeleton, wardrobe, equipped })` is the PolyMorph lesson as a library feature. Every part
is a `SkinnedMesh` with its own `Skeleton` instance (the way per-part exports arrive); parts are matched to the
live rig **by bone name**, so bone order may differ per part, and a part naming a bone the rig lacks is rejected
with the bone names. The wardrobe's textures (or plain colours for parts without a map) are packed once into a
square grid atlas (`k = ceil(sqrt(parts))` cells), DataTextures resampled in pure JS (works in node) and other
images through `OffscreenCanvas`. The merged geometry concatenates position/normal/uv/skinIndex/skinWeight and
indices; UVs are clamped to [0, 1] (three's `SphereGeometry` emits slightly negative pole U) and mapped onto
each cell's texel centres with a half-texel inset so linear filtering never bleeds across cells. Skin indices
are rewritten through the bone map. The result is one `SkinnedMesh` bound with the body's bind matrix to the
shared skeleton; rig roots parented under a part are re-parented under it so the parts can leave the scene.
`equip()` / `unequip()` rebuild the geometry and dispose the old one; the mesh, material, atlas and skeleton
never change, so the draw count cannot. Limits: one colour map per part (normal/roughness maps are not
atlassed), UVs outside [0, 1] are clamped rather than wrapped, and parts must share the body's bind pose.
Measured: body + 4 gear = 5 skinned submissions become 1 on both backends, pixel parity within 1%.

## Phase 5: public asset dogfooding

`pnpm assets` downloads about 570 MB of CC0/permissively licensed test content into the gitignored
`test/assets/files/`: 89 Khronos and three.js sample models (CAD assemblies, Sponza, animated Draco scenes, skinned
and morphing characters, every material-extension test), five Kenney kits (594 low-poly GLBs sharing palette
textures), fourteen Poly Haven hi-poly props, the three.js Ferrari and water normals. `pnpm assets:report` loads
every model into the harness (`scene=gltf&asset=<name>`, Draco + meshopt + KTX2 loaders, room environment,
camera fitted to the bounds, animations posed at 0.7 s), renders it naively, compiles it with `policy: 'auto'`
and `animations: gltf.animations`, compares the two renders pixel by pixel, decompiles, and writes
`docs/assets-report.{md,json}`. `scene=biome` assembles a stress scene from the kits: a 65k-vertex vertex-coloured
heightfield, three's TSL `WaterMesh`, ~8,000 scattered nature props, a suburban block with roads, 41 dynamic cars
plus the Ferrari, and a few hi-poly rocks and saplings.

What the assets taught the compiler (each became a rule or a fix):

- **Animated nodes** (`animations` option): any node targeted by a clip, with its descendants, is dynamic under
  `policy: 'auto'`; otherwise LittlestTokyo's trains and cars would have been frozen into batches.
- GPU-instancing extension: meshes that are already `InstancedMesh` are excluded (`already-instanced`).
- Transmission: three derives volume thickness from the object matrix's scale; a batch or an instanced mesh
  presents one matrix for all instances, so a whole row of AttenuationTest cubes rendered wrong. Materials with
  `transmission > 0` are excluded (`transmission`).
- Reflections and other nested renders: the ledger names a nested render of the main scene
  `nested:<target>` instead of folding it into `main`, so water reflection cost is visible (the biome's reflection
  pass adds ~3,700 submissions to a 17,000-submission frame).
- Harness, not library: three's reflector fills its render target one frame late, so parity captures need a
  warm-up frame; Playwright restarts its worker after a failing test, so per-asset report rows are merged on disk.
- Lone meshes under `policy: 'auto'` are annotated `unique-material` rather than `untagged`.

Biome on the WebGL2 backend: 20,943 naive submissions (17,191 main + reflection pass) become 443 with
`dynamics: 'batch-sync'`, 20.4 M triangles, 30,731 instances of which 20,943 are drawn, 0.00 % pixels changed.
The same scene on the native WebGPU backend matches at 0.00 % too, after two backend-specific findings:

- **Nested passes on WebGPU** (`nestedPasses`, default `auto`, now `per-pass` on both backends). When a
  `BatchedMesh` or a compacted `InstancedMesh` changes its visible set twice in one frame (the main pass culls it,
  then the water's reflection, rendered from inside the main pass, culls it again), the main pass on the WebGPU
  backend draws with the nested pass's instance list: every prop scatters. Pure three `BatchedMesh` with its own
  culling shows the same. Every material of a batch reads one index texture (`nodes/accessors/Batch.js`),
  `queue.writeTexture` lands at once, and the main pass is submitted only in `finishRender`. The first fix,
  `reuse-main` (nested passes draw the main camera's list), hid a second case: shadow maps render from inside the
  first receiver's draw too, and under `reuse-main` they lost every caster outside the view (on the audit scene the
  WebGPU `shadow:sun` pass issued 255 GPU draws where the naive scene issues 502, with 247 of 441 batched casters
  missing); under `per-pass` on WebGL that receiver drew the shadow camera's list. Batches now keep a **stable
  prefix**: a nested pass leaves the rows an open enclosing pass recorded untouched, zeroes the counts of those its
  camera does not need, appends what it lacks, and the counts come back when the nested render ends
  (`PassTracker`, scene hooks). The policy only decides a batch no open pass has culled yet (`per-pass`: a fresh
  cull; `reuse-main`: append to its last outermost rows).
  Compacted instanced meshes keep a stable prefix as well, under either policy. Their matrices above the
  uniform-buffer limit sit in one vertex buffer synced once per frame per render object, and three checks it for
  upload at most once per render call, a count every nested render advances: a pass that rewrites rows after a
  nested render drew the mesh cannot upload them (under the old WebGL2 `per-pass` the 1,500-box field of
  `test/e2e/nested-passes.spec.ts` differed in 17.0 % of its pixels when the ground received shadows first, and in
  15.5 % when the boxes did, their main pass drawing the spot light's list). So a nested pass that reaches a mesh first compacts it for the main camera, a
  shadow pass appends the casters of its own light (every light is queried once per frame into one list that records
  which lights reach each caster, and a pass appends its own light's entries in that list's order, so a tail that
  already holds them, a point light's six faces or a set that is a prefix of the pass before, is not rewritten),
  and reflections draw the main list: they may miss instances outside the main frustum.

  | Nested pass | Batch `per-pass` | Batch `reuse-main` | Instanced mesh (either policy) |
  |---|---|---|---|
  | an open pass culled the object | keep, zero, append | keep, zero, append | shadow: keep, append casters; other: keep |
  | no open pass culled it | fresh cull | append to last outermost rows | compact for the main camera, then as above |
  | outermost render | fresh cull | fresh cull | compact (cached by view) |
- **`compileAsync` mis-compiles two-pass materials.** In three r186 `Renderer.renderObject()` renders a
  transparent `DoubleSide` material twice, flipping `material.side` to `BackSide` then `FrontSide` around each
  `_handleObjectFunction` call (`_renderTransparents()` does the same for transmissive `DoubleSide`). During
  `compileAsync()` that function only queues work items; they are built after `side` is back to `DoubleSide`
  and after `_currentRenderContext` is null again. So both passes compile as single-pass DoubleSide (normals by
  `gl_FrontFacing`, no culling: every face blended twice), and transmission's viewport texture node resolves a
  framebuffer texture that no frame ever writes. The render objects are cached per pass and `material.needsUpdate`
  does not replace them (same cache key); only `material.dispose()` does. Measured: CommercialRefrigerator's
  glass 8.9 % of pixels, `polyhaven-fir_sapling_medium`'s 1.5 M-triangle alpha-blended foliage 0.63 %; batching
  itself was pixel-exact all along (a hand-built `BatchedMesh` of the same leaves matched to 0.00 %).
  `world.warmup()` therefore renders one real frame under a 1x1 scissor by default (same total cost, exact
  pipelines), and `mode: 'async'` runs `compileAsync` then disposes and rebuilds the affected materials.
  The bug hid on WebGL2 at first because shadow maps and the transmission backdrop re-render only once per node
  frameId, which advances only on animation-frame ticks; frames separated by `frameAsync()` expose it.
  Upstream repro and suggested fix: `docs/upstream-compileAsync.md`.

Public asset report: 104/104 clean on both backends (0 unattributed draws, < 0.5 % pixels changed, decompile
restores the naive count).

## Phase 6: game content (combat, lighting, VFX, animation)

`scene=arena` builds a fight arena from CC0 game packs: Kenney mini characters (skinned, 32 clips including
melee and kick attacks, cross-faded at a deterministic time), blocky characters (rigid hierarchies animated by
node tracks), weapons parented under hand bones, arena and dungeon props, two shadowed spot lights and a
shadowed point light plus torches, and VFX: additive particle systems (`Points` with dynamic positions), health
and hit sprites, a sword trail with dynamic geometry, floor decals, a flipbook quad, and optional bloom
post-processing (`bloom=1`) and per-fighter character assembly (`assemble=1`).

Rules and fixes this content produced:

- **Bone-parented meshes are dynamic** whatever their tag: a weapon in a hand moves with the rig. With
  `dynamics: 'batch-sync'` they join batches and follow the bone through matrix sync (121 synced objects in the
  arena: 12 weapons, 96 blocky body parts, torches).
- Dynamic geometry is never batched: attributes with `DynamicDrawUsage` / `StreamDrawUsage` (trails,
  ribbons, particle positions) mark a mesh `excluded:dynamic-geometry`, since a batch copies vertices once.
- Animations resolve per root: many characters share bone and node names, and three resolves track names
  by first match, so `animations` accepts `{ root, clips }` entries, one per animated character.
- **Points, sprites and lines get their own ledger reasons** instead of `untagged`; the compiler never touches them.
- **Batches share the canonical material when every instance is white**, so runtime uniform changes (emissive
  flicker, opacity, texture offsets) keep propagating; a white clone with per-instance colours is used otherwise.
- Zero-instance draws cost nothing: `RenderObject.getDrawParameters()` returns null for an instanced object
  with no instances, so both backends skip it; the ledger's cost model does the same (it showed up as
  `unattributed: -2` in the point light's shadow pass).
- Shadow maps render once per animation frame: `ShadowNode` gates on three's node `frameId`, which only
  advances on animation-frame ticks, so several `render()` calls in one task show shadow passes only on the first.
  The harness's `frameAsync()` yields to an animation frame before rendering; apps that render on demand should
  expect the same.

Arena on both backends: 2,756 naive submissions (761 main, 611 and 609 for the spot shadows, 776 for the point
light's six faces) become 400 (120 main, 53, 53, 175) with 0.01 % pixels changed, 0 unattributed, and the
fighters still animating afterwards.

## WebGPU in the test harness

WebGPU only exists in secure contexts, so adapter checks must run on the served page, not `about:blank`. The
`webgpu` Playwright project uses the native adapter through the full Chromium build by default on macOS/Windows
(`--enable-unsafe-webgpu`), where the entire suite passes including pixel parity against
`naive-webgpu.png`. On Linux it falls back to Dawn's SwiftShader adapter in the headless shell
(`--use-webgpu-adapter=swiftshader --enable-unsafe-swiftshader`); that adapter renders correctly but drops the
WebGPU instance when a page idles between test steps ("Device Lost", after which `render()` draws nothing) and
during screenshots, so multi-step specs and pixel checks are skipped there. Measured on the real WebGPU backend:
the naive scene compiles to 28 submissions with 504 GPU draws (one per batched instance) and 0 unattributed,
confirming the backend cost model the ledger uses.

## Known limits (Phase 1)

- The ledger reports the last completed frame; two top-level `render()` calls per frame produce two frames.
- Skinning, morphing and shadow receiving are object-level program variants the material key does not see.
- Interleaved attributes and per-instance uniforms other than colour are not handled.
- Untagged meshes are never batched under the default policy; `policy: 'auto'` batches them.
- Instanced meshes are re-compacted for every camera that renders them (a shadow pass costs a second upload).
- `culling: 'linear'` only affects batches; instanced meshes always use BVH compaction (it is their only culling).
- Real game scenes decide what the ledger flags next.

## Sub-project design notes

Each note records what a sub-project chose, what it rejected and the numbers that resulted. The version is the
release that shipped it; where a later release changed a decision, the note says so.

### Frame budget and ledger v2 (0.2.0)

A tool for every genre has to own the whole frame: a forest cut from 400 calls to 30 still drops frames on a phone
because of fill rate, and a VFX-heavy fight is killed by overdraw. The library is therefore organised by cost
category and the ledger measures all six in one snapshot: draw calls, overdraw, skinning, lighting, per-frame JS
and memory. The ledger is the product; every module built after 0.2.0 had to move a benchmark scene's numbers,
which is why the benchmark shipped before any of them.

Device tiers replace reference phones: `desktop`, `phone-mid` (iPhone 12/13, Pixel 6 class) and `phone-low`
(Adreno 610, Mali-G52 class), detected at runtime from the GPU string, device memory, cores, touch and platform,
and overridable with `tier`. Every budget keys off the tier (`src/ledger/budgets.ts`): scene submissions
400/150/80, triangles 5 M/1.5 M/500 k, transparent overdraw 3/2/1.5 fragments per pixel, skinned vertices
400 k/150 k/60 k, shadow texels 4 M/1 M/262 k, texture bytes 512/192/96 MB, frame time 16.6/16.6/33 ms.

Overdraw is measured, not estimated: the scene renders twice into a 1/8-resolution half-float target under a
counting override material, once with only opaque and once with only transparent objects, and the red channel
averages to fragments per pixel; it runs on demand, never every frame. Memory is estimated (`estimated: true`)
because three r186 initialises `info.memory.texturesSize` and friends but never writes them; the counts are real
and drive the leak check. The v1 totals stay under `drawCalls` so existing assertions keep working.

Eight benchmark scenes (`forest`, `village`, `crowd`, `bossfight`, `lake`, `daynight`, `zen`, `rpg`) each build a
naive assembly and an optimized one, and each stresses one category. `pnpm bench` runs 10 warm-up and 60
measured frames per variant on both backends and fails when any deterministic metric worsens by 10 % against
`bench/baselines/`; timing metrics are recorded everywhere but gated only on a native GPU, because GitHub runners
render on SwiftShader. Rejected: a hosted results service, per-genre presets, an editor.

### Agent CLI and app hook (0.2.0)

Most people building three.js games now do it with an agent, so the surface is a terminal. `npx threeforge
analyze <file>` renders an asset headlessly in a harness page shipped inside the package, measures, compiles with
`policy: 'auto'`, measures again and compares screenshots. `inspect <url>` drives the agent's own dev server
through `exposeToAgents()`, which publishes `window.__threeforge` and never renders on its own unless the app
handed it renderer, scene and camera; it reports no parity because the CLI does not know the app's camera.
`explain <code>` has a remedy for every hint code (a unit test enforces coverage) and `mcp` wraps the same
functions as a stdio server. Exit codes: 0 pass, 1 verdict failed, 2 usage, 3 environment (the message carries
the install command), 4 the page threw or timed out. Playwright and the MCP SDK are optional peers imported
lazily, so game code importing the library never pays for them.

The bake (`World({ bake })`) shipped with this release. It merges each finished static group into one world-space
mesh, removing contact seams (coplanar islands with identical boundaries and opposite winding), duplicate faces
and, opt-in through `removeBuried`, faces whose sampled front hemisphere is blocked within `distance` (default
0.1, so room interiors survive). The rule it set for everything after it: a wrong deletion is visible and a
missed one is invisible, so every removal is counted in the report and proven by pixel parity on both backends.

### `threeforge optimize` (0.3.0)

The build-time glTF pipeline is glTF-Transform 4.5 in a fixed order (dedup, instance, palette, flatten, join,
weld, simplify, resample, prune, textures, then quantize or meshopt); the value added is the defaults, the
per-step report, the `requires` list of load-time needs and the verification. `sharp` and `draco3dgltf` are
optional peers; a preset's texture step without `sharp` is skipped with a note, so a preset runs everywhere.

The bake's rule applies: the default preset changes nothing an eye can see. `safe` is `dedup`, `palette`,
`prune`, held to 0 changed pixels on the Fox and the Buggy on both backends. `weld` was measured out of it: it
merges only bitwise-identical vertices yet moves up to 0.014 % of the Fox's pixels on WebGPU for a reason not
established. `resample` was measured out for the opposite reason: at tolerance 0 it is pixel-exact but keeps
every non-duplicate keyframe and grew Xbot by 1.2 %. Both ride with the lossy steps in `balanced` (adds quantize
and WebP at 2048 px) and `aggressive` (adds simplify at ratio 0.5 and 1024 px textures); `--weld` or
`--resample` adds either back to any preset. `--instance`, `--join` (which implies flatten) and `--compress
meshopt` are never in a preset: the first two change the node graph game code addresses by name, the third needs
a decoder in the loader. Output is one `.glb` and never uses Draco.

Verification is on by default: the harness renders the original and the output from the default framing plus
`--views` orbit views, the worst per-view difference is the parity (threshold 0.5 %), both files are compiled and
measured, and a lost clip, skin or morph target fails the verdict. Byte, material and vertex deltas are reported,
not judged: a palette texture can grow a file that draws in one call.

### Overdraw modules (0.4.0)

Sprites batch by material. `World.compile()` groups `Sprite` objects sharing registry keys and replaces each group
of at least `spriteThreshold` (default 4) with one instanced quad under a `SpriteNodeMaterial` built from the
`SpriteMaterial`. Sprites are dynamic by nature, so the originals stay and drive the batch: a `FORGE_HOOK` copies
every sprite's world position and scale each frame (an invisible sprite gets scale 0), sorts back to front when
the material blends, and sets `instanceCount`. Sprites with a non-default `center`, `renderOrder`, layers or
their own `onBeforeRender` are skipped with a named rule. Per-sprite colour inside one batch was rejected:
materials differing only by colour stay separate batches. Lake: 3,548 submissions become 7.

`ParticleBudget` caps live particles per tier (60,000 / 15,000 / 5,000): every `Points` object and every sprite
batch is a system, and when their sum exceeds the budget each system's `drawRange` or instance cap is scaled by
the same ratio; `pointSizeScale` (0.75 on `phone-low`) scales `PointsMaterial.size` in place and `release()`
restores it. `ResolutionScaler` trades pixels for frame time: every `window` (20) frames the median frame time is
compared with the tier's `frameMs`; above 1.05 times it the scale drops one step (0.05), below 0.7 times it
rises, clamped to [0.5, 1]. Neither runs in the bench, which keeps a fixed 800 by 600 buffer on the `desktop`
tier where the budgets do not bind. Soft particles and GPU simulation are documented in `docs/vfx.md`, not built.

### Device bench page (0.4.0)

`pnpm bench` runs on SwiftShader or one desktop GPU; the numbers that matter come from phones. `bench-app/` is a
static page that runs the same eight scenes in both variants on the device's best backend and submits the result
as a GitHub issue. One scene registry: the page imports `BENCH_SCENES` unchanged, and `test/app/benchMetrics.ts`
(`WARM`, `MEASURED`, `metricsOf`, `METRIC_KEYS`) is shared with the CI runner so the two cannot drift. `env`
adds a two-second fill-rate probe (transparent fullscreen layers doubled until the frame drops below vsync),
informational only. `scripts/bench-app-assets.mjs` copies what the kit-backed scenes load
(`scripts/bench-app-kits.mjs`) and the textures those GLBs keep outside themselves; `crowd` and `bossfight` throw
on a file the page does not carry, and a run with an uncaptured GPU error (`renderer.onError`) fails instead of
producing a result, so neither a thinner scene nor dropped GPU work is ever measured.

Results are GitHub-native, with no server, no accounts and no secret beyond `GITHUB_TOKEN`: the page opens a
prefilled issue when the encoded URL stays under 7,000 characters and otherwise shows the JSON to copy. The
ingest workflow validates the body with a hand-written validator (exact key sets, known scene ids,
`unattributed === 0`), writes `bench/devices/<id>.json`, regenerates `docs/devices.md` and closes the issue.
Issue text is data: nothing from it is executed or interpolated into a shell. Device numbers are never gated,
and the page is not in the npm package.

### Skinning (0.7.0)

Three skins every `SkinnedMesh` from its own bone texture each frame, so `compile()` cannot touch a crowd.
`bakeAnimationTexture(prototype, clips, { fps: 30 })` plays each clip through a mixer with the prototype at the
origin and copies `skeleton.boneMatrices` (the exact data three uploads) into one row of a float `DataTexture`
per frame. `AnimatedInstances` then draws any number of characters as one `InstancedMesh` per part; the
material's `positionNode` picks the row from a per-instance `(start, frames, offset, speed)` attribute and the
`time` uniform and applies three's own skinning formula with the part's bind matrices. Because
`NodeMaterial.setupPosition` applies the instance matrix before a custom `positionNode` is assigned, the node
multiplies the instance matrix itself and writes the skinned normal to `normalLocal` in place.

Nearest-frame playback is not pixel-identical to mixer interpolation, so the crowd e2e checks motion and a
similarity under 3 %, not parity. Crowd: 401 submissions become 17, skinned vertices 271 k become 0. Rejected:
automatic conversion inside `compile()` (crowds are built explicitly; mixers remain the way to drive individually
controlled characters), cross-fading between clips, and morph targets in the instanced path.

### Lighting and shadows (0.6.0)

A shadow map renders only when `needsUpdate || autoUpdate` (`ShadowNode.updateBefore`), and `updateShadow`
resizes its target from `mapSize` on every update, so a budget can change map sizes at runtime without disposing
anything. `DayNight` adds one directional sun, a gradient sky dome (an inverted sphere with vertex colours,
static, `fog: false`, `depthWrite: false`), a hemisphere light, fog and background from the hour of day; the map
has `autoUpdate = false` and re-renders only when the sun moved `everyDegrees` (default 0.5) since the last
shadow render. A Preetham `SkyMesh` was rejected as a full-screen shader every frame. Day/night: shadow passes
per frame 1 become 0.5, shadow texels 4.19 M become 2.10 M.

`ShadowBudget.apply(scene)` turns shadows off on tiers listed in `off`, drops point-light shadows unless
`pointShadows` (default: only desktop keeps them, six faces each), then halves the largest map while the texel
sum exceeds the tier's budget, never below `minMapSize` (256); `freeze(light)` freezes a static light's map. No
new hint: the ledger cannot tell a static light from a moving one. Lightmaps needed no registry change (it
already keys `lightMap` and `lightMapIntensity`, and the attribute signature includes `uv1`); the bake now
carries and welds every UV set.

### Per-frame JS (0.5.0)

`render()` visits every descendant unconditionally; an object with `matrixAutoUpdate` recomposes and forces its
subtree's world matrices, and `_projectObject` walks every visible descendant per pass, hidden originals
included. So `compile()` freezes statics (`freeze`, default on): every unbatched static mesh and every ancestor
whose subtree is entirely static (no animated node, dynamic tag, light, camera, bone, skinned mesh or sprite)
gets `matrixAutoUpdate = false`. Matrices are current at that moment, so no pixel changes; `decompile()`
restores every flag. `world.markDirty(object)` is the one way to move a frozen static: it recomposes the subtree
and pushes every batched original into its batch, instance buffer or rebake. Dirty flags inside three (prototype
patching) were rejected; apps call `markDirty()` or `invalidate()`.

`RenderScheduler` renders on change: `invalidate()`, a camera matrix change, a watched object, a mixer with
running actions, a buffer resize or `keepAliveMs` (default 0, never). It is not part of the bench because it
changes what a frame is, not what a frame costs; `js.skipped` reports the skipped ticks among the last 60 when
it is attached. `detach-originals` fires at 1,000 hidden originals: `originals: 'detach'` leaves both walks.

### Memory and streaming (0.8.0)

three keeps a GPU copy of every geometry and texture until `dispose()` and only counts them. `createLoader(renderer)`
wires Draco, KTX2 (support detected on the renderer, which `WebGPURenderer` requires) and meshopt in one call
with the addons imported lazily. `ResourceTracker` reference-counts geometries and textures across tracked
owners and disposes on the last release; it never disposes a material the registry knows, because the registry
owns shared materials. `unreferencedResources` is the renderer's counts minus what the scene reaches, with
three's own allocations (frame buffer, shadow maps, PMREM, the DFG lookup, the overdraw count target) allowed by
identity; the `unreferenced-resources` hint fires at 8 or more.

`Streamer` needs `World({ chunkSize })` and decides residency by the distance from the camera to the cell's box
with y ignored: resident within `radius`, unloaded past `radius + margin * chunkSize` (one cell of hysteresis).
`radius` defaults to `camera.far`, so with fog to the far plane nothing visible pops; like the bake, streaming
must not change a pixel at the camera it was updated for. Unload removes the chunk's objects and disposes what no
resident chunk still references; load adds them back and three re-uploads from the CPU copies, so nothing is
re-fetched. `userData.forgeStream = false` opts an object out. Zen: 64 textured ground tiles holding 64 MB of
textures in the naive scene, streamed to the cells within 600 m; 3,540 submissions become 88. Fetching chunk
data on demand is out of scope.
