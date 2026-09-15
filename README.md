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
| Draw calls | submissions by reason, GPU draws, programs, triangles | **material registry, static batching, group bake (seams, duplicates, buried faces, welding), auto-instancing, spatial chunks, BVH culling, LOD, occlusion, character assembler** |
| Overdraw / fill rate | opaque and transparent fragments per pixel (measured), particles drawn, pixels | **sprite batching, particle caps per tier (`ParticleBudget`), dynamic resolution (`ResolutionScaler`), transparency hints, [VFX conventions](docs/vfx.md)** |
| Skinning | skinned vertices, bones, skeletons, animated instances | **gear merged onto one skeleton**, **crowds as animated instances (`bakeAnimationTexture` + `AnimatedInstances`)**, [skinning notes](docs/skinning.md) |
| Lighting & shadows | lights, shadow lights, casters, shadow texels, shadow passes per frame | **`DayNight` (sun, sky dome, quantized shadow updates), `ShadowBudget` per tier, frozen static shadows, [lightmap path](docs/lighting.md)** |
| Per-frame JS | render ms, frame ms, objects walked, matrices recomposed, hidden originals, skipped ticks | **static-subtree freezing, `world.markDirty()`, `RenderScheduler` (render on change)** |
| Memory & load | texture, geometry and render-target bytes, unreferenced GPU resources, resident chunks | **`createLoader` (Draco + KTX2 + meshopt), `ResourceTracker`, chunk `Streamer`**, [memory notes](docs/memory.md) |

The complete reference, every module and option and how each works: [docs/threeforge.md](docs/threeforge.md).

Budgets come from a device tier (`desktop`, `phone-mid`, `phone-low`, detected at runtime, overridable) and
every breach shows up as a hint in the overlay and the JSON report.

## For AI agents (and anyone with a terminal)

```bash
npm i -D threeforge playwright && npx playwright install chromium
npx threeforge analyze scene.glb --backend webgpu --tier phone-mid --json   # measure, compile, verdict, hints
npx threeforge inspect http://localhost:5173 --json                        # your running app, via exposeToAgents()
npx threeforge optimize scene.glb --json                                    # build-time glTF pipeline, verified by pixels
npx threeforge explain point-light-shadow --json                            # what a hint means and how to fix it
npx threeforge schema                                                       # JSON Schemas of everything above
npx threeforge mcp                                                          # the same operations as MCP tools
```

`npx threeforge` with no arguments prints [AGENTS.md](AGENTS.md): commands, the JSON document, exit codes, the
hint table and the one-line app integration. Every command prints JSON with `--json` and uses exit codes an agent
can branch on.

### Optimize assets at build time

