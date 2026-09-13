# threeforge design (Phases 1 and 2)

## The problem

A three.js scene assembled the obvious way costs one draw call per mesh, and loaders hand you a fresh material per
mesh even when they are identical by value. `BatchedMesh` and the experimental `SceneOptimizer` addon exist, but
nothing classifies a scene, applies batching with safe defaults, keeps it reversible, and explains what is left.

## Modules

| module | file | job |
|---|---|---|
| MaterialRegistry | `src/registry/MaterialRegistry.ts`, `materialKey.ts` | dedup materials by value; program / variant / colour keys; stats |
| DrawCallLedger | `src/ledger/DrawCallLedger.ts`, `reasons.ts`, `snapshot.ts`, `expectedDraws.ts` | attribute every render item to a reason; reconcile with `renderer.info` |
| classify | `src/compiler/classify.ts` | per-mesh decision with the rule that fired |
| batchStatics | `src/compiler/batchStatics.ts`, `geometryCompat.ts` | one `BatchedMesh` per material variant / attribute signature / shadow flags; large single-geometry groups become `InstancedMesh` |
| culling | `src/compiler/culling.ts` | BVH per-instance frustum culling hook for `BatchedMesh` (bvh.js); `prependRenderHook` |
| instancing | `src/compiler/instancing.ts` | `InstancedMesh` with BVH-driven compaction of visible instances |
| World | `src/compiler/World.ts` | `compile()`, `decompile()`, `resolve()`, `setVisible()`, `warmup()`, dynamic batch-sync |
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
  The ledger replaces `renderObject`, `render` and `renderAsync` on the renderer **instance** and never touches
  `setRenderObjectFunction`, which `ShadowNode` swaps and restores every shadow pass.
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
   (own or ancestor), exclusion rules (invisible, multi-material, layers, renderOrder, own onBeforeRender,
   drawRange, frustumCulled off, negative determinant), static tag, or `auto` policy, else `untagged`.
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

## Known limits (Phase 1)

- The ledger reports the last completed frame; two top-level `render()` calls per frame produce two frames.
- Skinning, morphing and shadow receiving are object-level program variants the material key does not see.
- Interleaved attributes and per-instance uniforms other than colour are not handled.
- Untagged meshes are never batched under the default policy; `policy: 'auto'` batches them.
- Instanced meshes are re-compacted for every camera that renders them (a shadow pass costs a second upload).
- `culling: 'linear'` only affects batches; instanced meshes always use BVH compaction (it is their only culling).
- Phase 3 adds LODs (meshoptimizer at build time) and WebGPU occlusion queries.
