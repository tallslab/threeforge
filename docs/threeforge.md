# threeforge — the complete reference

This document describes everything threeforge is and does, module by module, and how each part works. Shorter
entry points: [README.md](../README.md) (overview and quick start), [AGENTS.md](../AGENTS.md) (for AI agents),
[docs/bench.md](bench.md) (benchmark baselines), [docs/design.md](design.md) (the history of phases 1–6).

## 1. What it is

threeforge is a **frame-budget compiler and diagnostics layer for three.js games** (three r186, `three/webgpu`
with its WebGL2 fallback). It is not an engine and has no editor. three.js stays the renderer. threeforge does
three things:

1. **Compiles** a naively assembled scene into a cheap one at load time: it merges static meshes into batches or
   baked meshes, instances repeated geometry, culls per instance with a BVH, switches LODs, and keeps the original
   objects editable and reversible.
2. **Measures** every cost category of a frame in one ledger: draw calls by reason, measured overdraw, skinning,
   lighting and shadows, per-frame JavaScript, memory. It reconciles its own count with the renderer's, so a
   non-zero `unattributed` means the model is wrong, never the scene.
3. **Explains** what to fix: per-tier budgets turn into hints with a remedy each, readable by a person on the
   overlay or by an AI agent through JSON, a CLI and an MCP server.

Everything is proven on a fixed benchmark suite of eight scenes and on 104 public glTF assets, on both backends,
with a regression gate that fails the build on a 10 % regression.

Principles: three.js renders; a wrong deletion is visible and a missed one is invisible (so every removal is
conservative, counted and reversible); measurements are real, never estimated where a measurement is possible;
agents get the same data as people, as JSON with exit codes.

## 2. Install and first use

```bash
npm i -D threeforge                          # the library (peer: three >= 0.180)
npm i -D playwright && npx playwright install chromium   # only for the CLI / MCP
```

```ts
import { DrawCallLedger, MaterialRegistry, World, exposeToAgents, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);                     // patches renderObject/render on this renderer instance

tag.static(crate);                           // never moves: batched or baked by compile()
tag.dynamic(player);                         // moves: left alone (or synced into a batch with dynamics: 'batch-sync')

const world = new World(scene, { registry, ledger, policy: 'tagged' });
const report = world.compile({ coordinateSystem: renderer.coordinateSystem });
await world.warmup(renderer, camera);        // build every pipeline now, not on the first visible frame
if (import.meta.env.DEV) exposeToAgents({ ledger, world, renderer, scene, camera }); // window.__threeforge, development only

renderer.render(scene, camera);
const frame = ledger.frame();                // FrameSnapshot v3: six cost sections + hints
```

```bash
npx threeforge analyze scene.glb --backend webgpu --tier phone-mid --json
npx threeforge inspect http://localhost:5173 --json
```

## 3. Architecture

| Directory | Responsibility |
|---|---|
| `src/tags.ts` | `tag.static(obj)`, `tag.dynamic(obj)`, `tag.of(obj)`; stored in `userData.forge` |
| `src/registry` | `MaterialRegistry`: material keys (program, variant, colour) and canonical sharing; three's own material classes (`isBuiltInMaterial`) |
| `src/ledger` | `DrawCallLedger`, the v3 snapshot, reasons, display names (`DisplayNames`, a validated cache), expected GPU draws, sections (skinning, lighting), memory estimate, measured overdraw, budgets and tiers, hints |
| `src/compiler` | `classify` (rules), `batchStatics` (batches, instancing, bake), `bake` (geometry bake), `culling` (BVH, hooks), `instancing` (compacted InstancedMesh), `geometryCompat`, `World` (compile/decompile/resolve/warmup) |
| `src/lod` | meshoptimizer LOD generation |
| `src/overdraw` | `ParticleBudget` (particle caps per tier) and `ResolutionScaler` (dynamic drawing-buffer scale) |
| `src/scheduler` | `RenderScheduler` (render on change) |
| `src/lighting` | `DayNight` (sun, sky dome, hemisphere, fog, quantized shadow updates) and `ShadowBudget` (map sizes per tier, frozen shadows) |
| `src/character` | the character assembler (gear merged onto one skeleton, one atlas) |
| `src/overlay` | text formatting of a snapshot and the DOM overlay |
| `src/agent` | `exposeToAgents` (the `window.__threeforge` hook) |
| `src/cli` | the `threeforge` CLI (`analyze`, `inspect`, `optimize`, `explain`, `schema`, `mcp`, `decoders`), the MCP server, JSON schemas, hint remedies, the glTF-Transform pipeline (node only, optional peers loaded lazily) |
| `cli-app` | the harness page shipped inside the package for `threeforge analyze` |
| `test/app` | the development harness (`pnpm dev`) with every test scene and benchmark scene |
| `test/scenes`, `test/app/scenes` | deterministic scenes (naive, field, forest, character) and the eight benchmark scenes |
| `test/unit`, `test/e2e` | Vitest units (node, fake renderer) and Playwright specs on both backends |
| `bench` | baselines and results of the benchmark suite |
| `scripts` | asset download, bench runner/gate/table, agent docs generator, decoder copy |

Data flow: the app tags meshes → `World.compile()` classifies every mesh, registers materials, groups statics and
builds batches / baked meshes / instanced meshes, hides the originals, installs culling and sync hooks → three.js
renders → the ledger records every `renderObject` call with a reason and rebuilds the snapshot at the end of the
outermost `render()` → the overlay, the CLI, the bench runner and agents read `ledger.frame()`.

## 4. The ledger (`DrawCallLedger`)

### How it hooks in

`ledger.attach(renderer)` replaces two instance methods on the renderer: `renderObject` (called once per render
item after culling and sorting, in every pass, including shadow maps and post-processing) and `render` (frame
boundaries). The outermost `render()` call is one frame; nested calls are passes of it. `detach()` restores the
originals. Nothing global is patched.

`renderAsync` works without a patch of its own. three r186's `renderAsync` (deprecated since r181) awaits `init()` and
then calls `this.render(scene, camera)`, so a frame rendered through it enters the patched `render` once, after the
await, and reports a `main` pass with its shadow passes and skinning, exactly like `render()`. A `render()` made while
`renderAsync` awaits `init()` is a frame of its own. A unit test checks three's source for that call.

### Passes

Each submission carries a pass id: `main`, `shadow:<light name>` (the camera is the shadow camera of a world-visible
shadow-casting light; its type when it has no name; `shadow:<name>#k`, k from 1 in scene order, when shadow-casting
lights of a scene share a name, and an id another scene of the frame already took moves on to the next free k),
`shadow:<id>:vsm` (the two VSM blur quads three renders right after that map), `override` (a scene with
`overrideMaterial`), `fullscreen` (a non-scene root, for example a post-processing quad), `nested:<render target name>`
(a nested render of the main scene, for example a reflector), `scene:<name>` (a different scene). Renderer-internal
work (three's output colour transform quad, the VSM blur quads) is attributed as `renderer-internal` and excluded from
`sceneSubmissions`.

### Reasons and flags

Every submission gets one reason: `batched`, `baked`, `instanced`, `unique-material`, `static-unbatched`, `dynamic`,
`skinned`, `morph`, `transparent`, `multi-material-group`, `untagged`, `unsupported-material`, `renderer-internal`,
`fullscreen-pass`, `occlusion-proxy`, `points`, `sprite`, `line`, `unclassified`, or `excluded:<rule>`. The compiler
annotates objects it left alone (`ledger.annotate(object, reason)`) so the ledger says why. A static drawn alone is
`unique-material` when no other object of the frame's main pass draws its material, and `static-unbatched` when one
does: at the end of the frame the ledger counts, per canonical material (the registry's, else the instance itself), the
distinct objects that drew it in the main pass, so a mesh drawn twice there is one use. The item's `material` is that
material's per-frame index. Flags add detail:
`shadow-caster`, `double-sided-transparent`, `custom-hook`, `render-order`, `layers`, `transparent`.
`double-sided-transparent` describes the material three draws in that pass (see Reconciliation), so a shadow caster can
carry it in its shadow pass and not in the main pass, or the other way round.

### Reconciliation

For each submission the ledger predicts the draw calls three r186's `renderer.info` counts for it on this backend:

- 1 for a mesh.
- N for a `BatchedMesh` with N multi-draw slots on WebGPU or on WebGL without `WEBGL_multi_draw` (1 with multi-draw, 0
  for an empty list). A slot whose count a nested pass zeroed (stable-prefix culling, `attachBvhCulling`) is counted:
  three's `Info` counts every slot.
- 0 when the instance count is 0: an `InstancedMesh` with `count = 0`, or a mesh over an `InstancedBufferGeometry` with
  `instanceCount = 0` (an empty sprite batch or VAT part).
- ×2 when the material three draws is transparent, `DoubleSide` and not `forceSinglePass`. That material is the source
  material, or `scene.overrideMaterial` for a source with `allowOverride`: transparent when the source is transparent,
  transmissive or has a backdrop node, with the override's own side, except in a shadow pass, where the side is the
  source's `shadowSide`, else its side (PCF flips it, VSM keeps the source side; either way `DoubleSide` stays
  `DoubleSide`). The factor is read before `renderObject` runs, because three puts the override material's side back
  as it returns. So a `side` or `transparent` change made inside `object.onBeforeRender`, which three calls at the
  start of `renderObject`, is not seen by the prediction. A double-sided transmissive material is two submissions of
  one draw each: its back-side pass, then its front.
- A draw range three rejects (`RenderObject.getDrawParameters` returns null when the range count is below 0 or
  `Infinity`: malformed app geometry, such as a group past the end of its index) still predicts 1 draw and shows as
  `unattributed`.

`reportedDrawCalls` is the change in `renderer.info.render.drawCalls` inside the frame;
`unattributed = reportedDrawCalls − gpuDraws` and is asserted to be 0 in every test. `drawCommands` counts multi-draw
ranges individually. It and `instancesDrawn` count only the slots with a non-zero index count: a zeroed slot adds a
draw call but draws no instance. A batched double-sided transparent submission adds its drawn slots to `drawCommands`
once, without the ×2 its `expectedGpuDraws` carries, while a non-batched one adds 2; this predates 0.9.0.

### The snapshot (`ledger.frame()`), schema version 3

```
schemaVersion: 3
env:       three, backend (webgl2|webgpu), multiDraw, tier, gpu, dpr, viewport
totals:    submissions, sceneSubmissions, gpuDraws, reportedDrawCalls, unattributed, programSwitches, programs,
           triangles, instances, instancesDrawn, drawCommands
passes:    [{ id, submissions, gpuDraws }]
byReason:  { reason: { submissions, gpuDraws, top: [first 5 names] } }
programs:  { programHash: { type, description, submissions } }
overdraw:  opaque, transparent (fragments per pixel, measured), transparentSubmissions, measured
skinning:  submissions, vertices, bones, skeletons, maxBones, morphTargets, vatInstances, vatVertices
lighting:  lights { directional, point, spot, hemisphere, ambient, other }, shadowLights, shadowPasses,
           shadowCasters, shadowTexels, shadowSubmissions
js:        renderMs, ledgerMs, frameMs, objects, autoUpdatedMatrices, hiddenOriginals, skipped
memory:    textures { count, bytes }, geometries { count, bytes }, renderTargets { count, bytes },
           unreferenced { geometries, textures }, chunks { total, resident },
           measured { textures { count, bytes }, geometries { count, bytes }, renderTargets { count }, bytes } | null,
           estimated: true
hints:     [{ category, severity, code, message, objects }]
items?:    per-submission records with ledger.frame({ items: true })
```

- **overdraw** is measured, not estimated: `ledger.measureOverdraw(scene, camera)` renders the scene twice into a
  1/8-resolution half-float target, once for the opaque render list (`renderer.transparent = false`) and once for the
  transparent lists, reads each render back and averages the red channel: fragments per pixel. The count material (a
  `MeshBasicNodeMaterial` with a constant `outputNode`, One/One blending, no depth test or write, one pass) adds exactly
  1 per fragment, so material, vertex, instance and batch colours do not change the count and a batched scene measures
  like its naive original. A render-object function draws each object with its own material's `side`, `map`, `opacity`,
  `alphaHash`, `opacityNode`, `alphaTestNode` and `maskNode`, and three's override copies `alphaTest`, `alphaMap` and
  `positionNode`: closed meshes count their front faces, cutouts count their kept texels, animated instances count their
  animated pose. Sprite materials (a `Sprite`, a World sprite batch) are drawn with a `SpriteNodeMaterial` count material
  carrying their `rotation`, `sizeAttenuation`, `scaleNode` and `rotationNode`, so they count their billboards. Not
  carried into the count: `colorNode` alpha, vertex-colour alpha, and vertices a material builds in its class or
  `vertexNode` (a `PointsNodeMaterial` on a non-`Points` object, Line2-style materials), which count what the count
  material rasterises from the geometry and `positionNode`. Not counted: the
  background (the target clears to 0), materials with `allowOverride = false` or `colorWrite = false`, and occlusion
  proxies. A mesh whose material groups differ only in the slots the count copies (`map`, `alphaHash`, `opacityNode`,
  `alphaTestNode`, `maskNode`, `positionNode`) is counted with whichever group's program three built first: three keys
  the render object by object, override material, context and lights, and assigning a slot bumps no version. A sprite
  batch mirrors its side in `onBeforeRender`, after the count has copied `side`, so a measurement taken right after a
  mirroring flip, with no app frame between, counts the previous side. A scene rendered inside a count draw with its
  own override material, or none (a render-to-texture hook), passes straight through: its draws keep their materials and
  change nothing on the count material, and a same-scene render inside a count draw (a reflector's `updateBefore`) puts
  back every slot it changed. A `measureOverdraw()` called while that renderer's count renders run (a hook the count
  render calls again, as a measuring hook is) returns the measurement in progress and renders nothing: it ignores its own
  `scene`, `camera` and `options.scale`, and resolves with the outer measurement's result even for another scene. One
  called once the counts have rendered, while the read-backs are pending, is a measurement of its own. A
  `disposeOverdraw(renderer)` called while the count renders run releases once they end. Every scene and renderer setting it changes is restored before the read-backs are awaited, so frames
  rendered meanwhile are unaffected; attribution pauses for the two count renders only, which never become part of a
  frame (not even when measured from a render hook). The target and count materials are kept per renderer until
  `ledger.detach()` or `disposeOverdraw(renderer)`; `overdrawTargetOf(renderer)` returns the target, which the
  memory section allows. Call it on demand.
- **skinning** sums the main pass's skinned submissions: vertices, bones per unique skeleton (indexed per frame, no
  uuids in the snapshot), the largest bone count, morph targets; `vatInstances` and `vatVertices` count the
  characters drawn as animated instances (`kind: 'vat'`, reason `vat-instanced`), which need no CPU bones.