`threeforge optimize scene.glb` rewrites the file with [glTF-Transform](https://gltf-transform.dev) and writes
`scene.forge.glb`. Three presets: `safe` (default; dedup, palette, weld, resample, prune: never changes a pixel),
`balanced` (adds quantize and WebP textures at 2048 px), `aggressive` (adds simplify to 50 % and 1024 px textures).
Any step can be added or removed (`--quantize`, `--no-palette`, `--simplify 0.3`, `--compress meshopt`, `--textures avif`,
`--instance`, `--join`). The command then renders the original and the result through the same harness, compares
pixels view by view, compiles both with threeforge, and reports:

```json
{
  "steps": [{ "name": "dedup", "applied": true, "before": { "materials": 148, "meshes": 109 }, "after": { "materials": 10, "meshes": 63 } }],
  "requires": [{ "extension": "EXT_meshopt_compression", "needs": "MeshoptDecoder", "code": "loader.setMeshoptDecoder(MeshoptDecoder);" }],
  "verify": { "parity": { "diffPct": 0, "threshold": 0.5, "pass": true }, "delta": { "bytes": -2103500, "materials": -147, "sceneSubmissions": { "naive": -173, "compiled": 0 } } },
  "verdict": { "pass": true }
}
```

The verdict fails when pixels moved past `--parity`, when a clip, skin or morph target was lost, when the
optimized file fails `--budget`, or when either render raised a page error. Texture compression needs `npm i -D sharp`; reading a Draco input needs
`npm i -D draco3dgltf`. The output never uses Draco.

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

## Lighting: day/night and shadow budgets

`new DayNight(scene, { shadow: { everyDegrees: 0.5 } }).setTime(hours)` gives you a sun, a gradient sky dome, a
hemisphere light, fog and background that follow the hour, and a shadow map that re-renders only when the sun
moved. `new ShadowBudget({ tier }).apply(scene)` fits every shadow map to the device tier (point shadows off on
phones) and `ShadowBudget.freeze(light)` turns a static light's map into a one-off. Lightmaps survive batching and
baking: [docs/lighting.md](docs/lighting.md).

## Memory: loader, tracker, streaming

`const loader = await createLoader(renderer, { decoders: '/_decoders/' })` is a `GLTFLoader` with Draco, KTX2 and
meshopt wired (`npx threeforge decoders public/_decoders` copies the decoder files). `new ResourceTracker().track(root)`
and `release(root)` dispose what nothing else holds, and the ledger's `memory.unreferenced` names what was removed
without `dispose()`. `new Streamer({ world, camera })` keeps only the chunks within the camera's far plane resident
and frees the rest: the zen benchmark drops from 85 MB to 43 MB of textures with the frame unchanged:
[docs/memory.md](docs/memory.md).

## Crowds: animated instances

`const animation = bakeAnimationTexture(gltf.scene, gltf.animations, { fps: 30 })` plays every clip once and
stores the bone matrices in one float texture; `new AnimatedInstances({ animation, count: 200 }).addTo(scene)`
draws the characters as one instanced draw per part, each with its own clip, time offset and speed
(`setMatrixAt`, `setClipAt`, `setTime`), no mixers and no skeletons on the CPU. The crowd benchmark goes from
401 to 17 submissions: [docs/skinning.md](docs/skinning.md).

## Per-frame JS: freezing and render-on-change

`compile()` also freezes what never moves: unbatched statics and all-static ancestors stop recomposing their
matrices every frame (the village: 310 → 33). Move a frozen prop with `world.markDirty(prop)` and its batch follows.
`new RenderScheduler({ renderer, scene, camera, ledger, world }).start()` renders only when something changed
(camera, watched objects, running mixers, `invalidate()`); ten idle ticks cost three nothing, and `js.skipped`
in the snapshot says how many.

## Overdraw: sprites, particles, resolution

Sprites that share a material become one instanced billboard draw at `compile()` (the lake's 2 000 raindrops:
3 548 → 7 submissions, 0.3 % of pixels changed). `new ParticleBudget({ tier }).apply(scene)` caps points and sprite
batches so the frame draws at most the tier's particle budget. `new ResolutionScaler(renderer, { tier, ledger })`
with `update(frameMs)` each frame steps the drawing buffer down while the median frame time misses the budget.
What to do with effects so this stays cheap: [docs/vfx.md](docs/vfx.md).

## Bake: one mesh per finished group

`new World(scene, { bake: true })` turns each finished static group into one world-space mesh instead of a
`BatchedMesh`: seams between touching modules (coplanar faces with the same outline and opposite winding, between
different closed, manifold, outward, opaque, front-side modules that cast no shadow; any other such pair is kept and
counted) and
duplicated faces are removed, and vertices are welded only where position, normal, uv and colour agree, so
shading never changes. Originals stay editable: hiding a module (`world.setVisible`) rebakes its group,
`resolve()` maps a hit face back to its module, `decompile()` restores everything.

A wrong deletion is visible and a missed one is invisible, so the defaults are conservative and everything is
inspectable:

- `bake: { removeBuried: true }` (off by default) also drops faces with solid geometry right in front of them:
  every sampled ray from the face must be blocked within `distance` (default 0.1 units along the normal), so
  room interiors and open backsides survive; only faces of opaque, front-side modules that cast no shadow are
  removed, and only the back side of an opaque front-side or double-sided face blocks a ray (a face pressed against
  a neighbouring solid's front face is buried only when that solid's far side is within `distance`).
- `mesh.userData.forgeBake = false` passes a module through untouched.
- The compile report's `bake` block counts seams, coincident faces kept (`keptCoincidentFaces`), duplicates, buried
  faces and welded vertices per run, and
  `world.bakeDebug()` returns the removed faces as red meshes you can add to the scene to look at them.
- `npx threeforge analyze scene.glb --bake --views 6` bakes, then compares screenshots from the default framing
  plus six orbit views; the verdict fails if any view changed. Agents should run this before trusting a bake.

## Benchmark suite

Eight scenes every genre maps onto, each shipped as a naive assembly and an optimized path through threeforge
(`test/app/scenes`). `pnpm bench` measures all of them on both backends and fails on a 10 % regression against
the committed baselines; the table below is generated from those baselines, never typed by hand.

| scene | stresses |
|---|---|
| `forest` terrain, 5 000 trees, 2 000 grass patches | instancing, LOD, culling |
| `village` 300 props from 40 shapes, 40 materials | static batching, registry |
| `crowd` 200 skinned characters | skinning budget, animated instances |
| `bossfight` arena with 30 simultaneous VFX | overdraw, transparency |
| `lake` water, rain, fog | water shader, weather, fill rate |
| `daynight` the village under a sun cycle | lighting, shadows |
| `zen` vast procedural low-poly world, 50 000 objects on 64 textured tiles | chunk streaming, memory |
| `rpg` portrait mobile RPG, gear swaps | character assembler |

<!-- bench:start -->
### webgl2

ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver) · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | particles | fill MPix | objects / auto-matrices | skinned verts | shadow texels | shadow passes/frame | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 29 | 36.7k → 36.7k | 0.79 / 0.03 → 0.72 / 0.02 | 0 → 0 | 0.39 → 0.36 | 310 / 310 → 325 / 34 | 158 → 158 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 1.5 → 0.7 | 16.9 → 16.5 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 99.3k | 1.45 / 0.35 → 0.91 / 0.35 | 0 → 0 | 0.86 → 0.60 | 7.0k / 7.0k → 7.0k / 15 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 14.9 → 2.0 | 118.4 → 79.8 |
| crowd | 401 → 17 (23.6×) | 402 → 18 | 151.6k → 151.6k | 0.87 / 0.01 → 0.90 / 0.01 | 0 → 0 | 0.42 → 0.44 | 2.2k / 2.2k → 19 / 18 | 271.0k → 0 | 0 → 0 | 0.00 → 0.00 | 15 → 18 | 3.0 → 0.5 | 33.5 → 31.2 |
| bossfight | 2780 → 370 (7.5×) | 2787 → 294 | 161.7k → 175.8k | 1.14 / 1.24 → 1.14 / 1.23 | 7.6k → 7.6k | 1.14 → 1.14 | 1.5k / 1.5k → 1.5k / 442 | 16.4k → 16.4k | 3.67M → 3.67M | 3.00 → 3.00 | 106 → 107 | 13.8 → 7.7 | 113.6 → 123.9 |
| lake | 3548 → 7 (506.9×) | 3549 → 8 | 8.0k → 8.2k | 0.90 / 0.95 → 0.86 / 0.85 | 1.8k → 1.8k | 0.89 → 0.82 | 2.0k / 2.0k → 2.0k / 2.0k | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 14.8 → 1.7 | 85.9 → 73.0 |
| daynight | 605 → 28 (21.6×) | 606 → 29 | 73.4k → 36.7k | 0.79 / 0.02 → 0.72 / 0.02 | 0 → 0 | 0.39 → 0.35 | 310 / 310 → 325 / 34 | 158 → 158 | 4.19M → 4.19M | 1.00 → 0.50 | 20 → 20 | 2.8 → 1.1 | 30.1 → 26.7 |
| zen | 3540 → 88 (40.2×) | 3541 → 62 | 63.2k → 60.9k | 1.56 / 0.81 → 1.49 / 0.81 | 0 → 0 | 1.14 → 1.10 | 50.1k / 50.1k → 226 / 194 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 91 → 47 | 25.7 → 1.0 | 97.4 → 69.6 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.50 / 0.01 → 0.50 / 0.01 | 0 → 0 | 0.19 → 0.19 | 10 / 10 → 6 / 6 | 326 → 326 | 0 → 0 | 0.00 → 0.00 | 3 → 3 | 0.3 → 0.2 | 16.7 → 16.7 |

