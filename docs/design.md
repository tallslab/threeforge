# threeforge design (Phases 1 to 6)

> v2 (frame-budget compiler and benchmark suite) is specified in `docs/superpowers/specs/2026-09-13-frame-budget-design.md`; this document records phases 1–6 (the draw-call category).

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
- `renderAsync` (deprecated since r181) is `await this.init()` followed by `this.render(scene, camera)`, so its frame
  enters the patched `render` once, after the await; the ledger leaves it alone (a unit test checks three's source).
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
  changes are not synced. Naive scene: 28 becomes 18 submissions with the same pixels.
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
- **GPU-instancing extension**: meshes that are already `InstancedMesh` are excluded (`already-instanced`).
- **Transmission**: three derives volume thickness from the object matrix's scale; a batch or an instanced mesh
  presents one matrix for all instances, so a whole row of AttenuationTest cubes rendered wrong. Materials with
  `transmission > 0` are excluded (`transmission`).
- **Reflections and other nested renders**: the ledger names a nested render of the main scene
  `nested:<target>` instead of folding it into `main`, so water reflection cost is visible (the biome's reflection
  pass adds ~3,700 submissions to a 17,000-submission frame).
- **Harness, not library**: three's reflector fills its render target one frame late, so parity captures need a
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
  shadow pass appends the frame's shadow casters of every light in the same rows (a point light's six faces share one
  upload), and reflections draw the main list: they may miss instances outside the main frustum.

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
- **Dynamic geometry is never batched**: attributes with `DynamicDrawUsage` / `StreamDrawUsage` (trails,
  ribbons, particle positions) mark a mesh `excluded:dynamic-geometry`, since a batch copies vertices once.
- **Animations resolve per root**: many characters share bone and node names, and three resolves track names
  by first match, so `animations` accepts `{ root, clips }` entries, one per animated character.
- **Points, sprites and lines get their own ledger reasons** instead of `untagged`; the compiler never touches them.
- **Batches share the canonical material when every instance is white**, so runtime uniform changes (emissive
  flicker, opacity, texture offsets) keep propagating; a white clone with per-instance colours is used otherwise.
- **Zero-instance draws cost nothing**: `RenderObject.getDrawParameters()` returns null for an instanced object
  with no instances, so both backends skip it; the ledger's cost model does the same (it showed up as
  `unattributed: -2` in the point light's shadow pass).
- **Shadow maps render once per animation frame**: `ShadowNode` gates on three's node `frameId`, which only
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
- Phase 5 puts Wanderer on it: real assets will decide what the ledger flags next.
