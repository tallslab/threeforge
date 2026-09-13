# threeforge

Frame-budget compiler and diagnostics for three.js games (r186, `three/webgpu` with its WebGL2 fallback).
Three.js stays the renderer. threeforge rewrites a naively assembled scene into a batched one at load time and
measures every cost category of the frame in one ledger, with hints that say what to fix. Desktop and mobile;
every claim is proven on a fixed benchmark suite on both backends.

Draw calls are the door people come through, but a forest cut from 400 calls to 30 still drops frames on a
phone because of fill rate, and a VFX-heavy fight is killed by overdraw, not calls. So the library is organised
by cost, not by genre:

| Cost | The ledger measures | threeforge does (**shipped**) |
|---|---|---|
| Draw calls | submissions by reason, GPU draws, programs, triangles | **material registry, static batching, auto-instancing, spatial chunks, BVH culling, LOD, occlusion, character assembler** |
| Overdraw / fill rate | opaque and transparent fragments per pixel (measured, not estimated) | transparency budget, VFX conventions, particle caps, dynamic resolution (next) |
| Skinning | skinned vertices, bones, skeletons | **gear merged onto one skeleton**; baked animation textures for crowds (next) |
| Lighting & shadows | lights, shadow lights, casters, shadow texels | one sun + gradient sky day/night, shadow budget per tier (next) |
| Per-frame JS | render ms, frame ms, auto-updated matrices | dirty-flag matrices, render-on-change (next) |
| Memory & load | texture, geometry and render-target bytes | KTX2/meshopt pipeline, disposal tracking, streaming (next) |

Budgets come from a device tier (`desktop`, `phone-mid`, `phone-low`, detected at runtime, overridable) and
every breach shows up as a hint in the overlay and the JSON report.

Draw-call numbers so far: the naive test scene (500 props, 40 material recipes, a new material per prop) goes from
**503 to 28** scene submissions with pixel-identical output (**18** with `dynamics: 'batch-sync'`); the 20k-instance
field scene goes from 3892 submissions to **3 instanced draws** with BVH culling; 104 public glTF assets
compile pixel-identical on both backends. `pnpm budget` fails CI above 30.

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
await world.warmup(renderer, camera);         // optional: build shaders + upload textures now (see Warm-up)

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

## Benchmark suite

Eight scenes every genre maps onto, each shipped as a naive assembly and an optimized path through threeforge
(`test/app/scenes`). `pnpm bench` measures all of them on both backends and fails on a 10 % regression against
the committed baselines; the table below is generated from those baselines, never typed by hand.

| scene | stresses |
|---|---|
| `forest` terrain, 5 000 trees, 2 000 grass patches | instancing, LOD, culling |
| `village` 300 props from 40 shapes, 40 materials | static batching, registry |
| `crowd` 200 skinned characters | skinning budget, VAT (next) |
| `bossfight` arena with 30 simultaneous VFX | overdraw, transparency |
| `lake` water, rain, fog | water shader, weather, fill rate |
| `daynight` the village under a sun cycle | lighting, shadows |
| `zen` vast procedural low-poly world, 50 000 objects | chunk streaming, memory |
| `rpg` portrait mobile RPG, gear swaps | character assembler |