### webgpu

apple metal-3 · tier desktop · three 186

| scene | submissions naive → opt | gpu draws | triangles | overdraw opaque / transparent | particles | fill MPix | objects / auto-matrices | skinned verts | shadow texels | shadow passes/frame | memory MB | render ms | frame ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| village | 303 → 28 (10.8×) | 304 → 304 | 36.7k → 36.7k | 0.79 / 0.03 → 0.72 / 0.02 | 0 → 0 | 0.39 → 0.36 | 310 / 310 → 325 / 34 | 158 → 158 | 0 → 0 | 0.00 → 0.00 | 4 → 5 | 2.1 → 1.1 | 16.7 → 16.7 |
| forest | 5706 → 13 (438.9×) | 5707 → 10 | 391.1k → 99.3k | 1.45 / 0.35 → 0.92 / 0.35 | 0 → 0 | 0.86 → 0.61 | 7.0k / 7.0k → 7.0k / 15 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 14.4 → 2.8 | 16.4 → 16.7 |
| crowd | 401 → 17 (23.6×) | 402 → 18 | 151.6k → 151.6k | 0.87 / 0.01 → 0.88 / 0.01 | 0 → 0 | 0.42 → 0.43 | 2.2k / 2.2k → 19 / 18 | 271.0k → 0 | 0 → 0 | 0.00 → 0.00 | 15 → 18 | 3.3 → 1.1 | 16.8 → 16.8 |
| bossfight | 2780 → 370 (7.5×) | 2787 → 1082 | 161.7k → 175.8k | 1.14 / 1.24 → 1.14 / 1.23 | 7.6k → 7.6k | 1.14 → 1.14 | 1.5k / 1.5k → 1.5k / 442 | 16.4k → 16.4k | 3.67M → 3.67M | 3.00 → 3.00 | 107 → 107 | 12.9 → 7.6 | 16.3 → 16.6 |
| lake | 3548 → 7 (506.9×) | 3549 → 34 | 8.0k → 8.2k | 0.90 / 0.95 → 0.86 / 0.85 | 1.8k → 1.8k | 0.89 → 0.82 | 2.0k / 2.0k → 2.0k / 2.0k | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 4 → 4 | 12.7 → 2.9 | 16.5 → 16.8 |
| daynight | 605 → 28 (21.6×) | 606 → 304 | 73.4k → 36.7k | 0.79 / 0.02 → 0.72 / 0.02 | 0 → 0 | 0.39 → 0.35 | 310 / 310 → 325 / 34 | 158 → 158 | 4.19M → 4.19M | 1.00 → 0.50 | 20 → 21 | 3.3 → 1.6 | 16.7 → 16.8 |
| zen | 3540 → 88 (40.2×) | 3541 → 62 | 63.2k → 60.9k | 1.56 / 0.81 → 1.49 / 0.81 | 0 → 0 | 1.14 → 1.10 | 50.1k / 50.1k → 226 / 194 | 0 → 0 | 0 → 0 | 0.00 → 0.00 | 91 → 47 | 26.3 → 2.0 | 26.7 → 16.7 |
| rpg | 4 → 1 (4.0×) | 5 → 2 | 365 → 365 | 0.50 / 0.01 → 0.50 / 0.01 | 0 → 0 | 0.18 → 0.18 | 10 / 10 → 6 / 6 | 326 → 326 | 0 → 0 | 0.00 → 0.00 | 3 → 3 | 0.7 → 0.7 | 16.8 → 16.6 |
<!-- bench:end -->

