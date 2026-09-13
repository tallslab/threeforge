# threeforge

Scene compiler + draw-call diagnostics for three.js (r186, `three/webgpu` with its WebGL2 fallback).
Three.js stays the renderer. threeforge takes a naively assembled scene, rewrites it into a batched one
at load time, and tells you exactly why every remaining draw call exists.

Status: Phase 6 (dogfooding on public assets and game content: combat animation, shadowed lights, VFX, post-processing). The naive test scene (500 props, 40 material recipes, a new material per prop) goes from
**503 to 28** scene submissions with pixel-identical output (**18** with `dynamics: 'batch-sync'`), and the
20k-instance field scene goes from 3892 submissions to **3 instanced draws** with BVH culling, cutting render CPU
from 43 ms to 7 ms per frame in headless Chromium; LODs cut its rendered triangles from 140k to 51k. Verified on
both the WebGL2 and the WebGPU backend. `pnpm budget` fails CI above 30.

```ts
import { DrawCallLedger, MaterialRegistry, World, prepareLods, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);                      // patches renderObject/render on this renderer instance

tag.static(crate);                            // batched by compile()
tag.dynamic(player);                          // left alone, counted
// Untagged meshes are batched under policy 'auto'; meshes under bones, animated nodes (pass `animations`),
// dynamic geometry, transmissive materials and instanced/skinned/morphing meshes are never batched.

await prepareLods(scene, { ratios: [0.5, 0.2] });   // optional: meshoptimizer LODs per geometry

const world = new World(scene, {
  registry, ledger,
  policy: 'tagged',          // or 'auto' to batch untagged meshes too
  culling: 'bvh',            // per-instance frustum culling on every batch (bvh.js)
  instanceThreshold: 64,     // geometry repeated this often becomes a culled InstancedMesh
  dynamics: 'batch-sync',    // tagged dynamics ride in batches; their matrices sync each frame
  lod: { distances: [200, 600] },
  chunkSize: 250,            // optional: one batch per world-space cell (streaming, tight bounds)
  occlusion: true,           // optional: occlusion-query proxies per batch / instanced group
});
const report = world.compile({ coordinateSystem: renderer.coordinateSystem });
await world.warmup(renderer, camera);         // optional: compile shaders + upload textures now

renderer.render(scene, camera);
ledger.frame();                               // JSON snapshot: totals, passes, byReason, programs
ledger.report();                              // text table
ledger.budget({ maxSubmissions: 30 });        // { pass, actual, max, offenders }
world.resolve(raycastHit);                    // BatchedMesh / InstancedMesh hit -> original mesh
world.setVisible(crate, false);               // hide an original wherever it ended up
world.decompile();                            // restore the original graph
```

Characters: `assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body, helmet] })` merges parts
onto the shared rig (matched by bone name) into one skinned mesh with one atlas; `equip()` / `unequip()` change
the vertex buffer, never the draw count.

Dev overlay: `import { createOverlay } from 'threeforge/overlay'; createOverlay(ledger, { budget: 30 })`.

## What the numbers mean

- **submissions**: render items three processed (one per mesh, per material group, per pass). The cost that
  batching removes: pipeline and bind-group changes.
- **gpuDraws**: draw commands those submissions issue on this backend. A `BatchedMesh` is one submission but
  N draws on WebGPU (or on WebGL without `WEBGL_multi_draw`); double-sided transparent materials draw twice.
- **reportedDrawCalls / unattributed**: what `renderer.info` counted during the frame, and the part the ledger
  could not explain. Tests hold this at 0.
- **instances / instancesDrawn / drawCommands**: scene instances submitted, instances left after per-instance
  culling, and GPU draw commands regardless of API packaging (a multi-draw of N ranges is N, an instanced draw is 1).
- **reasons**: `batched`, `instanced`, `dynamic`, `skinned`, `morph`, `transparent`, `unique-material`, `untagged`,
  `multi-material-group`, `points`, `sprite`, `line`, `excluded:<rule>`, `unsupported-material`, `renderer-internal`,
  `fullscreen-pass`, `occlusion-proxy`.

## Commands

| command | what |
|---|---|
| `pnpm test` | Vitest units (node, no GPU) |
| `pnpm e2e` | Playwright on both backends: `webgl2` (headless shell) and `webgpu` (native adapter on macOS/Windows, SwiftShader on Linux) |
| `pnpm budget` | the CI gate; `FORGE_BUDGET=25 pnpm budget` to tighten |
| `pnpm spike` | three's experimental `SceneOptimizer` on the same scene, for comparison |
| `pnpm assets` | download ~570 MB of public glTF test content (Khronos, three.js, Kenney, Poly Haven) into `test/assets/files/` |
| `pnpm assets:report` | compile every downloaded model, check pixel parity, write `docs/assets-report.md` |
| `pnpm dev` | test app: `http://localhost:5179/?scene=naive&compile=1&overlay=1&budget=30&animate=1&dynamics=batch-sync` (also `scene=field&count=20000`, `scene=gltf&asset=Sponza`, `scene=biome&dynamics=batch-sync`, `scene=arena&bloom=1&assemble=1`) |

See `docs/design.md` for the architecture and `docs/spike-scene-optimizer.md` for the baseline measurement.
