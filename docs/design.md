# threeforge design (Phase 1)

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
| batchStatics | `src/compiler/batchStatics.ts`, `geometryCompat.ts` | one `BatchedMesh` per material variant / attribute signature / shadow flags |
| World | `src/compiler/World.ts` | `compile()`, `decompile()`, `resolve()`, `warmup()` |
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

`decompile()` reverses all of it; `resolve(hit)` maps a `batchId` back to the original mesh.

## Test scene arithmetic

500 props over 12 primitives (four are non-indexed), 40 recipes: 24 solid colours (merge into one batch via
per-instance colour), 4 roughness/metalness pairs, 6 textured, 2 map + normalMap, 4 transparent (2 opacities).
490 static, 10 dynamic, plus a ground plane and two skinned dummies.

| | scene submissions |
|---|---|
| naive | 503 |
| compiled | 15 batches + ground + 10 dynamic + 2 skinned = 28 |
| with shadows on, compiled | 28 main + 27 shadow = 55 |

Pixel parity is asserted against `test/e2e/__screenshots__/naive-webgl2.png` before and after compile.

## Known limits (Phase 1)

- The ledger reports the last completed frame; two top-level `render()` calls per frame produce two frames.
- Skinning, morphing and shadow receiving are object-level program variants the material key does not see.
- Interleaved attributes and per-instance uniforms other than colour are not handled.
- Untagged meshes are never batched under the default policy; `policy: 'auto'` batches them.
- Phase 2 adds BVH culling (`bvh.js`), spatial chunks, dynamic-in-batch matrix sync and repeated-geometry instancing.