- **lighting** counts the lights three projected for the main pass (`lightsNode.getLights()`, read from the first
  scene submission's `renderObject` call; a light under a hidden group, on a layer the camera does not see, or with
  `renderer.lighting.enabled = false` is not lit), else the main scene's world-visible lights (hidden subtrees skipped,
  as `scanLights` does). `shadowLights` counts those set to cast. `shadowPasses` and `shadowSubmissions` count the scene
  submissions of `shadow:*` passes, not the renderer-internal `:vsm` quads. `shadowTexels` = Σ `mapSize.x · mapSize.y ·
  faces` (6 faces for a point light, a cube target) over the lights whose shadow map rendered this frame, each light
  once: a frozen map (`autoUpdate` off and no `needsUpdate`) or a disabled `renderer.shadowMap` adds 0, and a map three
  renders again for another camera of the frame counts once. `shadowCasters` counts the distinct objects drawn into any
  shadow map this frame: a `BatchedMesh` or `InstancedMesh` is one object whatever slots or instances it draws, and an
  object casting for several lights (or a point light's six faces) counts once.
- **js**: `renderMs` is the outermost `render()` call's duration until the ledger starts filing the frame (it includes
  the ledger's per-submission attribution, which runs inside the renderer's calls); `ledgerMs` is that filing, after
  `render()` has finished: the snapshot, the hints and, every 60 frames, the rescan. `frameMs` is the median interval
  between the last 60 outermost renders, `objects`, `autoUpdatedMatrices` and `hiddenOriginals` (batched originals
  parked on layer 31) come from a traversal repeated at most every 60 frames; `skipped` is the ticks a
  `RenderScheduler` skipped among its last 60 (`ledger.rescan()` forces it).
