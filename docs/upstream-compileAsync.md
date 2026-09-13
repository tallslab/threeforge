# three r186: `Renderer.compileAsync()` mis-compiles two-pass materials

Minimal repro and suggested fix for an upstream three.js issue found while dogfooding threeforge. Both backends
(`WebGPURenderer` with WebGPU or the WebGL2 fallback) are affected.

## Symptom

After `await renderer.compileAsync(scene, camera)`, transparent double-sided materials and transmissive materials
render differently from a cold first frame, and stay that way. `material.needsUpdate = true` does not repair it;
`material.dispose()` does.

| content | pixels changed by compileAsync |
|---|---|
| Khronos `CommercialRefrigerator` (glass door, `transmission: 1`, `DoubleSide`) | 8.9 % |
| Poly Haven `fir_sapling_medium` (alpha-blended `DoubleSide` foliage, 1.5 M triangles) | 0.63 % |

## Repro

Both cases are in this repo's harness (`pnpm assets` downloads the models):

```bash
pnpm exec playwright test test/e2e/warmup.spec.ts   # passes only because warmup() avoids compileAsync
```

In the page (`?scene=gltf&asset=CommercialRefrigerator` or `asset=polyhaven-fir_sapling_medium&compile=1`):

```js
const f = window.__forge;                       // scene, camera, renderer (WebGPURenderer)
await f.renderer.compileAsync(f.scene, f.camera);
await f.frameAsync();                           // now differs from a frame rendered without the compileAsync
```

A two-quad scene (`MeshStandardMaterial`, `transparent`, `opacity: 0.5`, `DoubleSide`) did **not** reproduce a
visible difference on either backend, so the exact trigger is narrower than "any transparent double-sided
material"; the two assets above reproduce it every time (measured with `test/e2e/probe`-style screenshots).

## What is observably different after compileAsync

Captured by wrapping `renderer._objects.get` and comparing each render object built during `compileAsync`
with the one rebuilt after `material.dispose()`:

- Transparent `DoubleSide` (foliage) and transmissive `DoubleSide` (glass): the render object for the
  `'backSide'` pass id, and the default pass one, have the fragment shader of a `DoubleSide` build
  (`normal * (gl_FrontFacing ? 1 : -1)`), while a real frame builds the back pass as `BackSide`
  (`normal * -1`) and the front pass as `FrontSide`. Cause: `Renderer.renderObject()` renders such materials
  in two passes and flips `material.side` to `BackSide` then `FrontSide` around each
  `this._handleObjectFunction(...)` call (`_renderTransparents()` does the same for transmission). During a real
  render that function is `_renderObjectDirect`, which builds while `side` is set. During `compileAsync()` it is
  `_createObjectPipeline`, which only queues a work item; the items are processed after `renderObject()` has
  restored `side = DoubleSide`.
- Transmissive material: the transmission sample's viewport texture binding points at a different
  `FramebufferTexture` (`ViewportTextureNode.updateReference()` resolves its reference while
  `this._currentRenderContext` is `null`, because the work items are processed after the compile render context
  has been restored), so the glass samples a texture that no real frame copies into. This is the large (8.9 %)
  difference; `material.needsUpdate` does not replace the binding because the render-object cache key is
  unchanged.

The render objects are cached per (object, material, render context, lights, pass id) and are only replaced when
`material.version` changes *and* the cache key differs; hence `needsUpdate` cannot fix the second defect and
`dispose()` (which drops the render objects) fixes both.

## Suggested fix

In `_createObjectPipeline`, snapshot the state that `renderObject()` sets around the call and restore it while the
work item is processed: at minimum `material.side` (store it on the item; set it back before `_objects.get` and
`_nodes.getForRenderAsync`, restore afterwards) and `this._currentRenderContext` (the item already carries
`renderContext`; assign it to `this._currentRenderContext` for the duration of the item). Alternatively build the
render object synchronously inside `_createObjectPipeline` (as `_renderObjectDirect` does) and only defer the
pipeline promise.

## Workaround (threeforge)

`world.warmup(renderer, camera)` renders one real frame under a 1x1 scissor instead of calling `compileAsync`;
`mode: 'async'` calls `compileAsync` and then disposes and rebuilds the affected materials (transparent
`DoubleSide` without `forceSinglePass`, and anything with `transmission`, `transmissionNode` or `backdropNode`).
