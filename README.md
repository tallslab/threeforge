# threeforge

Scene compiler + draw-call diagnostics for three.js (r186, `three/webgpu` with its WebGL2 fallback).
Three.js stays the renderer. threeforge takes a naively assembled scene, rewrites it into a batched one
at load time, and tells you exactly why every remaining draw call exists.

Phase 1 status: the naive test scene (500 props, 40 material recipes, a new material per prop) goes from
**503 to 28** scene submissions with pixel-identical output, and `pnpm budget` fails CI above 30.

```ts
import { DrawCallLedger, MaterialRegistry, World, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);                      // patches renderObject/render on this renderer instance

tag.static(crate);                            // batched by compile()
tag.dynamic(player);                          // left alone, counted

const world = new World(scene, { registry, ledger });
const report = world.compile();               // statics -> BatchedMesh per material variant, reversible
await world.warmup(renderer, camera);         // optional: compile shaders + upload textures now

renderer.render(scene, camera);
ledger.frame();                               // JSON snapshot: totals, passes, byReason, programs
ledger.report();                              // text table
ledger.budget({ maxSubmissions: 30 });        // { pass, actual, max, offenders }
world.resolve(raycastHit);                    // BatchedMesh hit -> original mesh
world.decompile();                            // restore the original graph
```

Dev overlay: `import { createOverlay } from 'threeforge/overlay'; createOverlay(ledger, { budget: 30 })`.

## What the numbers mean

- **submissions**: render items three processed (one per mesh, per material group, per pass). The cost that
  batching removes: pipeline and bind-group changes.
- **gpuDraws**: draw commands those submissions issue on this backend. A `BatchedMesh` is one submission but
  N draws on WebGPU (or on WebGL without `WEBGL_multi_draw`); double-sided transparent materials draw twice.
- **reportedDrawCalls / unattributed**: what `renderer.info` counted during the frame, and the part the ledger
  could not explain. Tests hold this at 0.
- **reasons**: `batched`, `dynamic`, `skinned`, `morph`, `transparent`, `unique-material`, `untagged`,
  `multi-material-group`, `excluded:<rule>`, `unsupported-material`, `renderer-internal`, `fullscreen-pass`.

## Commands

| command | what |
|---|---|
| `pnpm test` | Vitest units (node, no GPU) |
| `pnpm e2e` | Playwright on the WebGL2 backend in headless Chromium; a best-effort `webgpu` project self-skips without an adapter |
| `pnpm budget` | the CI gate; `FORGE_BUDGET=25 pnpm budget` to tighten |
| `pnpm spike` | three's experimental `SceneOptimizer` on the same scene, for comparison |
| `pnpm dev` | test app: `http://localhost:5179/?scene=naive&compile=1&overlay=1&budget=30&animate=1` |

See `docs/design.md` for the architecture and `docs/spike-scene-optimizer.md` for the baseline measurement.