- **memory** estimates bytes. A texture follows three r186's `Info._getTextureMemorySize`: `w · h · depth · texel
  bytes`, with channels from the format, bytes per channel from the type and packed types whole, depth 6 for a cube and
  the layers of a 3D or array texture, ×1.333 with generated mipmaps. It follows what three allocates where that
  function does not: a compressed texture is the sum of its mip data (a compressed cube's six faces too; three counts 1
  byte), the size is the one `Textures.getSize` allocates (a cube's first face, a video's frame; three's `Info` reads 1
  for a cube's image array), and explicit mipmaps are the levels three uploads (every level in a 2D texture's
  `mipmaps`, the base plus the levels in a cube's). Geometries are Σ attribute and index bytes, render targets the
  shadow maps three has built for casting lights (none for a light whose map three never built) and the renderer's
  half-float frame-buffer target for the viewport.
  `ledger.measureMemory()` recounts now.
- **memory.measured** is three's own `renderer.info.memory` when the estimate was made: `textures` (count and
  `texturesSize`), `geometries` (count and `attributesSize + indexAttributesSize`), `renderTargets` (count) and `bytes`
  (`total`). It counts everything three allocated, render-target, shadow-map and internal textures included, and a
  compressed texture as 1 byte; null for a renderer without these counters.
- **memory.unreferenced** counts the geometries and textures the renderer still holds (`info.memory` counts) that the
  scene no longer reaches, minus what three allocates for itself, whatever the viewport: one geometry, the frame-buffer
  target's colour and depth, the textures of every shadow map three has built (a colour and a depth texture, read off
  each casting light's `shadow.map`; a casting light whose map three never built, with shadow maps disabled or never
  lit, holds none) with a non-point VSM map's two blur targets (read off an array map, else counted from
  `renderer.shadowMap.type`), the overdraw count target once `measureOverdraw()` has run, and three's 16 × 16 `DFG_LUT`
  (created once a Standard or Physical material is lit, and held with nothing in the scene reaching it), which the
  ledger counts through `renderer.info.createTexture` and `destroyTexture` while attached. Limits: a LUT three created
  before `ledger.attach()` is not seen and reads as one unreferenced texture; a map built but not rendered yet is
  allowed the textures three creates on its first render, so the count reads low until then; reachable includes BatchedMesh and skeleton textures and `material.userData.forgeTextures`. Recounted
  with the graph statistics; `measureMemory()` recounts now. **memory.chunks** is the attached Streamer's residency,
  read live.
- **hints** are recomputed every frame from the snapshot and the budgets of the environment's tier.
- **programHash / variantHash** (the `programs` keys, and each item's hashes) come from the material registry
  (section 5). A hash for a material with instance code, a class that is not one of three's own, or identity-keyed
  data (a function or class instance in a user-added property) is stable within a run only: identity numbers follow
  the order materials are first keyed. A `variantHash` with a texture also differs between runs (texture `uuid`s).

Other methods: `ledger.report()` (text), `ledger.budget({ maxSubmissions })` → `{ pass, actual, max, offenders }`,
`ledger.setEnvironment({ tier, gpu, dpr, viewport })`, `ledger.budgets()`.

### Overhead

The ledger's per-submission path runs inside the renderer's calls, so its cost is part of `js.renderMs`; filing the frame
once `render()` has finished (the snapshot, the hints and the periodic rescan) is `js.ledgerMs`. In a steady scene the
per-submission path allocates nothing, and none of the following changes a number in the snapshot:

- **Pooled records.** Two record buffers alternate: the frame in progress writes one while the last completed frame's
  items stay intact in the other, so a read between frames or inside one (a hook) sees whole frames. `frame({ items: true })` returns copies, valid however long they are held.
- **Material hashes** come from `registry.hashesOf()` (the registry's key cache, section 5), read at most once per
  material per frame, and again after `invalidate()` or `forget()` (`registry.keysRevision`), even within a frame.
- **Material uses** (`materialUses.ts`: the per-frame `material` index every record carries and the main-pass users
  behind `static-unbatched`) resolve each drawn material to the registry's canonical at most once per material per
  frame, memoized and invalidated on that same revision, rather than once per submission.
- **Display names** come from a cache checked against the live graph on every read: the object's name, type and
  sibling index, and its parent's path. A sibling index is trusted only while `parent.children[index] === object`, so
  a rename, reorder, reparent or removal (even from a hook between two submissions) gives `displayName()`'s answer
  without calling `children.indexOf`.
- **One ancestor walk** per submission finds both the root and the nearest tag.
- **Draw state** (`expectedGpuDraws`, `instances`, `instancesDrawn`) is copied into the record as soon as
  `renderObject` returns, after a pass nested inside that draw (a receiver's shadow map) has restored the counts it
  changed. The side factor of `expectedGpuDraws` and the `double-sided-transparent` flag are read as the call starts,
  before three puts an override material's side back. `writeInstanceCounts` loops over every multi-draw slot of a
  batched submission to count the non-zero ones, without allocating; `scripts/ledger-overhead.mjs` renders plain
  meshes only, so it does not measure that loop.
- **One walk per scene per frame** (`traverseVisible`) gives the shadow cameras of world-visible shadow-casting lights
  their pass ids and keeps the main scene's lights as the lighting section's fallback; the section's lights come from
  the first scene submission's lights node, read once per frame. Casters and shadow texels are marked per object and per
  light with the frame's number, so nothing is cleared between frames. The rescan every 60 frames reads each shared
  material's texture properties once (`collectResources`).

`pnpm build:lib && node scripts/ledger-overhead.mjs [submissions…]` reports the µs added per submission, the bytes
allocated per frame and the rescan time, at 2k, 10k and 20k submissions by default. It renders a flat scene (unnamed
meshes under the scene), a nested one (unnamed meshes in unnamed groups under named zones) and a shadow one (the flat
scene with a shadow-casting sun, whose map renders as a nested pass drawing the quarter of the meshes that cast)
through a minimal renderer, bare and with a ledger attached. µs per submission is the best ledger round minus the best
bare round. It is a report, not a gate: compare runs on one machine. On a 10-core Mac
with node 22, the flat scene over two runs (timings move between runs, bytes do not):

| submissions | µs / submission | MB / frame | rescan ms | 0.8.0: µs / submission | 0.8.0: MB / frame |
|---|---|---|---|---|---|
| 2k | 0.24–0.36 | 0.18 | 0.5–0.7 | 0.83 | 2.3 |
| 10k | 0.32–0.51 | 0.80 | 1.7–3.1 | 1.84 | 11.4 |
| 20k | 0.42–0.53 | 1.74 | 5.5–10.0 | 3.07 | 23.1 |

The unit guards in `test/unit/ledger-hot-path.test.ts` count registry reads (at most one per material per frame),
traversals (at most one on a frame without a rescan) and `children.indexOf` calls (none), and check that µs per
submission grows less than 3× from 2k to 20k submissions (best of 7).

### Tiers, budgets and hints

`detectTier({ gpu, deviceMemory, cores, touch, mobile, dpr })` is GPU-first: a recognised GPU name decides the
tier before touch is even considered, so a touch-capable desktop (a Windows laptop with a discrete GPU and a
touchscreen) is not mistaken for a phone. All six steps of the decision live in `detectTier` itself (so it never
disagrees with what `tierInputFromNavigator` feeds it), in order:

1. The low-end regex matches (Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR SGX, VideoCore)
   → `phone-low`.
2. A mobile/tablet GPU matches (higher-end Adreno/Mali, PowerVR, Xclipse, Qualcomm, Apple A-series) → `phone-mid`,
   whatever `touch`/`mobile` say — or `phone-low` when `deviceMemory <= 2`.
3. A desktop GPU matches (NVIDIA, Radeon, AMD, Intel, Iris, Arc, Apple M-series, SwiftShader) → `desktop`,
   whatever `touch`/`mobile` say. Every alternative in all three GPU regexes is word-bounded, so an unrelated
   string ("Intelligent Renderer", "Malibu GPU") cannot false-match a brand substring ("intel", "mali").
4. A bare `"Apple"` (an iPad on Safari reports only this) with `touch` → `phone-mid`, or `phone-low` when
   `deviceMemory <= 2`.
5. Otherwise the GPU string is unrecognised or empty, and `mobile` is defined: `true` → `phone-mid` (or
   `phone-low` under `deviceMemory <= 2`); `false` → `desktop`.
6. Otherwise (`mobile` is `undefined`) the old touch-only rule: no `touch` → `desktop`; `touch` and
   `deviceMemory <= 2` → `phone-low`; `touch` otherwise → `phone-mid`.

`tierInputFromNavigator(gpu, nav)` builds the `TierInput` that feeds `detectTier` from a GPU name and `navigator`
(passed explicitly so it is unit-testable with fake navigators) — `test/app/main.ts`, `cli-app/main.ts` and
`bench-app/runner.ts` all call it the same way. `touch` is the real touch capability
(`navigator.maxTouchPoints > 0`) and nothing else. `mobile` (step 5) is resolved separately, in priority order:
`navigator.userAgentData.mobile` (Chromium, most reliable — correctly `false` for a touch-capable desktop even
though `touch` is `true`), then a `"Mobi"` sniff of `navigator.userAgent` (non-Chromium browsers), else left
`undefined` when neither is available, so `detectTier` falls back to `touch` alone (step 6). Every field it reads
(`userAgentData`, `deviceMemory`, `maxTouchPoints`) is optional and guarded.

Budgets per tier (`BUDGETS`, `budgetsFor(tier, overrides)`):

| metric | desktop | phone-mid | phone-low |
|---|---|---|---|
| sceneSubmissions | 400 | 150 | 80 |
| triangles | 5 M | 1.5 M | 500 k |
| transparent overdraw (fragments / pixel) | 3 | 2 | 1.5 |
| skinned vertices | 400 k | 150 k | 60 k |
| shadow texels | 4 M | 1 M | 262 k |
| texture bytes | 512 MB | 192 MB | 96 MB |
| frame ms | 16.6 | 16.6 | 33 |
| particles per frame | 60 k | 15 k | 5 k |
| objects walked per frame | 20 k | 5 k | 2 k |

Hint codes (`hintsFor`, remedies in `npx threeforge explain --all`): `over-budget-submissions`,
`over-budget-triangles`, `untagged`, `unique-materials`, `static-unbatched`, `unsupported-material`, `programs`, `transparent-overdraw`,
`skinned-vertices`, `point-light-shadow`, `shadow-texels`, `transmission`, `transparent-batch-order`, `texture-bytes`,
`static-auto-update`, `particles-over-budget`, `sprites-unbatched`, `js-objects`, `detach-originals`,
`bones-over-budget`, `skinned-crowd`, `geometry-bytes`, `unreferenced-resources`.

### Overlay

`createOverlay(ledger, { budget, parent, intervalMs })` from `threeforge/overlay` shows the head line (backend, tier,
submissions against the budget), the six cost rows, a diagnostics line (unattributed, program switches, programs),
reasons by count and the hints. `formatOverlay`, `formatCostRows` and `formatHints` are the pure formatters.

## 5. Material registry (`MaterialRegistry`)

`register(material)` returns the canonical material for its key without mutating the input. Three keys are computed
(`computeMaterialKeys`): **programKey** mirrors three's `RenderObject.getMaterialCacheKey()` (type, custom program
cache key, which texture slots are set with their mapping/channel/colour space, booleans, enums, feature gates such as
transmission or clearcoat as on/off, defines, node cache keys, the number of clipping planes, material code as below);
**variantKey** adds every non-colour uniform, the texture identities and transforms, clipping plane values, an instance
`onBeforeRender` as below, and `visible=0` when `material.visible` is false (so a hidden material never
merges with an otherwise-identical visible one; `visible` never affects programKey); **colorKey** is the `color`
property, keyed by **exact linear floats** (`color.r/g/b`, three's working colour space), not 8-bit sRGB hex — two
colours under 1/255 apart stay distinct, and an HDR value (a channel > 1) stays distinct from another HDR value that
would otherwise clamp to the same hex. Every other `Color`-valued property (`emissive`, `sheenColor`, `blendColor`,
…) is keyed the same exact way inside variantKey. `describe(material)` also returns **colorHex**
(`color.getHexString()`, 8-bit sRGB), which exists for display only — logs, the CLI, the overlay — and must never be
used for identity or grouping; sprite batching (section 13) groups by the exact `colorKey`, not `colorHex`, for the
same reason. Outcomes: `new`, `merged` (same variant and colour), `color-variant` (batchable through per-instance
colour), `uniform-variant` (the same programKey, another variantKey: uniform values, texture identities, clipping plane
values, `visible`, or an instance `onBeforeRender`), `shader-variant` (another programKey), `unsupported`
(`ShaderMaterial` / `RawShaderMaterial` do not render on `WebGPURenderer`), `unregistered`. `describe(material)` gives
the hashes, `colorHex`/`colorKey` and outcome;
`canonicalOf`, `keys`, and `stats()` (`registered, canonical, merged, unsupported, programs, byProgram[]`).
`hashesOf(material)` returns `{ programHash, variantHash, description, unsupported }` straight from the key cache,
allocating nothing and recomputing nothing: it is the cache entry itself, which `invalidate()` and `forget()` replace
rather than change. `keysRevision` moves whenever either of them drops cached keys, so a caller that memoizes
`hashesOf()` (the ledger, per frame) knows to read again.
`programs` is checked against `renderer.info.memory.programs` in the tests: shader variants counted by the registry
are real programs. The count can exceed the programs three compiles when materials run different function objects or
classes whose code compiles to the same shader (closures from one factory with the same source text, or a subclass
that overrides nothing the shader reads): three compiles one program for those, the registry counts one per function
or class.

**Materials with different code never merge, even when the source text matches.** Material code joins the keys **by
identity** (a number per object from a `WeakMap`, never `toString()`), so two closures from one factory, with the same
text but different captured values, get different keys, while materials sharing the same function object or class
still merge:

- **The class**, in programKey, when the material is not exactly an instance of one of three's own classes
  (`isBuiltInMaterial`, `src/registry/builtInMaterials.ts`). A subclass inherits its base's `type` and can override
  any method (`setup*`, `onBeforeCompile`, `customProgramCacheKey`, `onBeforeRender`); the registry cannot tell which,
  so each subclass is its own program. three's own classes add nothing.
- **Every own function-valued property except `onBeforeRender`**, in programKey (an instance `setup*`,
  `onBeforeCompile`, `customProgramCacheKey` …). three builds the program from them (WebGL keys
  `customProgramCacheKey()` and runs `onBeforeCompile` on the shader source; `NodeMaterial` calls `setup*` to build the
  node graph), so such materials report as `shader-variant`s.
- **An own `onBeforeRender`**, in variantKey. It is not program code on either backend: WebGLRenderer calls a
  material's `onBeforeRender` once per draw, and WebGPU's renderer never calls it (only the object's). Such materials
  report as `uniform-variant`s: one program, but never one batch or canonical.

The compiler groups statics by variantKey, which contains programKey, and `register()` merges by variantKey plus
colour, so a batch or a canonical never draws one material's code for another. A user-added own property
(`material.extra = {…}`, data a hook reads through `this`) is keyed by value when it holds plain data (object
literals, arrays, strings, numbers, booleans, BigInts; a value that contains itself is keyed by its shape, never
overflowing the stack), and by identity for anything else inside it — a function, a `Texture`, an `Object3D`, any class
instance — which is never walked. An array of planes (`clippingPlanes`) keys its length in programKey and each plane's
normal and constant in variantKey; any other non-numeric array is keyed like the plain data above. `userData` stays
out of the key except `forgeKey` (which still overrides everything, code included), and so does EventDispatcher's
`_listeners` (the `dispose` listener a renderer adds to every material it draws). Identity numbers follow the order
objects are first keyed, so a hash that includes one is stable within a run, not across runs (section 4).

**A material is immutable once registered.** `register()` and `describe()` compute a material's keys once and cache
them (together with their `programHash`/`variantHash`, so `describe()` never re-hashes on repeated calls); nothing
in `MaterialRegistry` re-reads a material's properties after that first pass. Mutating a registered material's
properties afterwards is outside the contract: anything already built from its old keys (a `BatchedMesh`, a sprite
batch) stays built from them. Three ways to react to it:

- `invalidate(material)` re-keys it: it removes `material` from every index it was filed under by its *old* keys
  (`canonicalByFullKey`, its program's `canonicals`/`variants` — nothing to remove if it was a merged duplicate
  rather than a canonical), recomputes its keys from its current properties, and re-files it under the *new* ones —
  it stays/becomes the canonical for the new key if no other canonical already holds it, or its record is demoted
  to `{ outcome: 'merged', canonical: <that other material> }` if one does. This closes a real defect: without the
  removal step, a *different*, later material built with `material`'s old property values would still find the
  stale index entry and merge into `material`, silently rendering with its new, mutated state. A material already
  merged into `material` before the call is untouched and keeps resolving to it (a live object) regardless — that
  is the app's choice once it mutates a shared canonical; `invalidate` does not chase down and re-key dependents.
- `forget(material)` removes a material from the registry entirely, as if it had never been registered, unwinding
  `stats()` and its program's bookkeeping (shares its index-removal step with `invalidate`). Forgetting a canonical
  that other materials were merged into leaves those materials' bookkeeping correct — they keep resolving to that
  exact `Material` object — but this is **not** a signal that the object's GPU resources are safe to dispose: every
  one of those dependents is still relying on it rendering correctly, and `forget()` does not track or release
  them. Check `dependentsOf(material) === 0` first, or `forget()` every dependent too before disposing.
- `dependentsOf(material)` counts how many other registered materials currently resolve to `material` as their
  canonical (a live scan of `records`, never cached) — the check `forget()`'s doc comment above calls for.

`World.decompile()` and `ResourceTracker.release()` both call `forget()` for the materials they release, so the
registry's records stop keeping a material nothing references alive: the clones a compile created (batches,
instanced groups, a baked group's tints, the occlusion proxies and the sprite batches) and, in the tracker, a
registered material no other owner still holds. Both forget the materials merged into a canonical before the
canonical itself, and both keep a canonical another registered material still resolves to — the tracker leaves it
registered, and `decompile()` leaves it registered *and* undisposed, since every mesh drawn with that duplicate
still renders through this exact object. Such a canonical is not revisited when its last dependent is released
later; releasing it is then the app's own call (`dependentsOf`). The tracker still never disposes a material the
registry knows.

## 6. Tags and classification

`tag.static(obj)` and `tag.dynamic(obj)` write `userData.forge`; a tag on an ancestor applies to its subtree.
`classify(root, { policy, animations })` decides per mesh, in this order: skinned → morph targets → `ShaderMaterial`
(unsupported) → dynamic tag → parented under a bone → animated by a clip (pass `animations`: clips, or
`{ root, clips }` per animated root so shared bone names resolve correctly) → exclusion rules → static tag → policy
`auto` (untagged plain meshes become static) → `untagged`. Exclusion rules (`exclusionRule(mesh, root?)`): `invisible`,
`invisible-ancestor` (an ancestor up to `root` with `visible = false`, via `isVisibleInGraph`; the mesh's own
visibility is `invisible` above), `already-instanced`, `material-invisible` (`material.visible === false`),
`transmission` (three scales volume thickness by the object matrix, which a batch cannot provide), `dynamic-geometry`
(`DynamicDrawUsage` / `StreamDrawUsage` attributes), `multi-material`, `layers`, `render-order`, `group-render-order`
(the *nearest* `isGroup` ancestor has `renderOrder !== 0`: three's `Renderer._projectObject` reassigns
`groupOrder = object.renderOrder` at every `isGroup` object on the way down — a plain overwrite, not accumulated —
so only the closest Group's value reaches the mesh; a farther Group's `renderOrder` and any non-Group `Object3D`'s
`renderOrder` in between are never read for this), `clipping-group` (an enabled `isClippingGroup` ancestor at *any*
depth — clipping contexts chain, `getGroupContext` builds each one from its parent — WebGPU-only per three's docs,
but the shared `Renderer.js` `_projectObject` that reads it backs both the WebGL2 and WebGPU backends here), `custom-hook` (own
`onBeforeRender`/`onAfterRender`), `draw-range`, `frustum-culled-off`, `mirrored` (a negative determinant relative to
the scene: the world determinant times the scene's; three flips a batch's front face by its own world matrix, the
scene's, never per instance). Every
excluded mesh shows up in the ledger as `excluded:<rule>`. `root` is optional; without it the three ancestor-scoped
rules (`invisible-ancestor`, `group-render-order`, `clipping-group`) are skipped, since there is no boundary to walk
to. `spriteRule(sprite, root?)` shares the same ancestor walker (`ancestorExclusionRule`) for `group-render-order`
and `clipping-group`, plus its own `material-invisible`, `sprite-custom-material` (the material is not exactly a
`SpriteMaterial` or `SpriteNodeMaterial`, or holds its own functions: the batch builds a plain `SpriteNodeMaterial`
and would drop that code), `sprite-node-material` (a node material with any `*Node`
slot set: the batch replaces position and scale nodes and draws object-dependent nodes against itself), `sprite-count`
(`Sprite.count !== 1`: three draws `count` instances of such a sprite), `multi-material`, `sprite-center`, `layers`,
`render-order` and `custom-hook`.

## 7. The scene compiler (`World`)

### `compile()` step by step

1. Install the `PassTracker` scene hooks (always): render depth, open passes and the main camera, for batch culling,
   instancing and sprite batches (see culling).
2. Classify every mesh; record the counts of meshes and distinct materials (`before`).
3. Collect statics; with `dynamics: 'batch-sync'` also collect dynamics that pass every batch rule.
4. `batchStatics`: register materials, group statics by **variant key + geometry attribute signature + castShadow +
   receiveShadow (+ chunk cell)**. Per group: geometry repeated at least `instanceThreshold` times in an opaque group
   becomes a compacted `InstancedMesh` per geometry; the rest becomes one `BatchedMesh` (or, with `bake`, one baked
   `Mesh`); a group of one mesh stays a mesh with the canonical material (`unique-material`, or `static-unbatched` in a frame
   where another object draws that canonical). Batches use the
   canonical material itself when every instance is white, else a white clone with per-instance colour. The clone
   (`cloneMaterial`, also used for a baked group's vertex-colour material) gets back what three's `clone()` drops:
   every function assigned to the instance (`onBeforeCompile`, `customProgramCacheKey`, `onBeforeRender`, a node
   material's `setup*` …), a copy of custom `defines`, `alphaTest` (lost on the `NodeMaterial.copy` path), and, by
   reference, every other own enumerable property the fresh copy lacks (data a hook reads through `this`), except
   EventDispatcher's lazily created `_listeners`, where the renderers keep their `dispose` listeners. It shares the
   source's `userData` object instead of taking three's JSON copy, so a uniform kept there and animated through the
   source reaches the batch, and circular or BigInt `userData` does not throw.
   Non-indexed geometries get an index on a clone (`ensureIndexed`); indices promote to Uint32 as needed.
   Instance matrices, instanced masters and baked vertices are written in the scene's space (see scene space below).
5. Attach BVH culling to every batch (`culling: 'bvh'`), with LOD ranges when `lod` is set.
6. Install matrix sync for batch-synced dynamics and occlusion proxies when enabled.
7. Hide the originals: moved to layer 31 with `matrixAutoUpdate = false` (`originals: 'hide'`), or removed from the
   graph (`originals: 'detach'`); parent indices are recorded so `decompile()` restores the exact order. Then freeze
   (`freeze: true`): unbatched static meshes and every ancestor whose whole subtree is static get
   `matrixAutoUpdate = false` too (`after.frozen`).
8. Annotate everything left alone (excluded rule, `unique-material`, `dynamic`) and swap canonical materials onto
   remaining meshes (`materials: 'canonical'`; `'keep'` leaves each mesh's own instance).
9. Return the `CompileReport`: `before`, `after { batches, instanced, baked, meshes }`, `bake` summary, `groups[]`
   (kind, chunk, lods, program and variant hashes, instances, geometries, transparency, shadow flags, bake report),
   `skipped[]` with rules, registry stats, culling mode, `synced`, `lod`, `occlusion` (`{ proxies, skippedSynced }`), `nestedPasses`.

### Options

| option | default | what it does |
|---|---|---|
| `registry`, `ledger` | new / none | share the registry with the ledger so reasons and programs agree |
| `policy` | `'tagged'` | `'auto'` batches untagged plain meshes too |
| `originals` | `'hide'` | `'detach'` removes originals from the graph (large scenes) |
| `culling` | `'bvh'` | `'linear'` keeps three's own per-instance culling |
| `instanceThreshold` | 64 | repeats of one geometry in an opaque group that become an InstancedMesh |
| `dynamics` | `'separate'` | `'batch-sync'` folds batchable dynamics into batches and syncs their matrices each frame |
| `chunkSize` | off | one batch per world-space cell (tight bounds, streamable) |
| `lod` | off | `{ distances: [d1, d2] }` switches to LOD ranges generated by `prepareLods` |
| `occlusion` | false | occlusion-query proxies per batch / instanced group (`object.occlusionTest` + `renderer.isOccluded`); none for a target holding batch-synced movers |
| `animations` | none | clips or `{ root, clips }` so animated meshes classify as dynamic |
| `nestedPasses` | `'auto'` | `'per-pass'` on both backends; `'reuse-main'` is the other policy (see culling) |
| `materials` | `'canonical'` | `'keep'` leaves each mesh's material instance |
| `bake` | off | `true` or `BakeOptions`: baked mesh per finished group (section 8) |
| `sprites` | `'batch'` | sprites sharing a material become one instanced billboard draw synced each frame; `'keep'` leaves them |
| `spriteThreshold` | 4 | sprites a material needs before its group is batched |
| `freeze` | true | `matrixAutoUpdate = false` on unbatched statics and all-static ancestors; move them with `markDirty` |
| `transparent` | `'batch'` | transparent statics batch/bake like any other group; `'keep'` routes them aside as individual meshes, annotated `transparent-kept` |

Transparent statics batch by default, but three sorts a `BatchedMesh` back-to-front by its own bounding-sphere
centre, not per instance: a transparent batch composites in creation order relative to other transparent
submissions in the same pass, not by true per-object depth against them. `transparent: 'keep'` opts a scene out of
this (its transparent statics stay individual meshes, each sorted by three like any other transparent object), at
the cost of one draw per mesh instead of one per batch; the `transparent-batch-order` hint (info) names it whenever
a threeforge transparent batch shares the main pass with another transparent submission.

### Culling, instancing, chunks, LOD, occlusion

- **Scene space** (`SceneSpace`, `src/compiler/space.ts`): batches, instanced meshes, baked meshes, sprite batches and
  occlusion proxies are children of the scene, so three draws them with `scene.matrixWorld`. Every instance write
  converts an original's `matrixWorld` to `inverse(scene.matrixWorld) * matrixWorld`: batch matrices and instanced
  masters at compile, baked vertices (rebakes included), batch-sync matrices, `markDirty` writes, and sprite centres
  and scales (divided by the scene matrix's column lengths, which three multiplies back in). The inverse is cached and
  derived again whenever the scene's world matrix differs from the one it came from (its 16 elements are compared on
  every use, and a counter, `version`, tells the batch sync that the scene moved, so a synced mover whose world matrix
  did not change is rewritten too). A scene translated, turned or scaled after compile is therefore honoured by every
  later compiled write; a scene without a transform copies world matrices unchanged. Culling and sprite sorting work in
  the object's frame or in world space and are unaffected. `lod.distances` are measured in the object's frame, the
  scene's, so under a scaled scene they are scene units, not world units. Chunk cells (`chunkSize`) are computed in
  world space at compile and the `Streamer` keeps them: streaming assumes the scene does not move after compile.
  Mirroring is decided at compile (`mirrored` is relative to the scene); a scene that becomes mirrored only after
  compile is not handled, except by sprite batches, which check every render and swap `FrontSide`/`BackSide` only
  when the scene's mirroring changed since the last check.
- **BVH culling** (`attachBvhCulling`): a `bvh.js` tree of instance boxes replaces `BatchedMesh`'s linear
  per-instance test. The hook mirrors three's own `onBeforeRender` (fills `_multiDrawStarts/Counts`, the indirect
  texture) and is prepended with `prependRenderHook`, never overwriting the object's hook; hooks are marked with
  `FORGE_HOOK`. The handle offers `move(id)`, `insert(id)`, `remove(id)`, `detach()` and reports its `margin`: 0 for
  a batch of statics, and for one carrying batch-synced movers the largest extent a mover has in the scene's space,
  so a mover's leaf is left where it is while its new box still fits inside the enlarged one instead of being
  refitted on every sync. A margin never changes what is drawn: a BVH candidate still has to pass three's own
  bounding-sphere test, so a wider box only offers more candidates.
- **Instancing** (`createCulledInstancedMesh`): master matrices and colours are kept aside; every frame the visible
  instances are compacted to the front of `instanceMatrix`/`instanceColor` and `count` is set, so culled instances
  cost nothing. LOD levels are separate InstancedMeshes chosen by distance. Handle: `setMatrixAt` (a master matrix, in
  the mesh's parent space), `refreshBounds` (every level's box and sphere from the master matrices, drawn or not),
  `setVisibleAt`, `getVisibleAt`, `detach`.
- **Chunks** (`chunkSize`): groups are split by cell, which gives batches tight bounds (whole-object frustum
  culling), per-cell shadow casting and a natural unit for streaming.
- **LOD** (`generateLods(geometry, { ratios, error, lockBorder })`, `prepareLods(root, options)`, `lodsOf`): meshoptimizer
  `simplify` (with `simplifySloppy` fallback), welding non-indexed meshes first; levels are extra geometry ranges in
  the batch or extra InstancedMeshes, picked by `levelFor(distance, distances)`. `disposeLods(geometry)` disposes the
  levels attached to a geometry and removes them, returning how many: the same levels outlive any one compile and are
  shared by every mesh holding that geometry, so threeforge never disposes them itself — `decompile()` first.
- **Nested passes** (shadow maps, reflections, portals): three renders them from inside another render, a shadow map
  from the first `receiveShadow` object's draw. Every material of a batch reads one index texture; on WebGPU its
  upload lands at once while a pass is submitted only when it ends, and on WebGL that receiving batch draws right
  after the shadow render returns. So batches keep a **stable prefix**: `PassTracker` (scene hooks, marked) knows
  which passes are open, and a nested pass on a batch an open pass has already culled leaves that pass's index rows
  untouched, zeroes the counts of the rows its camera does not need, appends the ids it lacks (LOD by the main
  camera's distance; sorted for its camera when the batch sorts) and marks the texture only when an appended row
  changed; the counts and `_multiDrawCount` come back when the nested render ends (or when the tracker heals after
  a render that threw). `nestedPasses` decides a batch no open pass has culled yet: `per-pass` (the default on both
  backends) culls it for the nested camera, `reuse-main` appends to the rows of its last outermost cull. On WebGPU a
  nested pass issues one draw command per slot, zero-count ones included.
  Compacted instanced meshes keep a stable prefix too, the same under both policies. Above the uniform-buffer limit
  three keeps their matrices in one vertex buffer that syncs once per frame per render object and is checked for
  upload at most once per render call (a nested render advances the call count, so a draw after it cannot upload
  what changed since): a nested pass that reaches a mesh before the outermost render did compacts it for the main
  camera first; a shadow pass keeps the enclosing rows and appends, once per frame and in the same rows for every
  shadow pass, the instances any shadow-casting light reaches (directional and spot frusta, a point light's cube of
  half-size `distance || shadow.camera.far`); any other nested pass draws the enclosing rows; `count` and
  `visibleIds` come back when the nested render ends. On that vertex buffer an outermost compaction marks only the
  rows it changed (`addUpdateRange`), while a nested pass that writes rows marks the whole matrix and colour buffers:
  a receiver's render object runs the instance `OnBeforeFrameUpdate` event before its `ShadowNode` (the position
  stack is flowed before the stage loop in `NodeBuilder.build`), so the shadow render object's own sync replaces the
  main pass's synced ranges before they upload, and the main pass cannot upload again in that render call.

  | Nested pass | Batch, `per-pass` | Batch, `reuse-main` | Compacted instanced mesh (either policy) |
  |---|---|---|---|
  | an open pass culled the object | keep its rows, zero the unneeded, append the missing | same | shadow: keep its rows, append the frame's shadow casters; other: draw its rows |
  | no open pass culled it yet | fresh cull for the nested camera | append to the last outermost rows | compact for the main camera first, then as above |
  | outermost render | fresh cull | fresh cull | compact (skipped while the view and rows are unchanged) |
  | end of the nested render | counts restored | counts restored | `count`, `visibleIds` restored |

- **Occlusion** (`occlusion: true`): a proxy box per batch / instanced group carries `occlusionTest`; its own
  `onAfterRender` reads `renderer.isOccluded()` and hides the target next frame. The proxy is a box over the target's
  bounding box; `markDirty` fits it again (its centre moved, its corners rewritten in place) whenever it recomputes
  those bounds.
  - **Backends and latency.** Both backends run the queries (WebGL2 `ANY_SAMPLES_PASSED`, WebGPU occlusion query
    sets), and both answer late, per render context.
    - **When three reads back.** At the end of a render whose list counted a query, three reads back the results of
      the previous such render. That includes a render whose only counted proxy was at the camera and issued none.
    - **When it publishes.** WebGL checks `QUERY_RESULT_AVAILABLE` synchronously at `finishRender`: it publishes at
      once when the results are ready, and polls by `requestAnimationFrame` only when they are not. WebGPU publishes
      after `mapAsync` resolves.
    - **What follows.** `isOccluded()` answers for a render at least two renders back, with no upper bound. A render
      whose list counts no query publishes nothing.
  - **Only the outermost render decides.** The proxy hooks act only in the outermost render of the scene
    (`PassTracker` depth 1). A shadow map, a reflection or a portal that draws a proxy never shows or hides a target.
    - **Rendered without its own hooks.** The scene can be drawn without its hooks, as a child of another root passed
      to `render()` (depth 0). Its proxies then issue no query and show their targets. Their `occlusionTest` comes
      back in a microtask, once that `render()` call has returned.
  - **One outermost camera per frame.** Occlusion assumes the scene has one outermost render per frame. A second one
    with another camera also sets the shared `target.visible` from its own answers. Examples: a rear-view mirror or a
    minimap into its own `RenderTarget`, or split screen. When it also shares the main render's render context, the
    answers mix and targets visible to the main camera can flicker. three keys a render context by attachment state (the
    target's texture count, format, type, samples, depth and stencil buffers), MRT and call depth (`RenderContexts.get`),
    not by which target it is. Split screen on one target shares it, and so does a separate target with the same
    attachments, such as an RGBA `HalfFloatType` target with the same samples, depth and stencil as the frame-buffer
    target three draws the canvas pass into (`RGBAFormat`, `outputBufferType`, `HalfFloatType` by default).
  - **Warm-up.** `world.warmup()` issues no occlusion query, in either mode. Its frame is scissored to one pixel, so
    every query would count no samples and, once published, hide visible targets. It awaits `renderer.init()` before
    it changes anything, then suspends the proxies, sets the scissor, renders and restores without yielding, so no
    queued re-enable runs in between. It also resumes any proxy a depth-0 render parked, so that proxy is suspended
    with the rest.
  - **Camera at the box.** A query cannot see the target when the camera is inside the box, because every face is
    back-facing. It also misses when the near plane cuts into the box, because a front face in front of the near
    plane is clipped. So in the outermost render the proxy issues no query (its `occlusionTest` is off until that
    render ends) and its targets are shown when either holds:
    - the eye is inside the box grown by twice `camera.near`;
    - the bounding box of the near-plane rectangle meets the box (a wide field of view, an orthographic near plane).

    With no query issued, no late answer can hide the target after the camera leaves.
  - **Batch-synced movers.** A batch or instanced group that holds a `dynamics: 'batch-sync'` mover gets no proxy
    (these targets skip whole-object frustum culling instead).
    - **Why.** A mover can leave the compile-time box. While the target is hidden, three never calls the target's
      render hook, where the sync runs, so nothing could grow the box in time.
    - **Report fields.** `report.occlusion.proxies` counts the proxies installed. `report.occlusion.skippedSynced`
      counts the batches and instanced groups skipped for synced movers, which is the cost of this rule.
  - **Mirrored scenes need nothing.** three flips a mesh's front face when its world matrix mirrors, and the proxy's
    vertices mirror with it, so the `FrontSide` proxy still rasterises the faces toward the eye.

### Runtime API

`world.resolve(intersection)` maps a raycast hit on a batch (`batchId`), an instanced mesh (`instanceId` through the
compaction table) or a baked mesh (`faceIndex` through per-triangle origins) back to the original mesh.
`world.setVisible(original, visible)` hides an instance wherever it went (a baked module rebakes its group).
`world.slotOf(mesh)`, `world.batchedMeshes`, `world.instancedMeshes`, `world.bakedMeshes`, `world.cullingOf(batch)`,
`world.mainCamera`, `world.bakeDebug()`. `world.decompile()` removes everything it built, disposes what it created
(the white clones batches and instanced groups draw with, occlusion proxies, baked geometry and bake clones, sprite
batches), restores layers, matrices, materials and parent order, and allows `compile()` again. A batch or instanced
group whose instances are all white draws with the registry's canonical material itself: that material is the app's,
so `decompile()` never disposes it and it stays usable.

`world.dispose()` tears the World down for good:
- **Decompiles first** when compiled, so `onDirty` listeners still hear `decompile`. That uninstalls the pass tracker's
  scene hooks and removes and disposes the occlusion proxies; a re-enable a depth-0 render queued finds no proxy.
- **Drops every `onDirty` listener.** The registry and the ledger stay the app's, and so do registered materials.
- **Afterwards** a second `dispose()` and `decompile()` do nothing; `compile`, `markDirty`, `setVisible`, `onDirty` and
  `warmup` throw `World is disposed`.

### Warm-up

`world.warmup(renderer, camera, { mode })` builds every pipeline before the first visible frame. Default `frame`
renders one real frame under a 1×1 scissor: the only way in three r186 to get exactly the pipelines the first frame
uses. `async` runs `renderer.compileAsync()` (yields between objects) and then disposes and rebuilds the materials
three compiles wrong that way (transparent double-sided and transmissive ones; see section 13). Result:
`{ mode, textures, repaired }`. Neither mode issues occlusion queries: under the 1×1 scissor every proxy would report
occluded (see Occlusion).

Both modes first await `renderer.init()` when the renderer has it, then render the frame with `render()`, not the
deprecated `renderAsync()`: three logs no deprecation warning, nothing yields between setting the scissor and the
render, and an attached ledger records the warm-up frame as one `main` frame.

### Overdraw modules: sprite batching, ParticleBudget, ResolutionScaler

- **Sprite batching** (`src/compiler/sprites.ts`, `src/compiler/spriteBatch.ts`): `compile()` collects every
  `Sprite`, groups them by material keys (`variantHash` and colour), and for each group of at least
  `spriteThreshold` builds one `Mesh` over an `InstancedBufferGeometry` unit quad with a `SpriteNodeMaterial` that
  takes every field of the group's material through `material.copy()` (`alphaMap`, stencil, clipping planes and the
  rest), except `userData`, which the copy would JSON-serialise and which stays empty on the batch material.
  `alphaTest` is set by hand, because three r186's `NodeMaterial.copy` misses Material's accessor. The batch's own
  `positionNode` and `scaleNode` read per-instance attributes. A sprite whose material is a subclass of `SpriteMaterial`
  or `SpriteNodeMaterial`, or holds instance functions (`setup`, `onBeforeRender` …), is not batched
  (`sprite-custom-material`); nor is one whose node material sets any node slot (`sprite-node-material`), nor one whose
  `count` is not 1 (`sprite-count`). Under a mirrored
  scene the batch swaps `FrontSide` and `BackSide` (checked every render): three flips a mesh's front face under a
  negative world determinant, never a sprite's. The originals go
  to the hidden layer and keep auto-updating; a `FORGE_HOOK` render hook on the batch copies their world
  positions and scales into the attributes once per frame, for the main camera only (an invisible sprite gets
  scale 0; instances outside the four side planes of the frustum are left out, so the count matches what three
  would have drawn), sorted back to front by projected depth when the material blends normally (what three does
  for sprites), and sets `instanceCount`. Nested passes (reflections) draw the main camera's list on both
  backends: three refreshes an object's attributes only on its first render object of a frame, so a second fill
  for a nested camera would be what the main pass draws (section 13). Reason
  `sprite-batch`, name `forge:sprites:<programHash>:<n>`, `after.spriteBatches` in the report; skipped sprites
  carry `sprite-center`, `layers`, `render-order`, `material-invisible`, `sprite-custom-material`, `sprite-node-material`, `sprite-count`,
  `group-render-order`, `clipping-group`, `custom-hook` or `sprite-threshold`. `decompile()` restores.
- **`ParticleBudget`** (`src/overdraw/ParticleBudget.ts`): `new ParticleBudget({ tier, particles?, pointSizeScale? })
  .apply(root)` counts every `Points` object (what its `drawRange` draws), every sprite batch (its instances) and
  every single sprite; over the tier's `particles` budget, points and batches shrink by one common ratio (points
  through `setDrawRange`, batches through `userData.forge.cap`, which the sync hook honours by keeping the nearest
  instances) so the total fits alongside the single sprites, which cannot be capped. `PointsMaterial.size` is
  multiplied by `pointSizeScale` (0.75 on `phone-low`). Returns `{ tier, budget, before, after, ratio, systems }`;
  `release()` restores; `apply()` again re-derives from the originals.
- **`ResolutionScaler`** (`src/overdraw/ResolutionScaler.ts`): `new ResolutionScaler(renderer, { target?, tier?,
  min, max, step, window, ledger? })`; `update(frameMs)` every frame; every `window` frames the median decides:
  above `target × 1.05` the scale steps down, below `target × 0.7` it steps up, clamped to `[min, max]`; a change
  calls `renderer.setPixelRatio(base × scale)` (three resizes the drawing buffer) and updates the ledger's
  `env.dpr`. `set(scale)`, `dispose()`. Overdraw per pixel is unchanged; `overdraw.pixels` shrinks.
- **Ledger**: `overdraw.particles`, `overdraw.pixels`; hints `particles-over-budget`, `sprites-unbatched`; bench
  metrics `particles` and `fillMegapixels` (fragments per pixel × pixels). Conventions for effects: `docs/vfx.md`.

### Per-frame JS: freezing, `markDirty`, `RenderScheduler`

What three pays in JavaScript every frame (r186): `render()` walks every descendant in `updateMatrixWorld()`
(the recursion is unconditional; an object with `matrixAutoUpdate` recomposes its local matrix and forces its
subtree's world matrices) and again in the render-list build (`visible` objects, hidden originals included).
Only `matrixAutoUpdate = false` cuts the recomposing and only removing objects from the graph (`originals:
'detach'`) cuts the walks.

- **Freezing** (`src/compiler/freeze.ts`, `freezableObjects`): at compile, unbatched static-tagged meshes and the
  topmost ancestors whose subtree is entirely static (hidden unsynced originals, static meshes, plain containers;
  nothing dynamic-tagged, animated, lit, skinned, bone or sprite inside) get `matrixAutoUpdate = false` after one
  last `updateMatrix()`. A container freezes only when it also holds at least one such static leaf: an empty
  container, an anchor `Object3D` with no children, and a light's `target` (added straight to the scene, as
  `DayNight` does for the sun) are never frozen, since nothing would ever move their matrix again. `decompile()`
  restores the flags. The village drops from 310 to 34 recomposed matrices per frame with identical pixels.
- **`world.markDirty(object)`** moves a frozen static on demand: recomposes every local matrix under `object`,
  recomputes the world matrices, pushes each batched original in the subtree into its batch in the scene's space
  (`BatchedMesh` matrix and BVH leaf, `InstancedMesh` through its culling handle, a baked group by rebaking once;
  sprite batches follow on their own) and returns the number of instances updated. It then recomputes the bounds of
  each touched batch (`computeBoundingBox`, `computeBoundingSphere`) and instanced group (`refreshBounds`, every LOD
  level) once, so three's whole-object frustum test never culls an instance moved outside its old bounds while it is
  on screen, and fits their occlusion proxies to the new bounds. `world.onDirty(listener)` reports
  `markDirty`, `setVisible`, `compile` and `decompile` (a `RenderScheduler` subscribes to it).
  - **With `originals: 'detach'`**, a detached original has no parent, so `updateMatrixWorld` alone would give its
    own local matrix, not its former scene-relative one. `World` records each detached original's former parent (still
    in the graph; only slotted originals are ever detached) at hide time. `markDirty` on a detached original composes
    its world matrix from that former parent's current `matrixWorld` (read, not recomputed by this call — `markDirty`
    on the parent, or an ancestor reached through the still-attached graph, refreshes it) and the original's own
    freshly recomposed local matrix, instead of the parentless value `updateMatrixWorld` would give. `markDirty` on a
    former parent also reaches its detached descendants (recursively, for a detached original that itself has
    children), even though they are no longer its children in the graph.
  - **The composed matrix and later world-matrix updates.** `markDirty` clears `matrixWorldNeedsUpdate` after
    composing, so an unforced `updateMatrixWorld()` on a detached original with `matrixAutoUpdate` off keeps the
    composed matrix. With `matrixAutoUpdate` on (the default, also for detached originals), any call that recomputes its
    world matrix overwrites the composed one with its local matrix, since it has no parent: `updateMatrixWorld`,
    `updateWorldMatrix`, `getWorldPosition` and the other `getWorld*` calls, and `lookAt`. Call `markDirty` on it again
    after such a call.
- **`RenderScheduler`** (`src/scheduler/RenderScheduler.ts`): `new RenderScheduler({ renderer, scene, camera,
  ledger?, world?, mixers?, watch?, keepAliveMs?, onRender? })`, `start()` drives `renderer.setAnimationLoop`,
  `tick(time)` renders only when `invalidate()` was called, the camera's world or projection matrix changed, a
  watched object moved, a mixer has running actions (mixers are updated every tick), the drawing buffer was
  resized, or `keepAliveMs` elapsed; otherwise three does nothing for that tick. Baselines are re-captured after
  each render (three recomputes the camera's projection on its first WebGPU frame). `stats`, `lastReason`,
  `skippedRecently()` (what `js.skipped` reports through `ledger.attachScheduler`), `stop()`, `dispose()`.
  - **Running mixer:** a mixer is animating only when one of its active actions (three's private
    `_actions[0.._nActiveActions)`, `AnimationMixer.js` r186 ~201-202) is actually `isRunning()`, or is scheduled
    to start later (`_startTime !== null`, set by `startAt()`). `mixer.stats.actions.inUse` (~233) returns
    `_nActiveActions` with no filtering, so on its own it keeps counting a finished `LoopOnce` action that stays
    active — `clampWhenFinished` pauses it (`AnimationAction.js` ~771) and without clamping it is only disabled
    (~772), neither of which removes it from `_actions`; `isRunning()` (~220) is false either way once finished.
    The check reads these private fields through a reflection cast (pinned by a canary test in
    `test/unit/render-scheduler.test.ts`) and falls back to `stats.actions.inUse > 0` for a mixer-like object
    that does not expose them (a test double, or a future three version that renames them). `isRunning()` does
    not consult `weight`, so an active, enabled, unpaused action with `weight === 0` still counts as running —
    the scheduler deliberately errs toward rendering here, since a `fadeIn()` starts its target action at weight
    0 and a skipped tick would miss the start of the fade.
  - **Matrices:** `cameraChanged()` and `watchedChanged()` (and `watch()`, for the initial baseline) call
    `object.updateWorldMatrix(true, false)` before reading `matrixWorld`: three does not recompute it just
    because a property changed, only a render pass or an explicit update call does, so moving `camera.position`
    or a watched object's transform without calling `updateMatrixWorld()` is still detected. Do not `watch()` a
    detached original (`originals: 'detach'`): this per-tick `updateWorldMatrix` call is exactly the hazard
    described above under "The composed matrix and later world-matrix updates" — with `matrixAutoUpdate` on (the
    default), it overwrites the world matrix `markDirty` composed for a detached original with a parentless one,
    every tick. Watch the live object you actually move instead.
  - **A disposed `World`:** the scheduler holds only the disposer `World.onDirty()` returns, and calls it once
    from `dispose()`; it never calls back into the `World` at tick time. Constructing a scheduler against an
    already-disposed `World` throws immediately — that is `World.onDirty()`'s own fail-fast guard, not scheduler
    code. Disposing the `World` after the scheduler is already running does not throw anywhere: `World.dispose()`
    clears its dirty-listener set, so the scheduler's subscription is silently dropped, but a disposed `World`
    can never legitimately emit another dirty event (every mutator throws once it is disposed), and every other
    detector (`invalidate()`, camera, watched objects, mixers, resize, `keepAliveMs`) keeps working normally.
    `scheduler.dispose()` is safe to call before or after `world.dispose()`.
- **Ledger**: `js.hiddenOriginals`, `js.skipped`; budget `objects`; hints `js-objects` (over budget) and
  `detach-originals` (1 000 or more hidden originals: `originals: 'detach'`); bench metrics `objects` and
  `autoUpdatedMatrices`.

### Lighting: `DayNight`, `ShadowBudget`, lightmaps

- **`DayNight`** (`src/lighting/DayNight.ts`): one sun on a circle (rise 6, set 18, a faint moon below), a
  gradient sky dome (`sky-dome`, vertex colours, static-tagged so it freezes and draws once), a hemisphere light,
  fog and background following the horizon; `setTime(hours)` drives all of it and requests a shadow-map render
  only when the sun moved `everyDegrees` (default 0.5) since the last one, through `shadow.needsUpdate` with
  `autoUpdate` off. The dome's vertex colours are rewritten only when the zenith or horizon colour differs from the
  one they were last written from, so stepping the hour within an unchanging palette costs no vertex walk and no
  re-upload. `refreshShadow()`, `dispose()`. The day/night benchmark renders the map every second frame.
- **`ShadowBudget`** (`src/lighting/ShadowBudget.ts`): `apply(scene)` switches shadows off on the `off` tiers,
  drops point-light shadows off phones, then halves the largest map until the texel sum fits the tier's
  `shadowTexels` budget (floor `minMapSize`); three resizes the targets on the next shadow render. `release()`
  restores. `ShadowBudget.freeze(light)` returns a `refresh()` for static lights.
- **Lightmaps**: the registry keys `lightMap` and its channel, `attributeSignature` includes `uv1`, and the bake
  carries and welds every UV set, so lightmapped statics batch and bake without losing their coordinates.
  Authoring notes: `docs/lighting.md`.
- **Bench**: `shadowPassesPerFrame` and `shadowTexels` (means over the measured frames, texels rounded) are gated; the optimized day/night and boss
  fight apply `ShadowBudget` for the detected tier.

### Skinning: `bakeAnimationTexture`, `AnimatedInstances`

- **`bakeAnimationTexture(prototype, clips, { fps })`** (`src/skinning/bakeAnimationTexture.ts`): plays every clip
  on the prototype at the origin (`LoopOnce`, clamped, so the last row is the end pose) and copies every distinct
  skeleton's `boneMatrices` into one RGBA float `DataTexture`: a row per frame, four texels per bone, skeletons
  after each other (`parts[i].boneOffset`); `clips[i]` = `{ name, start, frames, duration }`, `parts[i]` =
  `{ mesh, matrix, boneOffset }`. The prototype's transform and pose are restored.
- **`AnimatedInstances({ animation, count, material? })`** (`src/skinning/AnimatedInstances.ts`): one `Mesh` per
  part over an `InstancedBufferGeometry` sharing the part's buffers, `MeshStandardNodeMaterial` with a TSL
  `positionNode` that fetches the instance's four bone matrices for its current row (`clipStart + floor(mod((time
  × speed + offset) × fps, frames))`), applies `bindMatrixInverse × Σ bone × weight × bindMatrix`, then the part's
  offset (`parts[i].matrix`, a `mat4` uniform of that part's material, read every frame) and the instance matrix, and
  assigns `normalLocal`. The instance matrices, the characters' own, live in one `InstancedInterleavedBuffer` the parts
  share (four separate attributes would exceed WebGPU's eight vertex buffers; a plain `InterleavedBuffer` is read per
  vertex, because both backends take the per-instance step from `isInstancedInterleavedBuffer`). `setMatrixAt` stores
  the character's matrix and `getMatrixAt` returns it, `setClipAt(i, clip, { offset, speed })`, `setTime(seconds)`,
  `addTo`, `dispose`. Meshes are
  `forge:vat:<part>` with `userData.forge = { kind: 'vat', instances }` (untagged: a tag overwrites the marker).
- **Ledger**: reason `vat-instanced`, `skinning.vatInstances` / `vatVertices`, budget `bones`, hints
  `bones-over-budget` and `skinned-crowd` (50 skinned draws). Authoring notes: `docs/skinning.md`.
- **Bench**: the optimized crowd bakes each of its eight prototypes and replaces its 25 characters with one
  `AnimatedInstances`: 401 → 17 submissions, 271 k skinned vertices → 0.

### Memory and load: `createLoader`, `ResourceTracker`, `Streamer`

- **`createLoader(renderer, { decoders, draco, ktx2, meshopt })`** (`src/load/createLoader.ts`): a `GLTFLoader` with
  Draco, KTX2 (`detectSupport` after `renderer.init()`) and meshopt wired; the addons import lazily.
  `disposeLoader(loader)` ends the worker pools. `threeforge decoders <dir>` (`src/cli/decoders.ts`) copies the
  decoder files from the installed three.
- **`ResourceTracker`** (`src/memory/ResourceTracker.ts`): `track(root | geometry | texture | material, owner?)`,
  `release(owner)` disposes what no other owner holds (never a material the registry knows) and detaches an
  Object3D owner, `dispose()`, `stats()`. `collectResources(root)` and `unreferencedResources(info, scene,
  allowance)` are the building blocks (`src/memory/resources.ts`).
- **`Streamer`** (`src/streaming/Streamer.ts`): residency of `world.chunks()` (batches, instanced groups and baked
  meshes carry `userData.forgeChunk`) plus uncompiled static scene children placed by position, keyed by x and z.
  Resident while the ground-plane distance from the camera to the cell's box is at most `radius` (default
  `camera.far`), unloaded past `radius + margin × chunkSize` (first update strict). Unload removes the objects and
  disposes the geometries and textures no resident chunk shares, including a BatchedMesh's matrix, indirect and
  colour textures (never `BatchedMesh.dispose()`, which nulls them); load re-adds them and three re-uploads. `assign`,
  `userData.forgeStream = false`, `stats()`, `onChange`, `dispose()` (every chunk resident again, then the chunks and
  the object index released, so a disposed Streamer holds none of the World's objects and `stats()` reports none).
  `ledger.attachStreamer(streamer)`.
- **Ledger**: `memory.unreferenced`, `memory.chunks`, `memory.measured`; budget `geometryBytes` (256 / 96 / 48 MB); hints
  `geometry-bytes` and `unreferenced-resources` (eight or more). Authoring notes: `docs/memory.md`.
- **Bench**: zen's ground is 64 tiles with a 512² texture each (85 MB) under fog to 600 m; the optimized variant
  streams them: 32 of 64 chunks resident at the start camera, pixel-identical to naive.

## 8. Bake: one mesh per finished group

`new World(scene, { bake: true | options })` replaces the `BatchedMesh` of each finished static group with one
world-space `Mesh` (`bakeGeometries` in `src/compiler/bake.ts`; every UV set present in all entries, `uv` to `uv3`,
is carried and compared by the weld):

1. **Gather**: positions and normals transformed to the scene's space (world space for an untransformed scene;
   mirrored matrices flip winding), uv when every module has it, tangents when every module has them (xyz turned by
   the module's matrix and normalised, `w` kept as it is: three builds the bitangent as
   `cross(normalView, tangentView) * tangent.w` with no determinant term, so flipping `w` under a mirrored matrix
   would change the normal-mapped shading), colour from vertex colours × instance tint, where the vertex colours
   count only when the module's material reads them (`BakeEntry.vertexColors`; with a tint the material becomes a
   `vertexColors` clone, and a rebake keeps the flag recorded at bake time).
2. **Contact seams**: triangles are grouped by plane, split into the two facing sides and merged into islands along
   shared edges. An island is paired only when it covers its region exactly once: every edge (by position) is used at
   most twice inside it (an edge used three times drops out of the outline, so regions of different size could share
   one), and no two of its triangles overlap by more than `tolerance` in the plane (a doubled area could otherwise hide
   behind a matching outline). Its outline is then the set of edges used once, and two such islands with the same
   outline cover the same region, whatever their triangulations. An island whose outline equals an island's on the
   other side is a coincident, opposite-winding pair. Both islands go as a seam between touching solids only when all
   five hold:
   1. the two islands come from disjoint sets of modules (entries);
   2. every module involved is a closed, manifold, outward shell: every edge (by position) is used exactly once in
      each direction, and every connected component encloses a positive signed volume (computed once per module in
      the baked space, after the winding flip for a mirrored matrix, so a mirrored outward shell stays outward). An
      edge shared by two parts of one module, used four times, fails this test;
   3. every module involved draws front faces only (`BakeEntry.side` is `FrontSide`, set by `bakeEntriesOf`): a
      `BackSide` material draws exactly the faces a seam hides (from inside a modular room the shared wall is the
      nearest drawn surface), and a `DoubleSide` one draws both;
   4. no module involved casts shadows (`BakeEntry.castShadow` is `false`, copied from each original; three's default):
      non-VSM shadow maps draw a front-side material's back faces (`WebGLShadowMap.js`, the shadow override in
      `renderers/common/Renderer.js`), so a seam face is the nearest caster for the neighbouring module's face turned
      away from the light, which a toon ramp still lights at 0.7 × light × shadow. A shadow-casting static keeps its
      seam faces. A rebake (hiding or showing a module) decides every removal again, counting a module as casting when
      its original or the baked mesh casts: once neither casts, the next rebake may remove the seams, and turning
      casting on for either after compile keeps the faces only after the next rebake or a `decompile()` and
      `compile()` (until then the baked mesh casts without them);
   5. every module involved is opaque, by an allowlist of three's default material hooks (`BakeEntry.opaque`, set by
      `bakeEntriesOf`): exactly one of three r186's 35 material classes (`isBuiltInMaterial`: the 18 of
      `src/materials/Materials.js` and the 17 of `src/materials/nodes/NodeMaterials.js`; a subclass fails, since an
      overridden method such as a node material's `setup*` builds the shader and can discard); no function assigned to
      the instance (`hasOwnFunctions`: no instance `onBeforeRender`, `setup`, `setupOutput` …); not transparent; normal
      or no blending; no `alphaTest`, `alphaHash`, `alphaToCoverage` or
      `transmission`; not a `ShaderMaterial`; every node slot empty (every `*Node` property, such as `colorNode`,
      `opacityNode`, `outputNode`, `positionNode` or `fragmentNode`, and any other own property holding a node, is
      null, because `Discard()` can sit in any of them: node-material statics authored with custom nodes keep all their
      faces); `onBeforeCompile` and `customProgramCacheKey` are three's own (`Material`'s, or `NodeMaterial`'s for a
      node material); `defines` holds only three's material defines (`STANDARD`, `PHYSICAL`, `TOON`, `MATCAP`); no
      `displacementMap`, material `clippingPlanes` or `polygonOffset`; `depthFunc` is `LessEqualDepth`; depth write and
      depth test on; no `wireframe` or `stencilWrite`. Renderer-level clipping (`renderer.clippingPlanes`) is outside
      what the bake can see. A rebake keeps the decision made at bake time and requires the current material (for a
      tinted group, its vertex-colour clone) to pass too, so a rebake never removes more than the bake allowed.

   Every other coincident, opposite pair stays and is counted in `keptCoincidentFaces` (only faces the bake does not
   remove otherwise, so a kept face that is later buried is not counted): back-to-back sign cards, a floor lying on a
   ceiling, a pair inside one module, a back-side, double-sided, translucent or shadow-casting pair, a face against a
   flat slab, an open box, an inside-out box, a shell joined to another part by a shared edge, an island whose triangles
   overlap. Islands with an edge used three or more times are not paired at all, and partial overlaps stay too.
3. **Duplicates**: the exact same triangle twice (same points, same winding: a module placed twice) keeps one, and only
   between modules whose faces may be removed (opaque, front-side, casting no shadow). Two islands on the same side of a
   plane never share an outline (shared outline edges fuse them into one island), and a region covered twice with
   different triangulations fuses into one island with no outline at all: it is skipped and stays doubled, an
   invisible cost.
4. **Buried faces** (opt-in `removeBuried`): 24 rays over the front hemisphere from each face, cast against a BVH of
   the group's opaque faces of front-side or double-sided modules (three-mesh-bvh), counting only hits on a triangle's
   back side: a viewer beyond the hit, looking back along the ray, then sees that triangle drawn (a front-side card
   facing the face shows such a viewer its culled back, so it blocks nothing; a face pressed against a neighbouring
   solid's front face is buried only when that solid's far side is within `distance`). The face is buried only if every ray is
   blocked within `distance` measured along the face normal (default 0.1 units): solid right in front of it. Only faces
   of opaque, front-side modules that cast no shadow are removed; room interiors and open backsides survive; back-side
   faces never block a ray (a back-side shell draws its far wall behind whatever is inside it).
5. **Weld**: vertices merge only when position (`tolerance`, default 1e-4), normal and tangent xyz (`normalAngle`,
   default 0.5°), tangent `w` (exact), uv (exact) and colour (`colorTolerance`, default 1/255) agree, so shading
   never changes.

**Direct `bakeGeometries` callers**: `bakeEntriesOf` (and so `World`) sets every entry flag from the material. An
entry without `opaque` counts as not opaque, so it gets no seam and no buried-face removal (a missed deletion is
invisible, a wrong one is visible); an entry without `vertexColors` keeps multiplying its geometry's colour attribute
by the tint, as before; an entry without `side` counts as not front-side, so it loses no faces either
(`doubleSided: true` has the same effect); an entry without `castShadow: false` counts as a shadow caster and loses no
faces.

Control and inspection: `mesh.userData.forgeBake = false` passes a module through untouched; the compile report's
`bake` block counts seams, coincident faces the seam guard kept and the bake left in place (`keptCoincidentFaces`),
duplicates, buried faces,
welded vertices and excluded entries (the CLI prints the kept count next to the seams); `world.bakeDebug()`
returns a copy of the removed faces as red unlit meshes, a snapshot the caller owns and disposes (a later rebake or
`decompile()` never touches it); hiding a module rebakes its group; `decompile()` restores. Instanced
groups and batch-synced dynamics are never baked. The CLI's `analyze --bake --views N` bakes and checks pixel parity
from N+1 camera angles. Verified: the village bake is pixel-identical; a 6×3 modular wall loses exactly its 27
seams, also under a mirrored scene; back-to-back sign cards and a floor lying on a ceiling keep both faces, seen from
both sides; touching back-side rooms keep their shared wall, seen from inside and from outside; touching toon boxes
that cast shadows keep their seam, lit along it with shadows on; a mirrored, normal-mapped mesh baked by
`bakeGeometries` keeps its tangents and its pixels; a block 5 cm
inside a solid goes only with `removeBuried`; the 2CylinderEngine assembly stays identical over four views on both
backends.

## 9. Character assembler

`assembleCharacter({ skeleton, wardrobe, equipped, atlas: { size }, material })` merges skinned parts onto one shared
skeleton: bones are remapped by name, textures are packed into a k×k grid atlas (a `DataTexture` in node, an
`OffscreenCanvas` in the browser) with uv clamping and a half-texel inset, and one skinned mesh with one material
results. `equip(part)` / `unequip(part)` rebuild only the vertex buffer; the draw count never changes. The report
gives the atlas cells (`cellOf`), bones, vertices; `dispose()` frees the atlas. This is the "PolyMorph lesson": gear
swaps change data, not draw calls.

## 10. For AI agents: hook, CLI, MCP

- **Hook**: `exposeToAgents({ ledger, world, renderer, scene, camera })` publishes `window.__threeforge` with
  `version`, `schemaVersion` (3, the frame snapshot's), `frame()`, `frameAsync()` (waits one animation frame so shadow
  maps update, renders if it can), `compile()` / `decompile()`, `measureOverdraw()`, `measureMemory()`, `hints()`,
  `report()`. Returns a disposer.
  It lets any script on the page call `compile()`/`decompile()` and read the ledger, so call it as
  `if (import.meta.env.DEV) exposeToAgents(...)` (Vite) or behind your own flag, never unconditionally in a shipped
  build; bundlers other than Vite need their own dev check.
- **CLI** (`npx threeforge` with no arguments, `threeforge help [<command>]`, or `--help` on any command prints
  AGENTS.md). Every command's positionals and flags are declared once in `COMMAND_SPECS` (`src/cli/args.ts`); the
  parser, the usage text printed after a usage error, and the AGENTS.md command and flag tables come from it.
  - `analyze <file.glb|.gltf> [--backend webgl2|webgpu] [--tier auto|desktop|phone-mid|phone-low] [--budget N]
    [--frames N] [--no-compile] [--timeout ms] [--headed] [--bake] [--bake-buried] [--views N] [--json]`: serves the
    shipped harness page and the asset's folder from a built-in static server on 127.0.0.1, launches headless Chromium
    through Playwright (headless shell for WebGL2, full Chromium with WebGPU flags otherwise), loads the asset with
    Draco/KTX2/meshopt support, measures N frames (default 30), overdraw and memory, screenshots the default framing
    plus the orbit views, compiles, measures and screenshots again, computes pixel parity per view, and prints one
    JSON document.
  - `inspect <url> [--backend webgl2|webgpu] [--budget N] [--frames N] [--no-compile] [--timeout ms] [--headed]
    [--json]`: drives the agent's own dev server through the hook, compiling through it unless `--no-compile`
    (`--compile` is accepted and is the default); same document without asset facts and parity. There is no
    `--tier`: the app measures itself at the tier its own ledger detects. The app's hook must publish
    `schemaVersion: 3` (threeforge 0.9.0 or later): any other version exits 4 at once, before anything is measured,
    with a message naming both versions and the fix, e.g. `window.__threeforge has unsupported schemaVersion 2:
    this threeforge CLI reads schemaVersion 3; upgrade threeforge in the app (exposeToAgents)`. `analyze`'s own
    measurement (`measureViaHook`) rejects an unsupported hook version the same way.
  - `optimize <file.glb|.gltf> [--out out.glb] [--preset safe|balanced|aggressive] [--no-<step>|--<step>]
    [--simplify [ratio]] [--simplify-error e] [--compress none|meshopt] [--textures [webp|avif|none]]
    [--texture-size N] [--texture-quality Q] [--no-verify] [--parity pct] [--views N] [--budget N] [--backend …]
    [--tier …] [--frames N] [--no-compile] [--timeout ms] [--headed] [--json]`: the build-time pipeline, see below.
  - `explain [<hint-code>] [--all] [--json]`: `{ code, category, severity, meaning, fix, api, docs }` for one hint
    code, or every remedy with `--all` (a code or `--all`, not both).
  - `decoders <dir>`: copies three's Draco decoder and Basis transcoder into `<dir>/{draco,basis}` for `createLoader` (no JSON output, no flags).
  - `schema [snapshot|analyze|inspect|optimize|all] [--json]`: JSON Schema (draft 2020-12) of everything printed
    (always JSON). Each of the four schemas is self-contained: `analyze` and `inspect` embed the frame snapshot as
    `$defs.FrameSnapshot`, and `optimize` embeds both that and the analyze document as `$defs.AnalyzeDocument`
    (`verify.original`/`verify.optimized` are full analyze documents), rather than `$ref`-ing another schema's
    `$id`. Copy any one of the four out of `threeforge schema <name> --json` and it validates on its own in any
    draft-2020-12 validator (e.g. `ajv/dist/2020`), with no `addSchema` of the others.
  - `mcp`: stdio Model Context Protocol server with `analyze_asset`, `inspect_app`, `optimize_asset`, `explain_hint` (no arguments).
- **Flags** (`parseArgs`, `src/cli/args.ts`):
  - Flags follow the command, before or after its argument. A value flag takes `--flag value` or `--flag=value`; a
    boolean flag never takes one (`analyze --json scene.glb` parses), and a negatable one also accepts
    `--no-<flag>`. `--simplify` and `--textures` take a value only after `=` or when the next argument is a valid
    value (a number, a format), so `optimize --simplify scene.glb` keeps the file. `--` ends the flags.
  - `--timeout ms` bounds each page step (the load, every evaluate, the whole N-frame measurement, `compile()`;
    default 60000, a step over it exits 4). `--headed` shows the browser. `--simplify-error e` is the simplify error
    limit as a fraction of the mesh radius (default 0.001). `--texture-quality Q` is the encoder quality (default 85).
    `--textures none` and `--compress none` leave those steps out.
  - Usage errors (exit 2, nothing on stdout; the message and the usage text on stderr): an unknown flag (the nearest
    flag of the command is suggested, or the commands that take it are named), a flag before the command, an extra
    positional, a value on a boolean flag, a missing value, a flag given twice or with its negation, a malformed
    number (hex, `Infinity`, empty), a number outside `RANGES`, `inspect --tier`, `explain <code> --all`, and
    `optimize --budget` with `--no-verify` (the budget is judged on the verified render).
  - `RANGES` (by input field; `validateInput(command, input)` checks them plus the cross-field rules and is exported
    for the MCP server): `frames` an integer ≥ 1, `timeout` an integer from 1000 to 2147483647 (a longer Node timer
    fires at once), `budget` an integer ≥ 0, `views` an integer from 0 to 64, `parity` 0 to 100, `simplify` in
    (0, 1], `simplifyError` 0 to 1, `textureSize` an integer from 1 to 16384, `textureQuality` an integer from 1 to 100.
- **The document**: `{ schemaVersion: 1, tool, version, command, input, env, asset, before, after, compile, parity,
  hints, verdict, timings }`. `verdict.pass` is false over the budget, with an error-severity hint, when parity is
  lost, or when the harness page raised an error (`analyze`; one reason quotes up to five, cleaned and capped; `inspect`
  does not judge its app's page errors). Exit codes: 0 pass, 1 verdict failed, 2 usage/input, 3 environment (install command in the message),
  4 page error/timeout. `--json` writes the JSON document to stdout before the human summary is built
  (`printDocument`), then the summary to stderr; a summary that throws leaves a note on stderr and the document intact.
  `before` and `after` are frame snapshots with their own `schemaVersion: 3`; their `js.renderMs`, `js.ledgerMs` and
  `js.frameMs` are medians over the measured frames.
- **Programmatic**: `import { analyzeAsset, inspectApp, optimizeAsset, explain } from 'threeforge/cli'`.
- Playwright, `@modelcontextprotocol/sdk` and `zod` are optional peers imported lazily; game code never pays for them.

### Build-time optimize (`threeforge optimize`)

`src/cli/pipeline.ts` (pure), `src/cli/transform.ts` (glTF-Transform), `src/cli/optimize.ts` (the command).

- **Steps**, in the order glTF-Transform recommends: `dedup` (identical accessors, meshes, materials, textures become
  one), `instance` (repeated meshes → `EXT_mesh_gpu_instancing`), `palette` (materials that differ only by factors
  become one material sampling a nearest-filtered palette texture; textured materials are left alone), `flatten`,
  `join` (meshes sharing a material merge; implies flatten), `weld` (exact duplicate vertices), `simplify`
  (meshoptimizer, ratio and error), `resample` (redundant animation keyframes), `prune` (unused properties),
  `textures` (sharp: WebP or AVIF, longest side, quality), `quantize` (`KHR_mesh_quantization`), `meshopt`
  (`EXT_meshopt_compression`, replaces quantize because it quantizes itself).
- **Presets**: `safe` = dedup, palette, weld, resample, prune (nothing an eye can see changes; the Fox and the
  Buggy e2e assert 0 % pixel difference). `balanced` = safe + quantize + textures webp 2048 px. `aggressive` =
  balanced + simplify 0.5 + textures 1024 px. `--<step>` / `--no-<step>` override a preset; `--simplify`,
  `--textures`, `--compress meshopt` enable their step with the given value. `--instance`, `--join` and
  `--compress meshopt` are never in a preset: the first two change the node graph game code may address by name,
  the third needs `loader.setMeshoptDecoder`. A preset's texture step without `sharp` installed is skipped with a
  note; an explicit `--textures` without it is an environment error (exit 3), as is a Draco input without
  `draco3dgltf`. The output never uses Draco.
- **Inputs and `--out`** (`src/cli/gltf-uris.ts`): every `images[].uri` and `buffers[].uri` of the input (a `.gltf`, or
  a `.glb`'s JSON chunk) must be a `data:` URI or a relative path that stays inside the input's directory, also by real
  path (symlinks followed). An absolute path, any other scheme (`file:`, `http:`, `C:`), a backslash, a NUL or invalid
  percent-encoding exits 2 before glTF-Transform reads anything. `--out` must end in `.glb` or `.gltf` (any case; a
  `.glb` is always written binary) and must not be the input file (same device and inode: a hard link, a symlink, a
  case variant) or one of its resources. A `.gltf` output whose resource URIs would leave its directory, or whose
  resource would land on the input or on one of the input's resources (same path, or same device and inode), exits 2
  before anything is written: glTF-Transform keeps each resource's URI, so a `.gltf` output beside a `.gltf` input
  would rewrite the input's `.bin` and textures. Write it to another directory, or as `.glb`.
- **Report**: `stats.before/after` (bytes, nodes, meshes, primitives, materials, textures, texture bytes, accessors,
  vertices, triangles, animations, skins, morph targets, extensions), one `steps[]` entry per step with the counts
  before and after and the time, `requires[]` (each extension of the output with the loader piece it needs and the
  line of code, `code: null` when `GLTFLoader` handles it alone), and `verify` when on (default): the original and
  the optimized file go through `analyze` with the same framing, frames and views; `verify.parity` compares the two
  naive renders view by view, `verify.original` / `verify.optimized` are the full analyze documents, `verify.delta`
  is after minus before for bytes, materials, vertices, triangles, naive and compiled scene submissions, load time
  and estimated GPU memory.
- **Verdict**: fails on parity over `--parity` (default 0.5 %), a lost animation, skin or morph target (checked in
  the glTF document and, when verified, in what the harness loaded), `--budget` exceeded by the optimized file's
  compiled submissions, an error-severity hint on the optimized file, or a page error in either verified render. Deltas are never judged: a
  palette texture can grow a file that then draws in one call.
- **Limits**: no atlasing across materials that differ by textures (the biome case still needs one batch per
  texture set), no KTX2 encoding (needs `toktx`), no `MSFT_lod` chains, no Draco output.

## 11. Benchmark suite and regression gate

Eight scenes in `test/app/scenes`, each with a naive assembly and an optimized path (`world.compile()` plus the
budgets the scene stresses):

| id | scene | stresses |
|---|---|---|
| `village` | 300 props from 40 shapes, 40 materials, 10 dynamics, 2 skinned | static batching, registry |
| `forest` | terrain, 5 000 trees of 3 species, 2 000 grass patches | instancing, LOD, culling |
| `crowd` | 200 skinned Kenney mini characters, all animating | skinning budget, animated instances |
| `bossfight` | arena, 12 fighters, 16 blocky characters, 30 VFX systems, shadowed lights | overdraw, transparency |
| `lake` | reflective water, 2 000 rain sprites, fog, wet ground | fill rate, weather |
| `daynight` | the village under a sun cycle with a 2048² shadow map | lighting, shadows |
| `zen` | 50 000 low-poly objects over 2 km² on 64 textured ground tiles, 250 m chunks, fog to 600 m | chunk streaming, memory |
| `rpg` | portrait 9:16, one character, gear swapped every 30 frames | character assembler |

`pnpm bench [backend]` measures 10 warm-up and 60 measured frames per variant (medians), one overdraw and memory
measurement, writes `bench/results/local.<backend>.json` and fails when any deterministic metric (submissions, GPU
draws, triangles, programs, overdraw, skinned vertices, shadow casters and texels, memory bytes) is worse than
`bench/baselines/<backend>.json` by 10 % or more; timing is recorded and gated only with `FORGE_GPU=native` (CI
runners render on SwiftShader). `pnpm bench:baseline` promotes results and rewrites `docs/bench.md` and the README
table. Current baselines: village 303 → 28, forest 5 706 → 13, bossfight 2 780 → 424, daynight 605 → 55,
zen 10 879 → 125, rpg 4 → 1, crowd 401 → 17, lake 3 548 → 7.

### Device bench page

`bench-app/` is a static page (`pnpm bench:app` to run it, `pnpm build:bench-app` to build it, the `pages` workflow
deploys it to GitHub Pages) that runs the same eight scenes on the visitor's device. It imports `BENCH_SCENES`
unchanged (the two scenes that fetch files take their URLs from `BenchContext.url()`, so the page works under a
Pages base path) and `test/app/benchMetrics.ts`, which the CI runner also imports, so the metrics cannot drift.
It picks WebGPU when `navigator.gpu` exists and `renderer.init()` succeeds, else WebGL2 (`?backend=webgl2` forces
it); each scene gets a fresh registry and ledger, runs 10 warm-up and 60 measured frames with the deterministic
clock, one overdraw measurement, then `decompile()` and disposal of every geometry, material and texture before
the next scene, so phones do not run out of GPU memory. A two-second fill-rate probe (transparent fullscreen layers,
doubled until a frame misses vsync) is reported as `env.fillRateGPix`, informational. The result
(`{ schemaVersion: 1, kind: 'device', id, createdAt, env, scenes }`, `scenes` identical to a `pnpm bench` result)
is submitted as a prefilled GitHub issue (metrics travel as arrays in `metricKeys` order to keep the URL short; a
copy-and-paste fallback uses the issue template). `scripts/bench-ingest.mjs` extracts the JSON fence, expands the
wire form, validates it with `scripts/bench-schema.mjs` (exact key sets, finite non-negative numbers, capped
strings, known scenes, `unattributed === 0`), writes `bench/devices/<id>.json`; `scripts/bench-devices.mjs`
rewrites `docs/devices.md` and `bench/devices/index.json` (served as `devices.json` on the page). The
`bench-results` workflow runs on issues titled `bench:` or labelled `bench-result`, commits, and closes the issue
with the file name; a rejected result gets the validation errors as a comment. Device numbers are published, never
gated.

## 12. Development, tests, CI, release

- `pnpm dev` opens the harness (`test/app`, `window.__forge`) with query parameters: `scene=naive|field|character|
  gltf&asset=<name>|biome|arena|empty|vat` (the animated-instances twin of `asset`; `vatClip`, `vatTime`) or a
  bench scene with `variant=naive|optimized`, `backend`, `compile=1`,
  `overlay=1&budget=30`, `animate=1`, `dynamics=batch-sync`, `lod=1`, `chunk=40`, `culling=linear`, `threshold=N`,
  `occlusion=1`, `wall=1`, `shadows=0`, `freeze=1`, `sceneOffset=1` (the whole scene translated, turned and scaled, the camera following), `materials=keep`, `nested=per-pass|reuse-main`, `bake=1|buried`, `env=0`,
  `bloom=1`, `assemble=1`, `fighters`, `blocky`, `vfx=0`, `t`, `density`, `count`, `tier`.
- `pnpm build:lib && node scripts/ledger-overhead.mjs [submissions…]` reports the ledger's own µs per submission and
  bytes per frame (section 4, "Overhead"); it is not a gate.
- `pnpm test` (Vitest, 199 units against a fake renderer that mirrors the backends' draw counting), `pnpm e2e`
  (Playwright, projects `webgl2` and `webgpu`; screenshot baselines without platform suffixes), `pnpm budget` (naive
  scene ≤ 30 submissions), `pnpm assets` / `pnpm assets:kits` (public glTF corpus and Kenney kits, gitignored),
  `pnpm assets:report` (104 assets compiled with pixel parity on each backend), `pnpm bench`, `pnpm build` (library
  via tsc plus the CLI harness page via Vite), `pnpm typecheck`.
- CI (`.github/workflows/ci.yml`): unit job, bench job per backend (assets cached, build, e2e, bench gate), publish
  job on `v*` tags with `npm publish --provenance` (needs the `NPM_TOKEN` secret; see `docs/release.md`).
- Repository rules for agents working in the repo: `CONTRIBUTING.md`.

## 13. What we learned about three r186 (and how threeforge works around it)

- `renderer.compileAsync()` queues `renderObject()` work and builds it after `material.side` is restored and the render
  context is null: transparent double-sided and transmissive materials compile as single-pass DoubleSide and
  transmission binds a viewport texture no frame writes. `needsUpdate` cannot fix the cached render objects;
  `material.dispose()` can. threeforge's warm-up renders a scissored real frame instead (`docs/upstream-compileAsync.md`).
- Shadow maps and the transmission backdrop re-render once per node frame id, which advances only on animation-frame
  ticks: measurements must come from a frame after a real tick (`frameAsync()` everywhere).
- On WebGPU a batch whose index rows change after a pass recorded its draw (a reflection or shadow map rendered from
  inside that pass re-culls it) draws that pass with the new rows, and on WebGL the receiver that triggered a shadow
  map draws the shadow camera's list: batches and compacted instanced meshes keep the enclosing rows as a stable
  prefix (section 7). An instance matrix buffer above the uniform-buffer limit is one `InstancedInterleavedBuffer`
  per mesh, synced once per frame per render object (`nodes/accessors/Instance.js`), and `Geometries.updateAttribute`
  checks it at most once per `info.render.calls`, which a nested render advances and nothing restores: a mesh a
  nested pass reaches first is compacted for the main camera before that pass draws it.
- `renderer.compileAsync()` calls the scene's `onBeforeRender` but never its `onAfterRender`: `warmup({ mode: 'async' })`
  resets the pass tracker afterwards so the warm-up frame counts as an outermost render.
- Transmissive materials cannot be batched (thickness scales with the object matrix); reflectors fill their target
  one frame late; `KTX2Loader` needs `detectSupportAsync(renderer)`; `RenderObject.getDrawParameters()` returns null for
  a zero-instance InstancedMesh (no draw, no count); `ShaderMaterial` does not render on `WebGPURenderer`.
- Half-float render targets read back as raw 16-bit halves on both backends, and WebGPU returns rows padded to 256
  bytes: the overdraw target uses 32-texel row multiples and decodes halves.
- three's experimental `SceneOptimizer` batches everything including skinned meshes and disposes shared geometry; it
  was measured as the spike baseline (`docs/spike-scene-optimizer.md`) and not used.
- After `onBeforeRender`, `_renderObjectDirect` refreshes geometry attributes, nodes and bindings only when
  `needsRefresh()` says the render object is new this frame; a second render object of the same object (a
  reflection pass) gets a shared refresh without attribute uploads. Attributes written in a hook for a nested
  pass are therefore what the main pass draws: sprite batches fill their instance attributes once per frame, for
  the main camera, and nested passes reuse that list (the lake's raindrops stayed at 0.3 % pixel difference only
  after this).

## 14. Limits and roadmap

Overdraw modules shipped in 0.4.0, per-frame JS (freezing, `markDirty`, `RenderScheduler`) in 0.5.0, lighting
(`DayNight`, `ShadowBudget`, lightmap path) in 0.6.0 and skinning (`bakeAnimationTexture`, `AnimatedInstances`)
in 0.7.0 (section 7); animated instances play one clip per instance without blending or root motion; soft-particle materials are documented, not built (`docs/vfx.md`); cascaded
shadow maps (three's `CSMShadowNode`) are not wired yet; per-frame JS (`RenderScheduler`, static-subtree matrix
freezing) is SP6; memory and load (`createLoader`, `ResourceTracker`, chunk `Streamer`) shipped in 0.8.0 (section 7):
the Streamer keeps CPU copies and re-uploads, it does not fetch chunk data on demand (that needs incremental compile);
`threeforge optimize` shipped in 0.3.0 (section 10) and the device bench page with GitHub-native results is in
section 11. Specs live in `docs/superpowers/specs`, plans in
`docs/superpowers/plans`.

## 15. Glossary

- **submission**: one render item three processed (a mesh, a material group of a mesh, a batch, a sprite) in one pass.
- **sceneSubmissions**: submissions attributable to the user's scene; the budgeted number.
- **gpuDraws**: draw calls those submissions add to `renderer.info` on this backend; **drawCommands** counts multi-draw
  ranges with a non-zero index count.
- **unattributed**: reported draw calls the ledger's model did not predict; always 0 in the tests.
- **program**: a compiled shader variant, as counted by `renderer.info.memory.programs`.
- **tier**: `desktop`, `phone-mid`, `phone-low`; drives budgets and hints.
- **seam**: two coincident faces with opposite winding between touching solid modules (different, closed and
  manifold, outward, opaque, front-side and casting no shadow); removed by the bake. Any other coincident, opposite pair is kept and counted
  (`keptCoincidentFaces`).
- **buried face**: a face with solid geometry right in front of it in every direction; removed only on request.