<!-- bench:start -->
### webgl2

ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver) · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | skinned verts | shadow texels | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 29 | 36.7k → 36.7k | 0.79 / 0.03 → 0.72 / 0.02 | 158 → 158 | 0 → 0 | 4 → 4 | 2.5 → 1.0 | 18.5 → 17.5 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 99.3k | 1.45 / 0.35 → 0.91 / 0.35 | 0 → 0 | 0 → 0 | 4 → 4 | 33.6 → 2.2 | 141.0 → 86.8 |
| crowd | 401 → 401 (1.0×) | 402 → 402 | 151.6k → 151.6k | 0.87 / 0.01 → 0.87 / 0.01 | 271.0k → 271.0k | 0 → 0 | 15 → 15 | 4.6 → 4.6 | 39.3 → 37.2 |
| bossfight | 2780 → 424 (6.6×) | 2787 → 346 | 161.7k → 152.5k | 1.14 / 1.24 → 1.14 / 1.24 | 16.4k → 16.4k | 3.67M → 3.67M | 106 → 107 | 23.5 → 9.7 | 127.3 → 110.4 |
| lake | 3548 → 3522 (1.0×) | 3549 → 3523 | 8.0k → 8.0k | 0.90 / 0.95 → 0.86 / 0.95 | 0 → 0 | 0 → 0 | 4 → 4 | 25.3 → 26.0 | 97.5 → 98.2 |
| daynight | 605 → 55 (11.0×) | 606 → 56 | 73.4k → 73.4k | 0.79 / 0.02 → 0.72 / 0.02 | 158 → 158 | 4.19M → 4.19M | 20 → 20 | 4.6 → 1.5 | 33.0 → 28.9 |
| zen | 10879 → 125 (87.0×) | 10880 → 98 | 141.1k → 141.1k | 1.63 / 0.81 → 1.53 / 0.81 | 0 → 0 | 0 → 0 | 4 → 4 | 77.9 → 17.5 | 274.6 → 199.1 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.50 / 0.01 → 0.50 / 0.01 | 326 → 326 | 0 → 0 | 3 → 3 | 0.4 → 0.3 | 16.7 → 16.7 |

### webgpu

apple metal-3 · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | skinned verts | shadow texels | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 304 | 36.7k → 36.7k | 0.79 / 0.03 → 0.72 / 0.02 | 158 → 158 | 0 → 0 | 4 → 5 | 3.4 → 1.9 | 16.7 → 16.6 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 99.3k | 1.45 / 0.35 → 0.92 / 0.35 | 0 → 0 | 0 → 0 | 4 → 4 | 31.1 → 3.0 | 31.7 → 16.8 |
| crowd | 401 → 401 (1.0×) | 402 → 402 | 151.6k → 151.6k | 0.87 / 0.01 → 0.87 / 0.01 | 271.0k → 271.0k | 0 → 0 | 15 → 15 | 4.7 → 4.8 | 16.7 → 16.6 |
| bossfight | 2780 → 424 (6.6×) | 2787 → 2350 | 161.7k → 311.6k | 1.14 / 1.24 → 1.14 / 1.24 | 16.4k → 16.4k | 3.67M → 3.67M | 107 → 107 | 22.5 → 8.8 | 23.5 → 16.8 |
| lake | 3548 → 3522 (1.0×) | 3549 → 3549 | 8.0k → 8.0k | 0.90 / 0.95 → 0.86 / 0.95 | 0 → 0 | 0 → 0 | 4 → 4 | 22.2 → 23.9 | 22.7 → 24.3 |
| daynight | 605 → 55 (11.0×) | 606 → 606 | 73.4k → 73.4k | 0.79 / 0.02 → 0.72 / 0.02 | 158 → 158 | 4.19M → 4.19M | 20 → 21 | 4.9 → 2.3 | 16.7 → 16.7 |
| zen | 10879 → 125 (87.0×) | 10880 → 98 | 141.1k → 141.1k | 1.63 / 0.81 → 1.53 / 0.81 | 0 → 0 | 0 → 0 | 4 → 4 | 76.1 → 18.0 | 76.9 → 18.2 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.50 / 0.01 → 0.50 / 0.01 | 326 → 326 | 0 → 0 | 3 → 3 | 0.9 → 0.8 | 16.8 → 16.7 |
<!-- bench:end -->

## Warm-up

`world.warmup(renderer, camera)` renders one real frame under a 1x1 scissor, so every pipeline the first visible
frame needs is built exactly as that frame builds it. Pass `{ mode: 'async' }` to use `renderer.compileAsync()`
instead (it yields between objects, so a loading screen keeps animating); threeforge then disposes the materials
three r186 compiles wrong that way (transparent double-sided and transmissive ones, rendered in two passes) and
rebuilds them in a scissored frame. The result reports `{ mode, textures, repaired }`.

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