### Run it on your device

The same eight scenes run in any browser at the deployed bench page (`https://<owner>.github.io/<repo>/` once
Pages is enabled; locally `pnpm bench:app` after `FORGE_KITS_ONLY=1 pnpm assets:kits`). It picks WebGPU when the
browser has it, else WebGL2, measures each scene naive and optimized with the same ledger `pnpm bench` uses, shows
real frame times, and offers to submit the result as a prefilled GitHub issue. The `bench-results` workflow
validates the JSON, stores it under `bench/devices/`, and regenerates the public table in
[docs/devices.md](docs/devices.md) and on the page. No server, no account beyond GitHub.

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
  N draws on WebGPU (or on WebGL without `WEBGL_multi_draw`); double-sided transparent materials draw twice, judged
  on the material three draws in each pass (a shadow pass uses `shadowSide`); an instanced draw of 0 instances is 0.
- **reportedDrawCalls / unattributed**: what `renderer.info` counted during the frame, and the part the ledger
  could not explain. Tests hold this at 0.
- **instances / instancesDrawn / drawCommands**: scene instances submitted, instances left after per-instance
  culling, and GPU draw commands regardless of API packaging (a multi-draw of N ranges is N, an instanced draw is 1).
  `instancesDrawn` and `drawCommands` do not count a multi-draw range a nested pass zeroed; `instances` is unaffected.
- **reasons**: `batched`, `instanced`, `dynamic`, `skinned`, `morph`, `transparent`, `unique-material` (a static drawn
  alone whose material no other object of the main pass draws), `static-unbatched` (one whose material is shared), `untagged`,
  `multi-material-group`, `points`, `sprite`, `sprite-batch`, `line`, `excluded:<rule>`, `unsupported-material`,
  `renderer-internal`, `fullscreen-pass`, `occlusion-proxy`.
- **overdraw.particles / overdraw.pixels**: quads drawn per frame (points vertices, sprites, sprite-batch instances)
  and drawing-buffer pixels; the bench's `fillMegapixels` is fragments per pixel × pixels.

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
