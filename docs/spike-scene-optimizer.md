# Spike: three's experimental `SceneOptimizer` on the naive scene

Measured 2026-09-13 with three r186, `WebGPURenderer` on the WebGL2 fallback backend in headless Chromium
(`pnpm spike`, `test/e2e/spike-scene-optimizer.spec.ts`).

## Numbers

| Run | Draw calls | Notes |
|---|---|---|
| Naive scene | 504 | 503 visible meshes + 1 renderer-internal output quad |
| `SceneOptimizer.toBatchedMesh()` as authored | crash | `THREE.BatchedMesh: All geometries must consistently have "index".` The four polyhedra are non-indexed; the optimizer does no normalisation. |
| After giving non-indexed geometries a trivial index | 18 | 16 `BatchedMesh` + 1 plain mesh (ground) + 1 output quad |

## What the 18 hides

- **Skinned meshes are destroyed.** Both `SkinnedMesh` dummies were folded into a `BatchedMesh` (it batches everything with `isMesh`), so they render as static cylinders and can never animate.
- **Dynamic props are frozen.** The 10 props tagged dynamic were batched too; `userData` is ignored.
- **Shared geometry is disposed.** The originals' geometries and materials are `dispose()`d even though the 12 base geometries are shared, and the operation is not reversible.
- `castShadow`, `receiveShadow`, `renderOrder`, `layers` and `frustumCulled` differences are ignored when grouping.
- Geometry identity is a byte-by-byte hash of every vertex buffer per mesh (O(total bytes) per compile).

## Conclusion

The count is encouraging: with only 15 real static groups plus ground the floor for statics is 16, and `SceneOptimizer`
reaches it. That validates the per-instance-colour merge (24 solid colours in one batch) and confirms the product is
the classifier, the registry and the ledger rather than novel batching code. We do not depend on `SceneOptimizer`
because it cannot be run on a mixed scene safely; our batcher (`src/compiler/batchStatics.ts`) reuses its two good
ideas (group by material variant, colour per instance) and adds classification, index normalisation, reversibility
and attribution. Target for `world.compile()` on this scene: 15 batches + ground + 10 dynamic + 2 skinned = 28.
