# threeforge: the complete reference

This file is the reference for every threeforge module, option and mechanism; read it before changing behaviour.
Shorter entry points: [README.md](../README.md) (overview and quick start), [AGENTS.md](../AGENTS.md) (the CLI and
MCP surface for AI agents), [docs/bench.md](bench.md) (benchmark baselines), [docs/design.md](design.md) (module map
and design history) and [docs/three-r186-notes.md](three-r186-notes.md) (what three r186 does that threeforge works
around).

## 1. What it is

threeforge is a frame-budget compiler and diagnostics layer for three.js games (three r186, `three/webgpu` with its
WebGL2 fallback). It is not an engine and has no editor; three.js stays the renderer. At load time it compiles a
naively assembled scene into a cheap one: static meshes merge into batches or baked meshes, repeated geometry is
instanced, instances are culled per instance with a BVH, LODs are switched, and the original objects stay editable
and reversible. Every frame it measures each cost category in one ledger (draw calls by reason, measured overdraw,
skinning, lighting and shadows, per-frame JavaScript, memory) and reconciles its own count with the renderer's, so a
non-zero `unattributed` means the model is wrong, never the scene. Per-tier budgets turn into hints with a remedy
each, readable by a person on the overlay or by an AI agent through JSON, a CLI and an MCP server.

Everything is measured on a fixed benchmark suite of eight scenes on both backends, with a regression gate that fails
the build on a 10 % regression (section 11), and on a corpus of public glTF assets (section 12, "Corpus report").

Principles: three.js renders; a wrong deletion is visible and a missed one is invisible, so every removal is
conservative, counted and reversible; measurements are real, never estimated where a measurement is possible; agents
get the same data as people, as JSON with exit codes.

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

The module map (one directory per concern under `src/`, the harnesses in `test/app`, `cli-app` and `bench-app`) is
the "Modules" table of [docs/design.md](design.md) and the "Layout" section of [CONTRIBUTING.md](../CONTRIBUTING.md). Data flow:
the app tags meshes; `World.compile()` classifies every mesh, registers materials, groups statics and builds batches,
baked meshes and instanced meshes, hides the originals and installs culling and sync hooks; three.js renders; the
ledger records every `renderObject` call with a reason and rebuilds the snapshot at the end of the outermost
`render()`; the overlay, the CLI, the bench runner and agents read `ledger.frame()`.

## 4. The ledger (`DrawCallLedger`)

### How it hooks in

`ledger.attach(renderer)` replaces two instance methods on the renderer: `renderObject` (called once per render item
after culling and sorting, in every pass, shadow maps and post-processing included) and `render` (frame boundaries).
The outermost `render()` call is one frame; nested calls are passes of it. `detach()` restores the originals. Nothing
global is patched.

`renderAsync` needs no patch of its own. three r186's `renderAsync` (deprecated since r181) awaits `init()` and then
calls `this.render(scene, camera)`, so a frame rendered through it enters the patched `render` once, after the await,
and reports a `main` pass with its shadow passes and skinning, exactly like `render()`. A `render()` made while
`renderAsync` awaits `init()` is a frame of its own. A unit test checks three's source for that call. This paragraph
is the authoritative statement of that mechanism; `docs/design.md`, `World.warmup` and `DrawCallLedger` point here.

### Passes

Each submission carries a pass id. `main` is the outermost render. `shadow:<light name>` is a pass whose camera is
the shadow camera of a world-visible shadow-casting light (the light's type when it has no name; `shadow:<name>#k`,
k from 1 in scene order, when shadow-casting lights of a scene share a name, and an id another scene of the frame
already took moves on to the next free k). `shadow:<id>:vsm` is the two VSM blur quads three renders right after that
map. `override` is a scene with `overrideMaterial`, `fullscreen` a non-scene root (a post-processing quad),
`nested:<render target name>` a nested render of the main scene (a reflector) and `scene:<name>` a different scene.
`nested:` and `scene:` ids are disambiguated against the same frame-wide set the shadow ids use: the first pass of a
name keeps the bare id and a later one gets `#2`, `#3` and so on, so two reflectors whose targets are both named
`reflection` are `nested:reflection` and `nested:reflection#2`. `main`, `override`, `fullscreen` and the `:vsm` ids
are fixed; several post-processing quads share `fullscreen` by design. Renderer-internal work (three's output colour
transform quad, the VSM blur quads) is attributed as `renderer-internal` and excluded from `sceneSubmissions`.

### Reasons and flags

Every submission gets one reason: `batched`, `baked`, `instanced`, `unique-material`, `static-unbatched`, `dynamic`,
`skinned`, `morph`, `transparent`, `multi-material-group`, `untagged`, `unsupported-material`, `renderer-internal`,
`fullscreen-pass`, `occlusion-proxy`, `points`, `sprite`, `line`, `unclassified`, or `excluded:<rule>`. The compiler
annotates objects it left alone (`ledger.annotate(object, reason)`) so the ledger says why. A static drawn alone is
`unique-material` when no other object of the frame's main pass draws its material and `static-unbatched` when one
does: at the end of the frame the ledger counts, per canonical material (the registry's, else the instance itself),
the distinct objects that drew it in the main pass, so a mesh drawn twice there is one use. The item's `material` is
that material's per-frame index. A registry change inside the frame (`invalidate()` or `forget()`, which move
`registry.keysRevision`) makes the ledger resolve canonicals again from that point on, so one material's uses can
split across two per-frame indices for that frame, each judged for sharing on its own. Flags add detail:
`shadow-caster`, `double-sided-transparent`, `custom-hook`, `render-order`, `layers`, `transparent`.
`double-sided-transparent` describes the material three draws in that pass (see Reconciliation), so a shadow caster
can carry it in its shadow pass and not in the main pass, or the other way round.

### Reconciliation

For each submission the ledger predicts the draw calls three r186's `renderer.info` counts for it on this backend:

- 1 for a mesh.
- N for a `BatchedMesh` with N multi-draw slots on WebGPU or on WebGL without `WEBGL_multi_draw` (1 with multi-draw,
  0 for an empty list). A slot whose count a nested pass zeroed (stable-prefix culling) is counted: three's `Info`
  counts every slot.
- 0 when the instance count is 0: an `InstancedMesh` with `count = 0`, or a mesh over an `InstancedBufferGeometry`
  with `instanceCount = 0` (an empty sprite batch or VAT part).
- ×2 when the material three draws is transparent, `DoubleSide` and not `forceSinglePass`. That material is the
  source material, or `scene.overrideMaterial` for a source with `allowOverride`: transparent when the source is
  transparent, transmissive or has a backdrop node, with the override's own side, except in a shadow pass, where the
  side is the source's `shadowSide`, else its side (PCF flips it, VSM keeps the source side; either way `DoubleSide`
  stays `DoubleSide`). The factor is read before `renderObject` runs, because three puts the override material's
  side back as it returns, so a `side` or `transparent` change made inside `object.onBeforeRender` is not seen. A
  double-sided transmissive material is two submissions of one draw each: its back-side pass, then its front.
- 0 for a vertex range three rejects: `RenderObject.getDrawParameters` returns null when the range count is below 0
  or `Infinity` (`RenderObject.js:640-671`), which the prediction follows with the submission's own material and
  group. Three ways to reach it: a geometry with neither an index nor a `position` attribute under the default
  infinite `drawRange`; a `drawRange` disjoint from the group being drawn (groups `(0,18)` and `(18,18)` with
  `setDrawRange(0, 10)`); a `drawRange` starting past the last vertex. The wireframe range factor scales the item
  count as an approximation of three's generated wireframe index, which can only matter for a wireframe mesh whose
  range is already disjoint. Such a submission's `instancesDrawn` is 0 too; its `instances` is unchanged.

`reportedDrawCalls` is the change in `renderer.info.render.drawCalls` inside the frame; `unattributed =
reportedDrawCalls − gpuDraws` and is asserted to be 0 in every test. `drawCommands` counts multi-draw ranges
individually. It and `instancesDrawn` count only the slots with a non-zero index count: a zeroed slot adds a draw
call but draws no instance. A batched double-sided transparent submission adds its drawn slots to `drawCommands`
once, without the ×2 its `expectedGpuDraws` carries, while a non-batched one adds 2; this predates 0.9.0.

### The snapshot (`ledger.frame()`), schema version 3

`npx threeforge schema snapshot --json` prints the JSON Schema; this section says what each part measures. `env`
records three's version, the backend, multi-draw support, tier, GPU, DPR and viewport. The six cost sections are
draw calls (`totals`, `passes`, `byReason`, `programs`), `overdraw`, `skinning`, `lighting`, `js` and `memory`;
`hints` sits on top (see "Tiers, budgets and hints"), and per-submission `items` come with `ledger.frame({ items:
true })`. `totals` holds `submissions`, `sceneSubmissions`, `gpuDraws`, `reportedDrawCalls`, `unattributed`,
`programSwitches`, `programs`, `triangles`, `instances`, `instancesDrawn` and `drawCommands`; `passes` lists
submissions and GPU draws per pass id; `byReason` counts them per reason with the first five names; `programs` keys
each program hash to its type, description and submissions.

`overdraw` is measured, not estimated. `ledger.measureOverdraw(scene, camera)` renders the scene twice into a
1/8-resolution half-float target, once for the opaque render list (`renderer.transparent = false`) and once for the
transparent lists, reads each back and averages the red channel: fragments per pixel. The count material (a
`MeshBasicNodeMaterial` with a constant `outputNode`, One/One blending, no depth test or write, one pass) adds
exactly 1 per fragment, so colours do not change the count and a batched scene measures like its naive original.
Each object is drawn with its own material's `side`, `map`, `opacity`, `alphaHash`, `opacityNode`, `alphaTestNode`
and `maskNode`, and three's override copies `alphaTest`, `alphaMap` and `positionNode`, so closed meshes count their
front faces, cutouts their kept texels and animated instances their animated pose; sprites and sprite batches are
drawn with a `SpriteNodeMaterial` count material carrying `rotation`, `sizeAttenuation`, `scaleNode` and
`rotationNode`. Not carried: `colorNode` alpha, vertex-colour alpha, and vertices a material builds in its class or
`vertexNode` (a `PointsNodeMaterial` on a non-`Points` object, Line2-style materials). Not counted: the background
(the target clears to 0), materials with `allowOverride = false` or `colorWrite = false`, and occlusion proxies. A
mesh whose material groups differ only in the copied slots is counted with whichever group's program three built
first (three keys the render object by object, override material, context and lights, and assigning a slot bumps no
version); a sprite batch mirrors its side in `onBeforeRender`, after the count copied `side`, so a measurement right
after a mirroring flip counts the previous side. A scene rendered inside a count draw with its own override
material, or none, passes straight through, and a same-scene render inside one (a reflector's `updateBefore`) puts
back every slot it changed. A `measureOverdraw()` called while that renderer's count renders run returns the
measurement in progress and renders nothing, whatever `scene`, `camera` or `options.scale` it was given; one called
while only the read-backs are pending is a measurement of its own; a `disposeOverdraw(renderer)` called during the
count renders releases once they end. Every setting is restored before the read-backs are awaited, and attribution
pauses for the two count renders only, which never become part of a frame. The target and count materials are kept
per renderer until `ledger.detach()` or `disposeOverdraw(renderer)`; `overdrawTargetOf(renderer)` returns the
target, which the memory section allows. Call it on demand. `overdraw.particles` and `overdraw.pixels` come from
the overdraw modules (section 7).

`skinning` sums the main pass's skinned submissions: vertices, bones per unique skeleton (indexed per frame, no
uuids), `maxBones` and morph targets; `vatInstances` and `vatVertices` count the characters drawn as animated
instances (`kind: 'vat'`, reason `vat-instanced`), which need no CPU bones.

`lighting.lights` counts the lights three projected for the main pass (`lightsNode.getLights()`, read from the first
scene submission's `renderObject` call; a light under a hidden group, on a layer the camera does not see, or with
`renderer.lighting.enabled = false` is not lit), else the main scene's world-visible lights (as `scanLights` does);
`shadowLights` counts those set to cast. Both describe the main pass only. `shadowPasses` and `shadowSubmissions`
count the scene submissions of `shadow:*` passes over every scene of the frame, not the `:vsm` quads.
`shadowTexels` is the sum of `mapSize.x · mapSize.y` (`mapSize.x² · 6` for a point light: three renders each cube
face at the map's width) over the lights whose shadow map rendered this frame, each light once: a frozen map
(`autoUpdate` off and no `needsUpdate`) or a disabled `renderer.shadowMap` adds 0, and a map rendered again for
another camera counts once. `shadowCasters` counts the distinct objects drawn into any shadow map this frame (a
`BatchedMesh` or `InstancedMesh` is one object; an object casting for several lights or six cube faces counts once).
Because `shadowTexels` is per frame, the `shadow-texels` hint and the overlay alternate on a frozen or quantized map
(a `DayNight` stepping its map every second frame fires the hint on the frames it renders on), so a single-frame
`inspect` depends on which frame it lands on: average over frames before acting on it. Pass ids move with the scene
too: hiding a namesake light or turning its casting off switches an id between `shadow:lamp` and `shadow:lamp#1`.

`js.renderMs` is the outermost `render()` call's duration until the ledger starts filing the frame (it includes the
per-submission attribution, which runs inside the renderer's calls); `ledgerMs` is that filing: the snapshot, the
hints and, every 60 frames, the rescan. `frameMs` is the median interval between the last 60 outermost renders.
`objects`, `autoUpdatedMatrices` and `hiddenOriginals` (batched originals parked on layer 31) come from a traversal
repeated at most every 60 frames, which `ledger.rescan()` forces; `skipped` is the ticks a `RenderScheduler` skipped
among its last 60.

`memory` estimates bytes (`estimated: true`); `ledger.measureMemory()` recounts now. A texture follows three r186's
`Info._getTextureMemorySize` (`w · h · depth · texel bytes`, channels from the format, bytes per channel from the
type and packed types whole, depth 6 for a cube and the layers of a 3D or array texture, ×1.333 with generated
mipmaps) and what three allocates where that function does not: a compressed texture is the sum of its mip data (a
compressed cube's six faces too; three counts 1 byte), the size is the one `Textures.getSize` allocates (a cube's
first face, a video's frame), and explicit mipmaps are the levels three uploads. Geometries are attribute plus index
bytes. Render targets are the shadow maps three has built for casting lights, the two RG half-float blur targets
each built non-point map holds under `VSMShadowMap`, and the renderer's half-float frame-buffer target.
`memory.measured` is three's own `renderer.info.memory` at the time of the estimate (`textures` count and
`texturesSize`, `geometries` count and `attributesSize + indexAttributesSize`, `renderTargets` count, `bytes` as
`total`), everything three allocated with a compressed texture as 1 byte, or null without these counters.
`memory.chunks` is the attached Streamer's residency, read live.

`memory.unreferenced` counts the geometries and textures the renderer still holds (`info.memory` counts) that the
scene no longer reaches, minus an allowance for what three r186 holds for itself, identified from its source while
the ledger is attached: one geometry, the frame-buffer targets (`renderer._frameBufferTargets`, a private field
pinned by a canary test; a fixed colour and depth without it), the textures of every shadow map three has built with
a non-point VSM map's two blur targets, the overdraw count target once `measureOverdraw()` has run, three's 16 × 16
`DFG_LUT` (counted through `renderer.info.createTexture` and `destroyTexture`, since `DFGLUT.js` keeps it in an
unexported module variable and matching three's own name is preferred to `DFGLUT.shaderNode.jsFunc`), PMREMNode's
own `PMREMGenerator` planes and `isPMREMTexture` targets, the background sphere, one morph texture per morphed
geometry, and the textures of a render target a render drew into, by identity until its `dispose`. Reachable
includes BatchedMesh and skeleton textures and `material.userData.forgeTextures`. It is recounted with the graph
statistics. The allowance and its bounded blind spots (resources created before `ledger.attach()`, a target drawn
once and abandoned without `dispose()`, transmission's and XR's viewport textures, the `DFG_LUT` name, a map not yet
rendered, the VSM allowance right after a `shadowMap.type` change, tiled shadows) are in `docs/memory.md`. Two more:
detach two ledgers on one renderer in reverse attach order, since the second `attach()` wraps the first's wrappers
for `info` and `render` alike (predates 0.9.0); and array shadow maps under-report `memory.renderTargets.bytes` by
their layer count, for the map and its VSM blur targets alike (`src/ledger/memory.ts` sizes both from width and
height alone; no scene in the repo uses one).

`hints` are recomputed every frame from the snapshot and the tier's budgets. The `untagged`, `unique-materials`,
`static-unbatched` and `sprites-unbatched` hints count distinct objects the main pass drew (`HintContext.objects`, a
`MainPassObjects`), not submissions across every pass, in their messages and against their thresholds: a shadow map
or reflection drawing the same object again adds nothing, and a reason whose objects were drawn only outside the
main pass raises no hint that frame. The `unsupported-material` hint (an `error`) counts distinct objects over every
pass (`HintContext.unsupportedObjects`), since the material renders in none of them on WebGPU. `byReason` still
counts submissions in every pass. The `point-light-shadow` and `transmission` hints name only lights and meshes
three renders (world-visible; no point light while `renderer.shadowMap.enabled` is false). The `batch-local-space`
hint (`HintContext.localSpaceDraws`, gathered on the rescan) names world-visible draws `World.compile()` made (a
`forge:batch:` batch, the base level of a `forge:instanced:` group, a baked mesh) whose material has a node in any
slot, code the hint cannot read (a subclass or an own function), `alphaHash` or an object-space normal map
(section 7).

`programHash` and `variantHash` (the `programs` keys and each item's hashes) come from the material registry
(section 5). A hash for a material with instance code, a class that is not one of three's own, or identity-keyed
data is stable within a run only, since identity numbers follow the order materials are first keyed; a
`variantHash` with a texture also differs between runs (texture `uuid`s). Other methods: `ledger.report()` (text),
`ledger.budget({ maxSubmissions })` → `{ pass, actual, max, offenders }`, `ledger.setEnvironment({ tier, gpu, dpr,
viewport })`, `ledger.budgets()`.

### Overhead

The per-submission path runs inside the renderer's calls, so its cost is part of `js.renderMs`; filing the frame
once `render()` has finished is `js.ledgerMs`. In a steady scene that path allocates nothing that grows with the
submission count: a pooled record's `flags` array is rewritten in place (`flagsInto`; emptying and re-pushing it, as
an earlier 0.9.0 build did, cost about 40 bytes per submission per frame), two record buffers alternate so a read
between frames or from a hook sees whole frames (`frame({ items: true })` returns copies), material hashes come from
`registry.keys()` at most once per material per frame and again after `invalidate()` or `forget()`, material
uses resolve each drawn material to its canonical once per frame on the same revision, display names come from a
cache checked against the live graph on every read (a sibling index is trusted only while
`parent.children[index] === object`, so `children.indexOf` is never called), one ancestor walk per submission finds
both the root and the nearest tag, draw state is copied into the record as soon as `renderObject` returns (after a
pass nested inside that draw restored the counts it changed), `writeInstanceCounts` counts a batch's non-zero slots
without allocating, and one `traverseVisible` walk per scene per frame gives shadow cameras their pass ids and keeps
the main scene's lights as the lighting fallback; casters and texels are marked per object and per light with the
frame's number, so nothing is cleared between frames, and the rescan reads each shared material's textures once.

`pnpm build:lib && node scripts/ledger-overhead.mjs [submissions…]` reports the µs added per submission, the bytes
allocated per frame and the rescan time at 2k, 10k and 20k submissions by default, on a flat, a nested and a shadow
scene through a minimal renderer, bare and with a ledger attached (best ledger round minus best bare round). It is a
report, not a gate: compare runs on one machine and quote the invocation with the number, since a single size given
on its own prints a different figure. The default invocation on 2026-09-16 at commit `bf4c547` (10-core Apple M1
Max, node v22.23.1) measured 0.22, 0.30–0.32 and 0.40–0.41 µs per submission and 17–28 KB per frame at 2k, 10k and
20k on the flat scene (rescan 0.5–5.6 ms), 15.5–25.7 KB on the nested scene and 19.1–29.5 KB on the shadow scene,
against 0.83, 1.84 and 3.07 µs and 2.3, 11.4 and 23.1 MB per frame recorded on 0.8.0 before the hot-path work
(another 0.8.0 run read 3.8 µs and 8.7 MB at 10k; neither is a same-machine comparison).
`test/unit/ledger-hot-path.test.ts` counts registry reads (at most one per material per frame), traversals (at most
one on a frame without a rescan) and `children.indexOf` calls (none), and checks that µs per submission grows less
than 3× from 2k to 20k (best of 7).

### Tiers, budgets and hints

`detectTier({ gpu, deviceMemory, cores, touch, mobile, platform, dpr })` is GPU-first: a recognised GPU name decides
before touch is considered, so a touch-capable desktop is not mistaken for a phone, and a mobile GPU family name is
the weakest signal because those families also ship in laptops. All seven steps live in `detectTier` itself, so it
never disagrees with what `tierInputFromNavigator` feeds it. In order:

1. The low-end regex matches (Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR SGX, VideoCore):
   `phone-low`. Those families ship in no laptop.
2. An `"Apple"` name with `touch`: `phone-mid`, or `phone-low` when `deviceMemory <= 2`. An M-series GPU with a
   touchscreen is an iPad, and iPadOS Safari sends a Macintosh user agent, so `mobile` reads `false` there.
3. A desktop GPU matches (NVIDIA, Radeon, AMD, Intel, Iris, Arc, Apple M-series, SwiftShader): `desktop`, whatever
   `touch` and `mobile` say. Every alternative in all three GPU regexes is word-bounded, so "Intelligent Renderer"
   or "Malibu GPU" cannot match a brand substring.
4. The renderer string names an ANGLE Direct3D backend or Windows (`D3D11`, `Direct3D11`, `Windows`): `desktop`.
   Windows-on-ARM laptops carry Adreno GPUs and report both brands through ANGLE, e.g. `ANGLE (Qualcomm, Adreno (TM)
   X1-85 (0x00043050), D3D11)`; Android's ANGLE strings name OpenGL ES or Vulkan.
5. A mobile or tablet GPU matches (higher-end Adreno/Mali, PowerVR, Xclipse, Qualcomm, Apple A-series): `desktop`
   when `platform` names an OS no phone or tablet runs (Windows, macOS, Linux, ChromeOS, in any spelling), else
   `phone-mid`, or `phone-low` when `deviceMemory <= 2`. This precedes the `mobile` step because Chrome reports an
   Android tablet as `userAgentData.mobile: false`. On WebGPU `gpu` comes from `adapter.info` and names a vendor and
   architecture only (this repository's own string is `apple metal-3`), with no graphics API token to separate that
   tablet from a Windows-on-ARM laptop, which is what `platform` is for; with neither signal the GPU family decides.
6. `mobile` is defined: `true` gives `phone-mid` (`phone-low` under `deviceMemory <= 2`), `false` gives `desktop`.
7. Otherwise: no `touch` gives `desktop`; `touch` with `deviceMemory <= 2` gives `phone-low`, else `phone-mid`.

`tierInputFromNavigator(gpu, nav)` builds that input from a GPU name and `navigator` (passed explicitly so it is
unit-testable); `test/app/main.ts`, `cli-app/main.ts` and `bench-app/runner.ts` all call it the same way. `touch` is
`navigator.maxTouchPoints > 0`. `platform` is `navigator.userAgentData.platform` (Chromium, the only one stated
rather than inferred), then the OS named in `navigator.userAgent`, then `navigator.platform` (last because Android
reports `Linux armv8l` there). `mobile` is `navigator.userAgentData.mobile`, then a `"Mobi"` sniff of the user
agent, else `undefined` so step 7 applies. Every field it reads is optional and guarded.

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
`over-budget-triangles`, `untagged`, `unique-materials`, `static-unbatched`, `unsupported-material`, `programs`,
`transparent-overdraw`, `skinned-vertices`, `point-light-shadow`, `shadow-texels`, `transmission`,
`transparent-batch-order`, `batch-local-space`, `texture-bytes`, `static-auto-update`, `particles-over-budget`,
`sprites-unbatched`, `js-objects`, `detach-originals`, `bones-over-budget`, `skinned-crowd`, `geometry-bytes`,
`unreferenced-resources`.

### Overlay

`createOverlay(ledger, { budget, parent, intervalMs })` from `threeforge/overlay` shows the head line (backend, tier,
submissions against the budget), the six cost rows, a diagnostics line (unattributed, program switches, programs),
reasons by count and the hints. `formatOverlay`, `formatCostRows` and `formatHints` are the pure formatters.

## 5. Material registry (`MaterialRegistry`)

`register(material)` returns the canonical material for its key without mutating the input. `computeMaterialKeys`
derives three keys. `programKey` mirrors three's `RenderObject.getMaterialCacheKey()`: type, custom program cache
key, which texture slots are set with their mapping, channel and colour space, booleans, enums, feature gates such
as transmission or clearcoat as on/off, defines, node cache keys, the number of clipping planes, and material code as
below. `variantKey` adds every non-colour uniform, the texture identities and transforms, clipping plane values, an
instance `onBeforeRender`, and `visible=0` when `material.visible` is false (a hidden material never merges with an
otherwise identical visible one; `visible` never affects `programKey`). `colorKey` is the `color` property keyed by
exact linear floats (`color.r/g/b`), not 8-bit sRGB hex, so two colours under 1/255 apart stay distinct and an HDR
value (a channel above 1) stays distinct from another that would clamp to the same hex; every other `Color`-valued
property (`emissive`, `sheenColor`, `blendColor` and the rest) is keyed the same way inside `variantKey`.
`describe(material)` also returns `colorHex` (`color.getHexString()`, 8-bit sRGB) for display only (logs, the CLI,
the overlay); it must never be used for identity or grouping, and sprite batching (section 7) groups by the exact
`colorKey` for that reason. Outcomes: `new`, `merged` (same variant and colour), `color-variant` (batchable through
per-instance colour), `uniform-variant` (the same `programKey`, another `variantKey`), `shader-variant` (another
`programKey`), `unsupported` (`ShaderMaterial` and `RawShaderMaterial` do not render on `WebGPURenderer`),
`unregistered`. `describe(material)` gives the hashes, `colorHex`, `colorKey` and outcome; `canonicalOf`, `keys` and
`stats()` (`registered, canonical, merged, unsupported, programs, byProgram[]`) complete the read API.
`keys(material)` returns `{ programHash, variantHash, description, unsupported }` straight from the key cache,
allocating and recomputing nothing: it is the cache entry itself, which `invalidate()` and `forget()` replace rather
than change, and `keysRevision` moves whenever either drops cached keys so a caller that memoizes `keys()` (the
ledger, per frame) knows to read again. `programs` is checked against `renderer.info.memory.programs` in the tests;
the count can exceed what three compiles when materials run different function objects or classes whose code
compiles to the same shader (closures from one factory with the same source text, or a subclass that overrides
nothing the shader reads).

Materials with different code never merge, even when the source text matches. Material code joins the keys by
identity (a number per object from a `WeakMap`, never `toString()`), so two closures from one factory with different
captured values get different keys, while materials sharing one function object or class still merge. The class
joins `programKey` when the material is not exactly an instance of one of three's own classes (`isBuiltInMaterial`,
`src/registry/builtInMaterials.ts`), since a subclass inherits its base's `type` and can override any method, so
each subclass is its own program. Every own function-valued property except `onBeforeRender` joins `programKey` too
(an instance `setup*`, `onBeforeCompile`, `customProgramCacheKey`), since three builds the program from them, so such
materials report as `shader-variant`s. An own `onBeforeRender` joins `variantKey`: it is not program code on either
backend (WebGLRenderer calls a material's `onBeforeRender` once per draw, WebGPU's renderer never calls it), so such
materials report as `uniform-variant`s, one program but never one batch or canonical. The compiler groups statics by
`variantKey`, which contains `programKey`, and `register()` merges by `variantKey` plus colour, so a batch or a
canonical never draws one material's code for another. A user-added own property (`material.extra = {…}`) is keyed
by value when it holds plain data (object literals, arrays, strings, numbers, booleans, BigInts; a self-containing
value is keyed by its shape without overflowing the stack) and by identity for anything else inside it (a function,
a `Texture`, an `Object3D`, any class instance), which is never walked. An array of planes (`clippingPlanes`) keys
its length in `programKey` and each plane's normal and constant in `variantKey`; any other non-numeric array is
keyed like plain data. `userData` stays out of the key except `forgeKey` (which overrides everything, code
included), and so does EventDispatcher's `_listeners` (the `dispose` listener a renderer adds to every material it
draws). Identity numbers follow the order objects are first keyed, so a hash that includes one is stable within a
run, not across runs (section 4).

A material is immutable once registered: `register()` and `describe()` compute its keys once and cache them with
their hashes, nothing re-reads its properties after that, and anything built from its old keys (a `BatchedMesh`, a
sprite batch) stays built from them. `invalidate(material)` re-keys it: it removes `material` from every index it
was filed under by its old keys (`canonicalByFullKey`, its program's `canonicals` and `variants`; nothing for a
merged duplicate), recomputes the keys from the current properties and re-files it, staying or becoming the
canonical for the new key when no other canonical holds it, else demoted to `{ outcome: 'merged', canonical: <that
material> }`. Without the removal step a later material built with the old property values would find the stale
index entry and merge into `material`, rendering with its mutated state; that defect is closed. A material already
merged into `material` keeps resolving to it (a live object); `invalidate` does not re-key dependents.
`forget(material)` removes a material entirely, as if never registered, unwinding `stats()` and its program's
bookkeeping. Forgetting a canonical other materials were merged into leaves their bookkeeping correct (they keep
resolving to that exact object) but is no signal that its GPU resources are safe to dispose: every dependent still
relies on it, and `forget()` neither tracks nor releases them. Check `dependentsOf(material) === 0` first (a live
scan of `records`, never cached), or `forget()` every dependent too before disposing.

`World.decompile()` and `ResourceTracker.release()` both call `forget()` for the materials they release, so the
registry's records stop keeping a material nothing references alive: the clones a compile created (batches,
instanced groups, a baked group's tints, the occlusion proxies and the sprite batches) and, in the tracker, a
registered material no other owner still holds. Both forget the materials merged into a canonical before the
canonical itself, and both keep a canonical another registered material still resolves to: the tracker leaves it
registered, and `decompile()` leaves it registered and undisposed, since every mesh drawn with that duplicate still
renders through this exact object. Such a canonical is not revisited when its last dependent is released later;
releasing it is then the app's own call (`dependentsOf`). The tracker never disposes a material the registry knows.

## 6. Tags and classification

`tag.static(obj)` and `tag.dynamic(obj)` write `userData.forge`; a tag on an ancestor applies to its subtree.
`classify(root, { policy, animations })` decides per mesh, in this order: skinned, morph targets, `ShaderMaterial`
(unsupported), dynamic tag, parented under a bone, animated by a clip (pass `animations`: clips, or `{ root, clips }`
per animated root so shared bone names resolve correctly), exclusion rules, static tag, policy `auto` (untagged plain
meshes become static), else `untagged`. Exclusion rules (`exclusionRule(mesh, root?)`): `invisible`,
`invisible-ancestor` (an ancestor up to `root` with `visible = false`, via `isVisibleInGraph`), `already-instanced`,
`material-invisible` (`material.visible === false`), `transmission` (three scales volume thickness by the object
matrix, which a batch cannot provide), `dynamic-geometry` (`DynamicDrawUsage` or `StreamDrawUsage` attributes),
`multi-material`, `layers`, `render-order`, `group-render-order` (the nearest `isGroup` ancestor has `renderOrder !==
0`: three's `Renderer._projectObject` overwrites `groupOrder = object.renderOrder` at every `isGroup` object on the
way down, so only the closest Group's value reaches the mesh), `clipping-group` (an enabled `isClippingGroup`
ancestor at any depth, since clipping contexts chain through `getGroupContext`; WebGPU-only per three's docs, but
the shared `Renderer.js` `_projectObject` that reads it backs both backends here), `custom-hook` (own
`onBeforeRender` or `onAfterRender`), `draw-range`, `frustum-culled-off`, `mirrored` (a negative determinant
relative to the scene, the world determinant times the scene's: three flips a batch's front face by its own world
matrix, never per instance). Every excluded mesh shows up in the ledger as `excluded:<rule>`. Without `root` the
three ancestor-scoped rules (`invisible-ancestor`, `group-render-order`, `clipping-group`) are skipped.
`spriteRule(sprite, root?)` shares the same ancestor walker (`ancestorExclusionRule`) for `group-render-order` and
`clipping-group`, plus its own `material-invisible`, `sprite-custom-material` (not exactly a `SpriteMaterial` or
`SpriteNodeMaterial`, or holding its own functions: the batch builds a plain `SpriteNodeMaterial` and would drop that
code), `sprite-node-material` (a node material with any `*Node` slot set: the batch replaces position and scale
nodes and draws object-dependent nodes against itself), `sprite-count` (`Sprite.count !== 1`: three draws `count`
instances of such a sprite), `multi-material`, `sprite-center`, `layers`, `render-order` and `custom-hook`.

## 7. The scene compiler (`World`)

### `compile()` step by step

1. Install the `PassTracker` scene hooks (always): render depth, open passes and the main camera, for batch culling,
   instancing and sprite batches (see culling).
2. Classify every mesh; record the counts of meshes and distinct materials (`before`).
3. Collect statics; with `dynamics: 'batch-sync'` also collect dynamics that pass every batch rule.
4. `batchStatics`: register materials, group statics by variant key, geometry attribute signature, `castShadow` and
   `receiveShadow` (and chunk cell). Per group, geometry repeated at least `instanceThreshold` times in an opaque
   group becomes a compacted `InstancedMesh` per geometry; the rest becomes one `BatchedMesh` (with `bake`, one baked
   `Mesh`); a group of one mesh stays a mesh with the canonical material (`unique-material`, or `static-unbatched` in
   a frame where another object draws that canonical). A batch uses the canonical material itself when every
   instance is white, else a white clone with per-instance colour. The clone (`cloneMaterial`, also used for a baked
   group's vertex-colour material) gets back what three's `clone()` drops: every function assigned to the instance
   (`onBeforeCompile`, `customProgramCacheKey`, `onBeforeRender`, a node material's `setup*`), a copy of custom
   `defines`, `alphaTest` (lost on the `NodeMaterial.copy` path) and, by reference, every other own enumerable
   property the fresh copy lacks, except EventDispatcher's `_listeners`. It shares the source's `userData` object
   instead of three's JSON copy, so a uniform kept there and animated through the source reaches the batch, and
   circular or BigInt `userData` does not throw. Non-indexed geometries get an index on a clone (`ensureIndexed`);
   indices promote to Uint32 as needed. Instance matrices, instanced masters and baked vertices are written in the
   scene's space (see "Scene space").
5. Attach BVH culling to every batch (`culling: 'bvh'`), with LOD ranges when `lod` is set.
6. Install matrix sync for batch-synced dynamics and occlusion proxies when enabled.
7. Hide the originals: moved to layer 31 with `matrixAutoUpdate = false` (`originals: 'hide'`), or removed from the
   graph (`originals: 'detach'`; an original with anything else under it is hidden instead, see "Freezing");
   parent indices are recorded so `decompile()` restores the exact order. Then freeze
   (`freeze: true`): unbatched static meshes and every ancestor whose whole subtree is static get
   `matrixAutoUpdate = false` too (`after.frozen`).
8. Annotate everything left alone (excluded rule, `unique-material`, `dynamic`) and swap canonical materials onto
   remaining meshes (`materials: 'canonical'`; `'keep'` leaves each mesh's own instance).
9. Return the `CompileReport`: `before`, `after { batches, instanced, baked, meshes }`, `bake` summary, `groups[]`
   (kind, chunk, lods, program and variant hashes, instances, geometries, transparency, shadow flags, bake report),
   `skipped[]` with rules, registry stats, culling mode, `synced`, `lod`, `occlusion` (`{ proxies, skippedSynced }`)
   and `nestedPasses`.

### Options

| option | default | what it does |
|---|---|---|
| `registry`, `ledger` | new / none | share the registry with the ledger so reasons and programs agree |
| `policy` | `'tagged'` | `'auto'` batches untagged plain meshes too |
| `originals` | `'hide'` | `'detach'` removes originals from the graph (large scenes); one that still has a live descendant is hidden instead |
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
submissions in the same pass, not by true per-object depth against them. `transparent: 'keep'` opts a scene out (its
transparent statics stay individual meshes, sorted by three like any other transparent object) at the cost of one
draw per mesh; the `transparent-batch-order` hint (info) names it whenever a threeforge transparent batch shares the
main pass with another transparent submission.

Batching and instancing also move a material's mesh-local space into the scene's, so node materials that shade from
`positionLocal`, `alphaHash` and object-space normal maps stay batched by default too, with the limit named by a hint
and an opt-out per mesh (section 14). three r186 multiplies `positionLocal` by the instance matrix in a batch
(`batch()`, `Batch.js:148`) and an instanced mesh (`instance()`, `Instance.js:206-207`), World writes those matrices
in the scene's space, and a baked mesh's positions are written there too. `positionLocal` is a varying
(`Position.js:45`), so a node reading it in either stage sees the vertex in the scene's space, and `alphaHash` hashes
it (`NodeMaterial.js:893`), which moves the pattern of discarded pixels. An object-space normal map's normals go
through `transformNormalToView` (`NormalMapNode.js:120-122`) with the draw's `modelNormalMatrix`
(`Normal.js:183-197`), the batch's, instanced mesh's or baked mesh's rather than each module's, so a rotated module
is lit as if unrotated. `normalLocal` is unaffected in the fragment stage (three redeclares it per stage,
`Normal.js:23-35`, a `toVar` rather than a varying), and a tangent-space normal map follows the batched normal and
tangent. `test/e2e/local-space.spec.ts` compiles each case on four translated, rotated and scaled statics with `bake`
off and records the share of changed pixels at tolerance 4 as a test annotation, on both backends: a `positionLocal`
colour gradient 11.08 %, `alphaHash` 5.56 % (webgl2) / 5.59 % (webgpu), an object-space normal map 9.54 %, and a
plain `MeshStandardMaterial` on the same boxes 0 pixels. Those shares belong to that spec's scene (they scale with
how much of the frame the affected meshes cover), so the spec asserts only that the hint fires and that the count is
non-zero. The `batch-local-space` hint (warn) names every world-visible batch, instanced group and baked mesh World
made whose material has a node in any slot (what `spriteRule`'s `sprite-node-material` uses), code the hint cannot
read (a class that is not one of three's own, or an own function, as `sprite-custom-material` and `bakeProvesReads`
refuse for the same reason: a subclass overriding `setupPosition` reads `positionLocal` with no `*Node` property to
see), `alphaHash: true`, or a `normalMap` with `normalMapType: ObjectSpaceNormalMap`, with the material names. It
cannot see into a node graph or into code, so it also names nodes that never read `positionLocal` (a texture lookup
by uv, `MeshSSSNodeMaterial`'s constant `thickness*Node` defaults) and subclasses that read nothing local. Tag the
meshes that must keep their own local space `dynamic` (under the default `dynamics: 'separate'`) to leave them
individual draws; an object-space normal map re-authored in tangent space batches unchanged.

### Culling, instancing, chunks, LOD, occlusion

Scene space (`SceneSpace`, `src/compiler/space.ts`). Batches, instanced meshes, baked meshes, sprite batches and
occlusion proxies are children of the scene, so three draws them with `scene.matrixWorld`, and every instance write
converts an original's `matrixWorld` to `inverse(scene.matrixWorld) * matrixWorld`: batch matrices and instanced
masters at compile, baked vertices (rebakes included), batch-sync matrices, `markDirty` writes, and sprite centres
and scales (divided by the scene matrix's column lengths, which three multiplies back in). The inverse is cached and
derived again whenever the scene's world matrix differs from the one it came from (its 16 elements are compared on
every use, and a `version` counter tells the batch sync that the scene moved, so a synced mover whose own world
matrix did not change is rewritten too). A scene translated, turned or scaled after compile is therefore honoured by
every later compiled write; a scene without a transform copies world matrices unchanged. Culling and sprite sorting
work in the object's frame or in world space and are unaffected. `lod.distances` are measured in the scene's frame,
so under a scaled scene they are scene units. Chunk cells (`chunkSize`) are computed in world space at compile and
the `Streamer` keeps them: streaming assumes the scene does not move after compile. Mirroring is decided at compile
(`mirrored` is relative to the scene); a scene that becomes mirrored only after compile is not handled, except by
sprite batches, which check every render and swap `FrontSide`/`BackSide` when the scene's mirroring changed.

BVH culling (`attachBvhCulling`). A `bvh.js` tree of instance boxes replaces `BatchedMesh`'s linear per-instance
test. The hook mirrors three's own `onBeforeRender` (fills `_multiDrawStarts/Counts` and the indirect texture) and is
prepended with `prependRenderHook`, never overwriting the object's hook; hooks are marked with `FORGE_HOOK`. The
handle offers `move(id)`, `insert(id)`, `remove(id)`, `detach()` and reports its `margin`, which is 0 for every batch
`World` compiles, batch-synced movers included: a mover refits its own leaf on each sync. `CullingOptions.margin` is
available to direct callers, but it changes what is drawn: the BVH prefilters candidates by their exact box and only
those reach three's bounding-sphere test, and a sphere circumscribes its box, so enlarging the boxes admits instances
whose sphere meets the frustum while their box does not, each costing a draw call and its fully clipped triangles.
It also rebuilds the tree, so traversal order changes and depth tie-breaks between coincident surfaces can flip.
Measured on the bossfight bench scene when `World` briefly did this during 0.9.0: +2 draw calls and +24 triangles
per frame in a point light's shadow pass, and 1-4 pixels of 480000.

Instancing (`createCulledInstancedMesh`). Master matrices and colours are kept aside; every frame the visible
instances are compacted to the front of `instanceMatrix`/`instanceColor` and `count` is set, so culled instances
cost nothing. LOD levels are separate InstancedMeshes chosen by distance. Handle: `setMatrixAt` (a master matrix, in
the mesh's parent space), `refreshBounds` (every level's box and sphere from the master matrices, drawn or not),
`setVisibleAt`, `getVisibleAt`, `detach`.

Chunks (`chunkSize`) split groups by cell, which gives batches tight bounds (whole-object frustum culling), per-cell
shadow casting and a natural unit for streaming. LOD (`generateLods(geometry, { ratios, error, lockBorder })`,
`prepareLods(root, options)`, `lodsOf`) uses meshoptimizer `simplify` (with `simplifySloppy` fallback), welding
non-indexed meshes first; levels are extra geometry ranges in the batch or extra InstancedMeshes, picked by
`levelFor(distance, distances)`. `disposeLods(geometry)` disposes the levels attached to a geometry and removes
them, returning how many: the same levels outlive any one compile and are shared by every mesh holding that geometry,
so threeforge never disposes them itself; `decompile()` first.

Nested passes (shadow maps, reflections, portals). three renders them from inside another render, a shadow map from
the first `receiveShadow` object's draw. Every material of a batch reads one index texture; on WebGPU its upload
lands at once while a pass is submitted only when it ends, and on WebGL that receiving batch draws right after the
shadow render returns. So batches keep a stable prefix: `PassTracker` (scene hooks, marked) knows which passes are
open, and a nested pass on a batch an open pass has already culled leaves that pass's index rows untouched, zeroes
the counts of the rows its camera does not need, appends the ids it lacks (LOD by the main camera's distance; sorted
for its camera when the batch sorts) and marks the texture only when an appended row changed; the counts and
`_multiDrawCount` come back when the nested render ends (or when the tracker heals after a render that threw).
`nestedPasses` decides a batch no open pass has culled yet: `per-pass` (the default on both backends) culls it for
the nested camera, `reuse-main` appends to the rows of its last outermost cull. On WebGPU a nested pass issues one
draw command per slot, zero-count ones included. Compacted instanced meshes keep a stable prefix too, the same under
both policies. Above the uniform-buffer limit three keeps their matrices in one vertex buffer that syncs once per
frame per render object and is checked for upload at most once per render call (a nested render advances the call
count, so a draw after it cannot upload what changed since): a nested pass that reaches a mesh before the outermost
render did compacts it for the main camera first; a shadow pass keeps the enclosing rows and appends only the
instances its own light reaches (directional and spot frusta, a point light's cube of half-size `distance ||
shadow.camera.far`). Every light of the frame is queried once, at its first shadow pass, into one deduplicated
caster list whose entries record which lights reach them (one bit per shadow camera of the frame, up to 32; a
camera past that carries no bit and its pass appends the whole list, a correct superset). Each pass appends its own
light's entries in that list's order, so a light whose casters are the rows the tail already holds writes nothing (a
point light's six faces always do, and so does any light whose set is a prefix of the pass before it). An
`InstancedMesh` draws one contiguous range `[0, count)` (three r186 takes `instanceCount` from `object.count` and
never writes `firstInstance`), so it cannot zero an interior appended row the way a batch zeroes a slot: it rewrites
the tail, marking only rows that change. Any other nested pass draws the enclosing rows; `count` and `visibleIds`
come back when the nested render ends. On that vertex buffer an outermost compaction marks only the rows it changed
(`addUpdateRange`), while a nested pass that writes rows marks the whole matrix and colour buffers: a receiver's
render object runs the instance `OnBeforeFrameUpdate` event before its `ShadowNode` (the position stack is flowed
before the stage loop in `NodeBuilder.build`), so the shadow render object's own sync replaces the main pass's synced
ranges before they upload, and the main pass cannot upload again in that render call.

| Nested pass | Batch, `per-pass` | Batch, `reuse-main` | Compacted instanced mesh (either policy) |
|---|---|---|---|
| an open pass culled the object | keep its rows, zero the unneeded, append the missing | same | shadow: keep its rows, append its own light's casters; other: draw its rows |
| no open pass culled it yet | fresh cull for the nested camera | append to the last outermost rows | compact for the main camera first, then as above |
| outermost render | fresh cull | fresh cull | compact (skipped while the view and rows are unchanged) |
| end of the nested render | counts restored | counts restored | `count`, `visibleIds` restored |

Occlusion (`occlusion: true`). A proxy box over each batch's or instanced group's bounding box carries
`occlusionTest`; its own `onAfterRender` reads `renderer.isOccluded()` and hides the target next frame, and
`markDirty` fits it again (centre moved, corners rewritten in place) whenever it recomputes those bounds. Both
backends run the queries (WebGL2 `ANY_SAMPLES_PASSED`, WebGPU occlusion query sets) and both answer late, per
render context: at the end of a render whose list counted a query, three reads back the results of the previous
such render (including one whose only counted proxy was at the camera and issued none); WebGL checks
`QUERY_RESULT_AVAILABLE` synchronously at `finishRender` and polls by `requestAnimationFrame` only when the results
are not ready, WebGPU publishes after `mapAsync` resolves; so `isOccluded()` answers for a render at least two
renders back, with no upper bound, and a render whose list counts no query publishes nothing. Only the outermost
render decides: the proxy hooks act only at `PassTracker` depth 1, so a shadow map, reflection or portal that draws
a proxy never decides a target's visibility from its own query. Known limitation of 0.9.0: the decision is written
to `target.visible` (`World.ts`, the proxy's after-render hook), and three r186's `_projectObject` returns at
`object.visible === false` in every render, so once a proxy reads occluded its batch also casts no shadow and shows
in no mirror or portal (a building behind a wall loses the shadow it throws across the visible street, which pops
back when the proxy is unoccluded); `test/e2e/occlusion.spec.ts` has no shadow-casting light or reflection, so
nothing guards this. Until a fix hides targets only for the outermost render, do not combine `occlusion: true` with
shadow casters or reflections whose occluded batches must still appear. A scene drawn without its own hooks, as a
child of another root passed to `render()` (depth 0), issues no query and shows its targets; their `occlusionTest`
comes back in a microtask once that `render()` has returned. Occlusion assumes one outermost render per frame: a
second one with another camera (a rear-view mirror or minimap into its own `RenderTarget`, split screen) also sets
the shared `target.visible`, and when it shares the main render's render context the answers mix and targets
visible to the main camera can flicker; three keys a render context by attachment state (texture count, format,
type, samples, depth and stencil buffers), MRT and call depth (`RenderContexts.get`), not by target, so split screen
on one target shares it and so does a separate target with the same attachments as the frame-buffer target three
draws the canvas pass into (an RGBA `HalfFloatType` target with the same samples, depth and stencil).
`world.warmup()` issues no occlusion query in either mode, since under its 1×1 scissor every query would count no
samples and, once published, hide visible targets: it awaits `renderer.init()`, suspends the proxies (any proxy a
depth-0 render parked included), sets the scissor, renders and restores without yielding. A query cannot see the
target when the camera is inside the box (every face is back-facing) or the near plane cuts into it (a front face
in front of the near plane is clipped), so in the outermost render the proxy issues no query (its `occlusionTest`
is off until that render ends) and its targets are shown when the eye is inside the box grown by twice
`camera.near` or the bounding box of the near-plane rectangle meets the box; with no query issued, no late answer
can hide the target after the camera leaves. A batch or instanced group holding a `dynamics: 'batch-sync'` mover
gets no proxy (those targets skip whole-object frustum culling instead): a mover can leave the compile-time box, and
while the target is hidden three never calls its render hook, where the sync runs, so nothing could grow the box in
time; `report.occlusion.proxies` counts the proxies installed and `report.occlusion.skippedSynced` the targets
skipped for synced movers. Mirrored scenes need nothing: three flips a mesh's front face when its world matrix
mirrors, and the proxy's vertices mirror with it, so the `FrontSide` proxy still rasterises the faces toward the
eye.

### Runtime API

`world.resolve(intersection)` maps a raycast hit on a batch (`batchId`), an instanced mesh (`instanceId` through the
compaction table) or a baked mesh (`faceIndex` through per-triangle origins) back to the original mesh.
`world.setVisible(original, visible)` hides an instance wherever it went (a baked module rebakes its group).
`world.slotOf(mesh)`, `world.batchedMeshes`, `world.instancedMeshes`, `world.bakedMeshes`, `world.cullingOf(batch)`,
`world.mainCamera` and `world.bakeDebug()` inspect the result. `world.decompile()` removes everything it built,
disposes what it created (the white clones batches and instanced groups draw with, occlusion proxies, baked geometry
and bake clones, sprite batches), restores layers, matrices, materials and parent order, and allows `compile()`
again. A batch or instanced group whose instances are all white draws with the registry's canonical material itself:
that material is the app's, so `decompile()` never disposes it. `world.dispose()` tears the World down for good: it
decompiles first when compiled, so `onDirty` listeners still hear `decompile` (that uninstalls the pass tracker's
scene hooks and removes and disposes the occlusion proxies, so a re-enable a depth-0 render queued finds no proxy),
then drops every `onDirty` listener; the registry, the ledger and registered materials stay the app's. Afterwards a
second `dispose()` and `decompile()` do nothing, and `compile`, `markDirty`, `setVisible`, `onDirty` and `warmup`
throw `World is disposed`.

### Warm-up

`world.warmup(renderer, camera, { mode })` builds every pipeline before the first visible frame. The default `frame`
renders one real frame under a 1×1 scissor, the only way in three r186 to get exactly the pipelines the first frame
uses. `async` runs `renderer.compileAsync()` (yields between objects) and then disposes and rebuilds the materials
three compiles wrong that way (transparent double-sided and transmissive ones; `docs/three-r186-notes.md`). The
result is `{ mode, textures, repaired }`. Neither mode issues occlusion queries (see Occlusion). Both first await
`renderer.init()` when the renderer has it, then render with `render()`, not the deprecated `renderAsync()`: three
logs no deprecation warning, nothing yields between setting the scissor and the render, and an attached ledger
records the warm-up frame as one `main` frame.

### Overdraw modules: sprite batching, ParticleBudget, ResolutionScaler

Sprite batching (`src/compiler/sprites.ts`, `src/compiler/spriteBatch.ts`). `compile()` collects every `Sprite`,
groups them by material keys (`variantHash` and colour), and for each group of at least `spriteThreshold` builds one
`Mesh` over an `InstancedBufferGeometry` unit quad with a `SpriteNodeMaterial` that takes every field of the group's
material through `material.copy()` (`alphaMap`, stencil, clipping planes and the rest) except `userData`, which the
copy would JSON-serialise and which stays empty on the batch material; `alphaTest` is set by hand because three
r186's `NodeMaterial.copy` misses Material's accessor. The batch's own `positionNode` and `scaleNode` read
per-instance attributes. Under a mirrored scene the batch swaps `FrontSide` and `BackSide` (checked every render):
three flips a mesh's front face under a negative world determinant, never a sprite's. The originals go to the hidden
layer and keep auto-updating; a `FORGE_HOOK` render hook on the batch copies their world positions and scales into
the attributes once per frame, for the main camera only (an invisible sprite gets scale 0; instances outside the
four side planes of the frustum are left out, so the count matches what three would have drawn), sorted back to
front by projected depth when the material blends normally, and sets `instanceCount`. Nested passes (reflections)
draw the main camera's list on both backends: three refreshes an object's attributes only on its first render object
of a frame, so a second fill for a nested camera would be what the main pass draws (`docs/three-r186-notes.md`).
Reason `sprite-batch`, name `forge:sprites:<programHash>:<n>`, `after.spriteBatches` in the report; skipped sprites
carry a `spriteRule` reason (section 6) or `sprite-threshold`. `decompile()` restores.

`ParticleBudget` (`src/overdraw/ParticleBudget.ts`): `new ParticleBudget({ tier, particles?, pointSizeScale? })
.apply(root)` counts every `Points` object (what its `drawRange` draws), every sprite batch (its instances) and every
single sprite; over the tier's `particles` budget, points and batches shrink by one common ratio (points through
`setDrawRange`, batches through `userData.forge.cap`, which the sync hook honours by keeping the nearest instances)
so the total fits alongside the single sprites, which cannot be capped. `PointsMaterial.size` is multiplied by
`pointSizeScale` (0.75 on `phone-low`). Returns `{ tier, budget, before, after, ratio, systems }`; `release()`
restores; `apply()` again re-derives from the originals.

`ResolutionScaler` (`src/overdraw/ResolutionScaler.ts`): `new ResolutionScaler(renderer, { target?, tier?, min, max,
step, window, ledger? })`; call `update(frameMs)` every frame; every `window` frames the median decides: above
`target × 1.05` the scale steps down, below `target × 0.7` it steps up, clamped to `[min, max]`; a change calls
`renderer.setPixelRatio(base × scale)` (three resizes the drawing buffer) and updates the ledger's `env.dpr`.
`set(scale)`, `dispose()`. Overdraw per pixel is unchanged; `overdraw.pixels` shrinks.

In the ledger: `overdraw.particles`, `overdraw.pixels`, hints `particles-over-budget` and `sprites-unbatched`, bench
metrics `particles` and `fillMegapixels` (fragments per pixel × pixels). Conventions for effects: `docs/vfx.md`.

### Per-frame JS: freezing, `markDirty`, `RenderScheduler`

What three pays in JavaScript every frame (r186): `render()` walks every descendant in `updateMatrixWorld()` (the
recursion is unconditional; an object with `matrixAutoUpdate` recomposes its local matrix and forces its subtree's
world matrices) and again in the render-list build (`visible` objects, hidden originals included). Only
`matrixAutoUpdate = false` cuts the recomposing and only removing objects from the graph (`originals: 'detach'`)
cuts the walks.

Freezing (`src/compiler/freeze.ts`, `freezableObjects`). At compile, unbatched static-tagged meshes and the topmost
ancestors whose subtree is entirely static (hidden unsynced originals, static meshes, plain containers; nothing
dynamic-tagged, animated, lit, skinned, bone or sprite inside) get `matrixAutoUpdate = false` after one last
`updateMatrix()`. An object whose `matrixAutoUpdate` was already off is placed through its `matrix` by the app, so
it is frozen without that last recompose and `markDirty` never recomposes it either: write the new `matrix` (or call
`updateMatrix()` yourself), then `markDirty`. A container freezes only when it also holds at least one such static leaf: an empty container, an
anchor `Object3D` with no children, and a light's `target` (added straight to the scene, as `DayNight` does for the
sun) are never frozen, since nothing would ever move their matrix again. `decompile()` restores the flags. The
village drops from 310 to 34 recomposed matrices per frame (bench baselines); its freeze e2e holds the compiled
frame to under 0.5 % of pixels changed at a per-channel tolerance of 24.

`world.markDirty(object)` moves a frozen static on demand: it recomposes every local matrix under `object`,
recomputes the world matrices, pushes each batched original in the subtree into its batch in the scene's space
(`BatchedMesh` matrix and BVH leaf, `InstancedMesh` through its culling handle, a baked group by rebaking once;
sprite batches follow on their own) and returns the number of instances updated. It then recomputes the bounds of
each touched batch (`computeBoundingBox`, `computeBoundingSphere`) and instanced group (`refreshBounds`, every LOD
level) once, so three's whole-object frustum test never culls an instance moved outside its old bounds while it is
on screen, and fits their occlusion proxies to the new bounds. `world.onDirty(listener)` reports `markDirty`,
`setVisible`, `compile` and `decompile` (a `RenderScheduler` subscribes to it); `world.isCompiled` says which side of
that pair the World is on. `originals: 'detach'` detaches an original only when everything under it leaves with it:
other unsynced originals, and containers holding nothing else. A batched static that parents a dynamic mesh, a synced
original, an unbatched static, a light, a camera or an empty anchor stays in the graph on layer 31, as under
`'hide'`, because removing it would take that descendant out of the scene too. With `originals: 'detach'` a detached
original has no parent, so `updateMatrixWorld` alone would give its own local matrix; `World` records each detached
original's former parent at hide time (only slotted originals are ever detached), and `markDirty` composes its world
matrix from that parent's current `matrixWorld` (read, not recomputed; `markDirty` on the parent or an ancestor
refreshes it) and the original's freshly recomposed local matrix. `markDirty` on a former parent also reaches its
detached descendants, recursively. It clears `matrixWorldNeedsUpdate` after composing, so an unforced
`updateMatrixWorld()` on a detached original with `matrixAutoUpdate` off keeps the composed matrix; with
`matrixAutoUpdate` on (the default, also for detached originals) any call that recomputes its world matrix
(`updateMatrixWorld`, `updateWorldMatrix`, `getWorldPosition` and the other `getWorld*` calls, `lookAt`) overwrites
the composed one with its parentless local matrix, so call `markDirty` on it again after such a call.

`RenderScheduler` (`src/scheduler/RenderScheduler.ts`): `new RenderScheduler({ renderer, scene, camera, ledger?,
world?, mixers?, watch?, keepAliveMs?, onRender? })`; `start()` drives `renderer.setAnimationLoop`, and `tick(time)`
renders only when `invalidate()` was called, the camera's world or projection matrix changed, a watched object
moved, a mixer has running actions (mixers are updated every tick), the drawing buffer was resized, or
`keepAliveMs` elapsed; otherwise three does nothing for that tick. Baselines are re-captured after each render
(three recomputes the camera's projection on its first WebGPU frame). `stats`, `lastReason`, `skippedRecently()`
(what `js.skipped` reports through `ledger.attachScheduler`), `stop()`, `dispose()`. A mixer counts as animating
when one of its active actions (three's private `_actions[0.._nActiveActions)`, `AnimationMixer.js` r186 ~201-202)
`isRunning()`, is scheduled to start later (`_startTime !== null`, set by `startAt()`), or has a weight interpolant
(a `fadeIn()` or `fadeOut()` in progress, three's private `_weightInterpolant`, which `_updateWeight` evaluates even
for a paused action, so a finished clip held by `clampWhenFinished` and then faded out blends back over the fade).
`mixer.stats.actions.inUse` alone would keep counting a finished `LoopOnce` action, which `clampWhenFinished` pauses
(`AnimationAction.js` ~771) or otherwise disables (~772) without removing it from `_actions`, while `isRunning()`
(~220) is false either way. The private fields are read through a reflection cast pinned by canary tests in
`test/unit/render-scheduler.test.ts`, with `stats.actions.inUse > 0` as the fallback for a mixer-like object that
does not expose them. `isRunning()` does not consult `weight`, so an enabled, unpaused action at `weight === 0`
still counts: the scheduler errs toward rendering, since a `fadeIn()` starts its target at weight 0. `tick()` asks
before and after `mixer.update()`, so the tick whose update ends a clip or a fade renders that last step.
`cameraChanged()` and `watchedChanged()` (and `watch()`, for the initial baseline) call
`object.updateWorldMatrix(true, false)` before reading `matrixWorld`, since three recomputes it only in a render
pass or an explicit update call, so moving `camera.position` or a watched transform without `updateMatrixWorld()`
is still detected. Do not `watch()` a detached original: that per-tick call overwrites the matrix `markDirty`
composed, every tick; watch the live object you move instead. The scheduler holds only the disposer
`World.onDirty()` returns and calls it once from `dispose()`, never calling back into the `World` at tick time:
constructing one against a disposed `World` throws (`World.onDirty()`'s own guard), disposing the `World` while the
scheduler runs throws nowhere (its listener set is cleared, and every other detector keeps working), and
`scheduler.dispose()` is safe before or after `world.dispose()`.

In the ledger: `js.hiddenOriginals`, `js.skipped`, budget `objects`, hints `js-objects` (over budget) and
`detach-originals` (1 000 or more hidden originals: use `originals: 'detach'`); bench metrics `objects` and
`autoUpdatedMatrices`.

### Lighting: `DayNight`, `ShadowBudget`, lightmaps

`DayNight` (`src/lighting/DayNight.ts`) is one sun on a circle (rise 6, set 18, a faint moon below), a gradient sky
dome (`sky-dome`, vertex colours, static-tagged so it freezes and draws once), a hemisphere light, and fog and
background following the horizon. `setTime(hours)` drives all of it and requests a shadow-map render only when the
sun moved `everyDegrees` (default 0.5) since the last one, through `shadow.needsUpdate` with `autoUpdate` off. The
dome's vertex colours are rewritten only when the zenith or horizon colour differs from the one they were last
written from, so stepping the hour within an unchanging palette costs no vertex walk and no re-upload;
`refreshDome()` drops that cache for a caller that rewrote the dome itself. `refreshShadow()`, `dispose()`. The
day/night benchmark renders the map every second frame.

`ShadowBudget` (`src/lighting/ShadowBudget.ts`): `apply(scene)` switches shadows off on the `off` tiers, drops
point-light shadows off phones, then halves the largest map until the texel sum fits the tier's `shadowTexels`
budget (floor `minMapSize`); three resizes the targets on the next shadow render. `release()` restores.
`ShadowBudget.freeze(light)` returns a `refresh()` for static lights.

Lightmaps: the registry keys `lightMap` and its channel, `attributeSignature` includes `uv1`, and the bake carries
and welds every UV set, so lightmapped statics batch and bake without losing their coordinates. Authoring notes:
`docs/lighting.md`. In the bench, `shadowPassesPerFrame` and `shadowTexels` (means over the measured frames, texels
rounded) are gated; the optimized day/night and boss fight apply `ShadowBudget` for the detected tier.

### Skinning: `bakeAnimationTexture`, `AnimatedInstances`

`bakeAnimationTexture(prototype, clips, { fps })` (`src/skinning/bakeAnimationTexture.ts`) plays every clip on the
prototype at the origin (`LoopOnce`, clamped, so the last row is the end pose) and copies every distinct skeleton's
`boneMatrices` into one RGBA float `DataTexture`: a row per frame, four texels per bone, skeletons after each other
(`parts[i].boneOffset`); `clips[i]` is `{ name, start, frames, duration }` and `parts[i]` is `{ mesh, matrix,
boneOffset }`. The prototype's transform and pose are restored.

`AnimatedInstances({ animation, count, material? })` (`src/skinning/AnimatedInstances.ts`) builds one `Mesh` per part
over an `InstancedBufferGeometry` sharing the part's buffers, with a `MeshStandardNodeMaterial` whose TSL
`positionNode` fetches the instance's four bone matrices for its current row (`clipStart + floor(mod((time × speed +
offset) × fps, frames))`), applies `bindMatrixInverse × Σ bone × weight × bindMatrix`, then the part's offset
(`parts[i].matrix`, a `mat4` uniform of that part's material, read every frame) and the instance matrix, and assigns
`normalLocal`. The instance matrices live in one `InstancedInterleavedBuffer` the parts share (four separate
attributes would exceed WebGPU's eight vertex buffers; a plain `InterleavedBuffer` is read per vertex, because both
backends take the per-instance step from `isInstancedInterleavedBuffer`). `setMatrixAt` and `getMatrixAt`,
`setClipAt(i, clip, { offset, speed })`, `setTime(seconds)`, `addTo`, `dispose`. Meshes are `forge:vat:<part>` with
`userData.forge = { kind: 'vat', instances }` (untagged: a tag overwrites the marker). In the ledger: reason
`vat-instanced`, `skinning.vatInstances` and `vatVertices`, budget `bones`, hints `bones-over-budget` and
`skinned-crowd` (50 skinned draws). Authoring notes: `docs/skinning.md`. The optimized crowd bench bakes each of its
eight prototypes and replaces its 25 characters with one `AnimatedInstances`: 401 → 17 submissions, 271 k skinned
vertices → 0.

### Memory and load: `createLoader`, `ResourceTracker`, `Streamer`

`createLoader(renderer, { decoders, draco, ktx2, meshopt })` (`src/load/createLoader.ts`) returns a `GLTFLoader` with
Draco, KTX2 (`detectSupport` after `renderer.init()`) and meshopt wired; the addons import lazily.
`disposeLoader(loader)` ends the worker pools. `threeforge decoders <dir>` (`src/cli/decoders.ts`) copies the decoder
files from the installed three.

`ResourceTracker` (`src/memory/ResourceTracker.ts`): `track(root | geometry | texture | material, owner?)`,
`release(owner)` disposes what no other owner holds (never a material the registry knows) and detaches an Object3D
owner, `dispose()`, `stats()`. `collectResources(root)` and `unreferencedResources(info, scene, allowance)` are the
building blocks (`src/memory/resources.ts`).

`release()` and a `Streamer` unload dispose geometries through `disposeGeometries(geometries, inUse)`, which code
that frees a scene by hand should use too. three r186 cannot draw an interleaved geometry again after `dispose()`
(GLTFLoader builds one for every bufferView with a byteStride, and glTF-Transform writes that layout by default). On
WebGPU `WebGPUAttributeUtils.destroyAttribute` keeps the destroyed buffer's record under the `InterleavedBuffer`, so
the next upload reuses it and every submit fails with "used in submit while destroyed". On WebGL2
`Geometries.updateAttribute` skips every attribute after the first of a buffer it has seen before, so the draw fails
with INVALID_OPERATION and nothing says so. Both key on object identity, so `disposeGeometry(geometry)` disposes and
then replaces the interleaved attributes by new ones over a new `InterleavedBuffer` on the same array; geometries
that shared a buffer share the new one. Objects taken from the geometry before that keep working: an old attribute
reads the new buffer, and the old buffer's version and update ranges are the new one's, so `needsUpdate` on either
still uploads. Two geometries are left uploaded: the one three shares between every `Sprite`
(`isSharedSpriteGeometry(geometry)`, it belongs to no scene), and one that reads an `InterleavedBuffer` a geometry
still in use reads too (GLTFLoader caches one per accessor, so primitives that reuse an accessor share it), since
disposing it destroys the buffer under the one still drawn. Those go with a later release or unload, once nothing in
use shares their buffer. In use means more than what the caller manages: the Streamer counts every mesh in the scene
the camera's layers can draw (a mover outside its chunks, not an original hidden on layer 31), and a
`ResourceTracker` counts the meshes under the released owner's root, or under its `scene` option for an owner that
is not an object or is detached already. Both walk the scene only when a geometry being freed is interleaved.

`Streamer` (`src/streaming/Streamer.ts`) manages the residency of `world.chunks()` (batches, instanced groups and
baked meshes carry `userData.forgeChunk`) plus uncompiled static scene children placed by position, keyed by x and
z. A chunk is resident while the ground-plane distance from the camera to the cell's box is at most `radius`
(default `camera.far`) and unloaded past `radius + margin × chunkSize` (first update strict). Unload removes the
objects and disposes the geometries and textures no resident chunk shares, including a BatchedMesh's matrix,
indirect and colour textures (never `BatchedMesh.dispose()`, which nulls them); load re-adds them and three
re-uploads. An interleaved geometry reaches the Streamer as an uncompiled static or as an instanced group, which
draws the source geometry (a BatchedMesh owns a plain copy), and is freed like any other. `retainedGeometries()`
lists what `disposeGeometries` left uploaded for chunks that are away, and an attached ledger allows those three
holds buffers for instead of counting them under `memory.unreferenced`. `assign`, `userData.forgeStream = false`, `stats()`, `onChange`, `dispose()`
(every chunk resident again, then the chunks and the object index released, so a disposed Streamer holds none of the
World's objects, `stats()` reports none and a later `update()` does nothing). `ledger.attachStreamer(streamer)`.

In the ledger: `memory.unreferenced`, `memory.chunks`, `memory.measured`, budget `geometryBytes` (256 / 96 / 48 MB),
hints `geometry-bytes` and `unreferenced-resources` (eight or more). Authoring notes: `docs/memory.md`. In the bench,
zen's ground is 64 tiles with a 512² texture each (85 MB) under fog to 600 m and the optimized variant streams them,
32 of 64 chunks resident at the start camera; `test/e2e/streaming.spec.ts` (5,000 objects) holds the start frame to
under 0.5 % of pixels changed against naive at a per-channel tolerance of 24.

## 8. Bake: one mesh per finished group

`new World(scene, { bake: true | options })` replaces the `BatchedMesh` of each finished static group with one
scene-space `Mesh` (`bakeGeometries` in `src/compiler/bake.ts`; every UV set present in all entries, `uv` to `uv3`,
is carried and compared by the weld). The steps:

1. Gather: positions and normals transformed to the scene's space (world space for an untransformed scene; mirrored
   matrices flip winding), uv when every module has it, tangents when every module has them (xyz turned by the
   module's matrix and normalised, `w` kept as it is: three builds the bitangent as `cross(normalView, tangentView)
   * tangent.w` with no determinant term, so flipping `w` under a mirrored matrix would change the normal-mapped
   shading), colour from vertex colours × instance tint, where the vertex colours count only when the module's
   material reads them (`BakeEntry.vertexColors`; with a tint the material becomes a `vertexColors` clone, and a
   rebake keeps the flag recorded at bake time).
2. Contact seams: triangles are grouped by plane, split into the two facing sides and merged into islands along
   shared edges. An island is paired only when it covers its region exactly once: every edge (by position) is used
   at most twice inside it (an edge used three times drops out of the outline, so regions of different size could
   share one), and no two of its triangles overlap by more than `tolerance` in the plane (a doubled area could hide
   behind a matching outline). Its outline is then the set of edges used once, so two islands with the same outline
   cover the same region whatever their triangulations, and an island whose outline equals an island's on the other
   side is a coincident, opposite-winding pair. Both go as a seam between touching solids only when all five hold:
   1. the two islands come from disjoint sets of modules (entries);
   2. every module involved is a closed, manifold, outward shell: every edge (by position) is used exactly once in
      each direction, and every connected component encloses a positive signed volume (computed once per module in
      the baked space, after the winding flip for a mirrored matrix, so a mirrored outward shell stays outward). An
      edge shared by two parts of one module, used four times, fails this test;
   3. every module involved draws front faces only (`BakeEntry.side` is `FrontSide`, set by `bakeEntriesOf`): a
      `BackSide` material draws exactly the faces a seam hides (from inside a modular room the shared wall is the
      nearest drawn surface), and a `DoubleSide` one draws both;
   4. no module involved casts shadows (`BakeEntry.castShadow` is `false`, copied from each original): non-VSM shadow
      maps draw a front-side material's back faces (`WebGLShadowMap.js`, the shadow override in
      `renderers/common/Renderer.js`), so a seam face is the nearest caster for the neighbouring module's face
      turned away from the light, which a toon ramp still lights at 0.7 × light × shadow. A rebake (hiding or
      showing a module) decides every removal again, counting a module as casting when its original or the baked
      mesh casts: once neither casts, the next rebake may remove the seams, and turning casting on for either after
      compile keeps the faces only after the next rebake or a `decompile()` and `compile()`; until then the baked
      mesh casts without those faces if casting was turned on for the baked mesh itself, and casts nothing at all if
      it was turned on only for a hidden original;
   5. every module involved is opaque, by an allowlist of three's default material hooks (`BakeEntry.opaque`, set by
      `bakeEntriesOf`): exactly one of three r186's 35 material classes (`isBuiltInMaterial`: the 18 of
      `src/materials/Materials.js` and the 17 of `src/materials/nodes/NodeMaterials.js`; a subclass fails, since an
      overridden `setup*` builds the shader and can discard); no function assigned to the instance
      (`hasOwnFunctions`); not transparent; normal or no blending; no `alphaTest`, `alphaHash`, `alphaToCoverage` or
      `transmission`; not a `ShaderMaterial`; every node slot empty (every `*Node` property and any other own
      property holding a node, because `Discard()` can sit in any of them; under `World` such a material never
      reaches this test, since its group is not baked at all, see below); `onBeforeCompile` and
      `customProgramCacheKey` are three's own; `defines` holds only three's material defines (`STANDARD`,
      `PHYSICAL`, `TOON`, `MATCAP`); no `displacementMap`, material `clippingPlanes` or `polygonOffset`; `depthFunc`
      is `LessEqualDepth`; depth write and depth test on; no `wireframe` or `stencilWrite`. Renderer-level clipping
      (`renderer.clippingPlanes`) is outside what the bake can see. A rebake keeps the decision made at bake time and
      requires the current material (for a tinted group, its vertex-colour clone) to pass too, so a rebake never
      removes more than the bake allowed.

   Every other coincident, opposite pair stays and is counted in `keptCoincidentFaces` (only faces the bake does not
   remove otherwise): back-to-back sign cards, a floor lying on a ceiling, a pair inside one module, a back-side,
   double-sided, translucent or shadow-casting pair, a face against a flat slab, an open box, an inside-out box, a
   shell joined to another part by a shared edge, an island whose triangles overlap. Islands with an edge used three
   or more times are not paired at all, and partial overlaps stay too.
3. Duplicates (`removeDuplicateFaces`, default on): copies of one triangle (the same three points, in any entry,
   excluded ones included) are gathered, and a same-winding set loses its later copies only when every copy is in an
   entry whose faces may be removed (opaque, front-side, casting no shadow, not `forgeBake = false`), every copy
   draws the same as the first (each corner's normal and tangent direction within `normalAngle`, tangent `w`
   identical, uvs within 1e-5, gathered colour with the instance tint within `colorTolerance`), and no other triangle
   lies in their plane over them (a copy triangulated differently, a double- or back-side face). three draws the
   later of two copies at equal depth, so a copy that draws differently decides the pixel and stays. Kept copies are
   counted in `keptDuplicateFaces`. Two islands on the same side of a plane never share an outline (shared outline
   edges fuse them), and a region covered twice with different triangulations fuses into one island with no outline
   at all: it is skipped and stays doubled, an invisible cost.
4. Buried faces (opt-in `removeBuried`): 24 rays over the front hemisphere from each face, cast against a BVH of the
   group's opaque faces of front-side or double-sided modules (three-mesh-bvh), counting only hits on a triangle's
   back side: a viewer beyond the hit, looking back along the ray, then sees that triangle drawn (a front-side card
   facing the face shows such a viewer its culled back, so it blocks nothing; a face pressed against a neighbouring
   solid's front face is buried only when that solid's far side is within `distance`). The face is buried only if
   every ray is blocked within `distance` measured along the face normal (default 0.1 units). Only faces of opaque,
   front-side modules that cast no shadow are removed; room interiors and open backsides survive; back-side faces
   never block a ray (a back-side shell draws its far wall behind whatever is inside it).
5. Weld: vertices merge only when position (`tolerance`, default 1e-4), normal and tangent xyz (`normalAngle`,
   default 0.5°), tangent `w` (exact), uv (exact) and colour (`colorTolerance`, default 1/255) agree, so a merge
   moves shading by at most those tolerances; `bake.spec.ts` holds every baked scene it renders under 0.05 % changed
   pixels at a per-channel tolerance of 4.

Groups the bake leaves to batching. `World` batches, rather than bakes, a group whose material the bake cannot prove
draws the merged, scene-space geometry as it drew each module (`bakeProvesReads` in `src/compiler/batchStatics.ts`):
one that is not exactly one of three's own material classes, has a function assigned to the instance, has a node in
any slot, or has a `displacementMap`. A node graph can read `positionLocal`, `normalLocal` or `positionGeometry`
inside a `Fn` closure nothing inspects before it builds, and three displaces along the local normal in local units,
so all of these may change once the geometry is in scene space (a `normalLocal` colour node and a displacement map
on scaled, rotated boxes changed 4.40 % of the frame on both backends when baked, and 0 once batched). `alphaHash`
and an object-space normal map on three's own materials still bake: they read mesh-local space, which batching and
instancing move the same way, so they changed the same pixels baked, batched or instanced (section 7, the
`batch-local-space` hint) and leaving the bake would restore none. It also batches a group where any geometry
carries an attribute the bake does not carry faithfully (`unbakeableAttribute(geometry, vertexColors, builtInReads)`
in `src/compiler/bake.ts`, not exported from the package entry point): a four-component `color` the material reads
(the bake writes three components, and three multiplies the alpha into the diffuse colour, so a glTF `BLEND`
material with an RGBA `COLOR_0` would render more opaque), a `color` the material's `vertexColors: false` ignores but
something other than three's own code may read, or any attribute outside `position`, `normal`, `tangent`, `uv` to
`uv3` and `color`. The bake drops a `color` its flag ignores only when the material is one of three's own classes
with no instance function and no node in any slot: an allowlist, since a `colorNode = vertexColor()` or an
overridden `setupDiffuseColor` reads the attribute whatever the flag says. `BakeSummary.unbakeableEntries` counts
those meshes.

Near-plane limitation (known in 0.9.0). Seam and buried-face removal judge what a camera outside the modules can
see. A camera whose near plane cuts into a module (a first-person camera pressed against a wall, near 0.1) clips that
module's front face; naive, it then sees the neighbouring module's contact face, which faces into the clipped module
and is drawn; baked, that face is gone and the neighbour's other faces point away and are culled, so the view goes
through both modules. Keep such cameras out of the solids, or exclude the modules with `forgeBake = false`.

Direct `bakeGeometries` callers: `bakeEntriesOf` (and so `World`) sets every entry flag from the material. An entry
without `opaque` counts as not opaque, so it gets no seam and no buried-face removal; an entry without
`vertexColors` keeps multiplying its geometry's colour attribute by the tint; an entry without `side` counts as not
front-side (`doubleSided: true` has the same effect) and an entry without `castShadow: false` counts as a shadow
caster, so neither loses faces.

Control and inspection: `mesh.userData.forgeBake = false` passes a module through untouched; the compile report's
`bake` block counts seams, `keptCoincidentFaces`, duplicates, `keptDuplicateFaces`, buried faces, welded vertices,
excluded entries and `unbakeableEntries` (the CLI prints the kept counts next to the seams and duplicates);
`world.bakeDebug()` returns a copy of the removed faces as red unlit meshes, a snapshot the caller owns and disposes;
hiding a module rebakes its group; `decompile()` restores. Instanced groups and batch-synced dynamics are never
baked. The CLI's `analyze --bake --views N` bakes and checks pixel parity from N+1 camera angles: the verdict passes
a view with up to `--parity` percent of its pixels changed (default 0.5), and `--parity 0` fails it unless every
view has `changedPixels: 0` (no channel moving by more than 24). Verified in `test/e2e/bake.spec.ts` on both
backends, each view held to under 0.05 % of pixels changed at a per-channel tolerance of 4: the village bake; a 6×3
modular wall loses exactly its 27 seams, also under a mirrored scene; back-to-back sign cards and a floor lying on a
ceiling keep both faces, seen from both sides; touching back-side rooms keep their shared wall, seen from inside and
from outside; touching toon boxes that cast shadows keep their seam, lit along it with shadows on; a mirrored,
normal-mapped mesh baked by `bakeGeometries` keeps its tangents; a block 5 cm inside a solid goes only with
`removeBuried`; two crates in one place differing only by colour keep the one three draws on top; RGBA vertex
colours and a custom attribute stay out of the bake. In `test/e2e/cli.spec.ts`, the 2CylinderEngine assembly passes
`analyze --bake --views 3` at the default 0.5 % over four views.

## 9. Character assembler

`assembleCharacter({ skeleton, wardrobe, equipped, atlas: { size }, material })` merges skinned parts onto one shared
skeleton: bones are remapped by name, textures are packed into a k×k grid atlas (a `DataTexture` in node, an
`OffscreenCanvas` in the browser) with uv clamping and a half-texel inset, and one skinned mesh with one material
results. `equip(part)` and `unequip(part)` rebuild only the vertex buffer; the draw count never changes. The report
gives the atlas cells (`cellOf`), bones and vertices; `dispose()` frees the atlas. Gear swaps change data, not draw
calls.

## 10. For AI agents: hook, CLI, MCP

`exposeToAgents({ ledger, world, renderer, scene, camera })` publishes `window.__threeforge` with `version`,
`schemaVersion` (3, the frame snapshot's), `frame()`, `frameAsync()` (waits one animation frame so shadow maps
update, renders if it can), `compile()` and `decompile()`, `measureOverdraw()`, `measureMemory()`, `hints()` and
`report()`, and returns a disposer. Only one of `compile` and `decompile` is present at a time and it follows the
World, not the hook's own calls: an app that compiled before exposing, or compiles later on its own, offers
`decompile` only, and `threeforge inspect` then measures the scene as it is and reports `compile: null`. It lets any script on the page call `compile()`/`decompile()` and read the
ledger, so call it as `if (import.meta.env.DEV) exposeToAgents(...)` (Vite) or behind your own flag, never
unconditionally in a shipped build; bundlers other than Vite need their own dev check.

The CLI (`npx threeforge`; `help [<command>]` or `--help` prints AGENTS.md) has `analyze <file>`, `inspect <url>`,
`optimize <file>`, `explain [<code>] [--all]`, `schema [snapshot|analyze|inspect|optimize|all]`, `decoders <dir>` and
`mcp` (a stdio Model Context Protocol server with `analyze_asset`, `inspect_app`, `optimize_asset` and
`explain_hint`). Every command's positionals and flags are declared once in `COMMAND_SPECS` (`src/cli/args.ts`); the
parser, the usage text and the AGENTS.md tables come from it, and `RANGES` plus the cross-field rules are checked by
`validateInput(command, input)`, which the MCP server reuses. The flags and their ranges, the document
(`schemaVersion: 2`), the verdict rules, the exit codes (0 pass, 1 verdict failed, 2 usage or input, 3 environment,
4 page error or timeout), the presets, the input URI confinement and the `--out` rules are in
[AGENTS.md](../AGENTS.md), generated by `scripts/agents-md.mjs`. Programmatic use: `import { analyzeAsset,
inspectApp, optimizeAsset, explain } from 'threeforge/cli'`. Playwright, `@modelcontextprotocol/sdk` and `zod` are
optional peers imported lazily; game code never pays for them.

Not restated in AGENTS.md: `inspect` and `analyze`'s `measureViaHook` exit 4 before measuring when the hook's
`schemaVersion` is not 3 or the frame it returns is shaped differently, naming both versions and the fix. Each of
the four `schema` documents is self-contained (`analyze` and `inspect` embed the snapshot as `$defs.FrameSnapshot`,
`optimize` embeds that and the analyze document as `$defs.AnalyzeDocument`), so any one validates alone in a
draft-2020-12 validator; the schemas (`$id` `https://threeforge.dev/schema/<command>-v2.json`) close every
fixed-shape object except the open `compile` report, which requires only `skippedCount` and `groupCount`. `--json`
writes the document to stdout before the human summary is built, then the summary to stderr. The URI check
(`assertConfinedUris`, `src/cli/gltf-uris.ts`) runs before a browser opens, because three's `LoaderUtils.resolveURL`
returns absolute and protocol-relative URIs unchanged and an untrusted asset could otherwise make headless Chromium
issue requests from this machine's network; the page is also held to the served origin by a catch-all Playwright
route that aborts every other request and names up to five on the progress line. The ledger caps `byReason[].top`
names and a hint's `objects` at 120 characters and a hint's `message` at 300 (`src/ledger/text.ts`); the CLI cleans
every value read from the page or the asset with `sanitizeDeep` (`src/cli/untrusted.ts`, which lists the exact
character classes it strips), capping strings at 300 code points, arrays at 256 elements (an array of strings ends
in a `(+N more)` marker; any other is cut silently, which is why `compile` carries its counts) and nesting at 16
levels, and normalizing non-finite numbers to 0, on a resolved and a rejected `page.evaluate` alike.

### Build-time optimize (`threeforge optimize`)

`src/cli/pipeline.ts` (pure), `src/cli/transform.ts` (glTF-Transform) and `src/cli/optimize.ts` (the command) run
the steps in the order glTF-Transform recommends (dedup, instance, palette, flatten, join, weld, simplify, resample,
prune, textures, quantize, meshopt). `safe` is dedup, palette and prune; `balanced` adds weld, resample, quantize and
textures webp 2048 px, and being lossy its Fox e2e states a measured tolerance of 0.05 %, about 3× the worst view
measured; `aggressive` adds simplify 0.5 and textures 1024 px. A preset's texture step without `sharp` is skipped
with a note; an explicit `--textures` without it is an environment error (exit 3), as is a Draco input without
`draco3dgltf`.

Two steps were measured out of `safe`. `weld` merges only bitwise-identical vertices, but welding the Fox's
primitive moves up to 0.014 % of pixels on WebGPU, and measured the same way it moves pixels on PotOfCoals
(0.004 %) and VirtualCity (0.011 %), which are indexed and carry normals. `resample` can make a file bigger: at
`tolerance: 0` it is pixel-exact but keeps every keyframe that is not an exact duplicate, and swept over the 79
readable corpus assets against a re-serialized baseline the median asset is 0.000 % while Xbot grows 1.248 % and the
Fox 0.100 %; it pays for itself in the lossy presets, where the 1e-4 default applies (Soldier −18.9 %, BrainStem
−14.9 %, VirtualCity −9.5 %). `--weld` and `--resample` add either back, and `--resample` under `safe` runs at
tolerance 0. Every percentage is against a re-serialized baseline, since glTF-Transform re-serializes the container
whatever runs (the Fox alone is +0.86 %, the Buggy −27.4 %). `palette` was never swept on its own: it considers only
untextured materials, does nothing unless 5 or more of them differ (`min: 5`) and a factor has 5 or more distinct
values, writes base colour (converted to sRGB), emissive, metallic and roughness factors into 8-bit palette PNGs
sampled nearest-filtered, and gives every merged primitive a new `TEXCOORD_n` of two floats per vertex, so it can
grow a file and a factor quantized to 1/255 can shift shading by less than the 24-level tolerance. `safe` is
measured at 0 changed pixels in every view on both backends for the Fox and the Buggy: no pixel's R, G or B differs
by more than 24 (`comparePixels`, `src/cli/analyze.ts`; alpha is never compared, so the claim is "nothing visibly
moved", not bitwise equality), asserted on the raw `changedPixels` per view because `diffPct` is rounded to three
decimals and at 1280x720 absorbs up to 4 changed pixels of 921,600. On the Buggy `safe` takes 148 materials to one;
the Fox has one material, so `palette` does nothing there. `verify.original` and `verify.optimized` each carry a
compile parity judged at analyze's default 0.5 % whatever `--parity` is (`verifyAnalyzeInput`); the Buggy e2e pins
that separation, since `--preset safe` is pixel-identical between its two files on both backends while compiling
either file moves 1 px on webgl2 and 2 px of 921,600 on webgpu, and tightening the compile checks with `--parity 0`
was tried and reverted because it answered "no" to the question `--parity` asks. Deltas are never judged: a palette
texture can grow a file that then draws in one call. Limits: no atlasing across materials that differ by textures,
no KTX2 encoding (needs `toktx`), no `MSFT_lod` chains, no Draco output.

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

`pnpm bench [backend]` measures 10 warm-up and 60 measured frames per variant (medians) plus one overdraw and
memory measurement, writes `bench/results/local.<backend>.json` and fails when any deterministic metric
(submissions, GPU draws, triangles, programs, overdraw, skinned vertices, shadow casters and texels, memory bytes)
is worse than `bench/baselines/<backend>.json` by 10 % or more; timing is gated only with `FORGE_GPU=native`.
`pnpm bench:baseline` promotes results and rewrites [docs/bench.md](bench.md), the README table and the line below;
`pnpm bench:table` rewrites them from the committed baselines. The device bench page (`bench-app/`, `pnpm
bench:app`) runs the same scenes and metrics on a visitor's device and submits the result as a GitHub issue that
`bench-results.yml` ingests into `bench/devices/*.json` and [docs/devices.md](devices.md); device numbers are
published, never gated. The page, the wire form and the ingest validation: `docs/design.md` and `docs/release.md`.

<!-- bench:start -->
Current baselines (webgl2, scene submissions naive → optimized): village 303 → 28, forest 5706 → 13, crowd 401 → 17, bossfight 2780 → 370, lake 3548 → 7, daynight 605 → 28, zen 3540 → 88, rpg 4 → 1.
<!-- bench:end -->

## 12. Development, tests, CI, release

Commands, the harness query parameters and the repository rules are in [CONTRIBUTING.md](../CONTRIBUTING.md); the release
procedure, what CI covers and does not, and the device-page settings are in [docs/release.md](release.md). Units run
against a fake renderer that mirrors the backends' draw counting; anything touching the renderer also has a
Playwright spec on both backends. The `webgpu` e2e leg in CI runs on SwiftShader and checks no pixels
(`test/e2e/fixtures.ts` turns `pixelChecks` off), so WebGPU pixel parity is proven only by a local run on a native
adapter. The four workflows are `ci.yml` (commit rules, unit, e2e per backend, bench per backend, publish on `v*`
tags), `assets.yml` (weekly corpus run), `pages.yml` (the device bench page) and `bench-results.yml`.

### Corpus report

`pnpm assets` then `pnpm assets:report` compiles every downloaded public glTF model with pixel parity on each backend
(`docs/assets-report.md`, `docs/assets-report-webgpu.md`; `FORGE_ASSETS=Fox,Duck` limits the run). The report is
regenerated deliberately from a clean tree (`docs/release.md`, step 3); the current one was generated from 0.9.0 code
at commit `fa62e52`, run `corpus-20260917`, and passes 104 of 104 models on each backend: 0 unattributed draws,
decompile restoring the naive count, and under 0.5 % of the pixels of one view changed at a per-channel tolerance of
24. Its `diff` column is that percentage rounded to two decimals, so the 0 every row reads means under 0.005 %, not
zero changed pixels. On native WebGPU, texture-heavy rows (`polyhaven-CoffeeCart_01`, `Sponza`) can show a non-zero
`diff` of up to ~0.04 % that moves between regenerations with no code change: the two screenshots land at different
points in the Metal adapter's texture and mip residency settling, which the fixed three-frame warm-up does not
bound, so this is capture-side noise rather than a rendering difference and stays two orders of magnitude under the
0.5 % gate. Bounding texture residency before capture is a harness improvement not yet made.

## 13. What we learned about three r186 (and how threeforge works around it)

Moved to [docs/three-r186-notes.md](three-r186-notes.md): the r186 behaviours threeforge depends on or works
around, each with the mechanism in this file that answers it.

## 14. Limits and roadmap

Overdraw modules shipped in 0.4.0, per-frame JS (freezing, `markDirty`, `RenderScheduler`) in 0.5.0, lighting
(`DayNight`, `ShadowBudget`, lightmap path) in 0.6.0, skinning (`bakeAnimationTexture`, `AnimatedInstances`) in
0.7.0 and memory and load (`createLoader`, `ResourceTracker`, chunk `Streamer`) in 0.8.0 (section 7);
`threeforge optimize` shipped in 0.3.0 (section 10) and the device bench page with GitHub-native results is in
section 11. Not built: animated instances play one clip per instance without blending or root motion; soft-particle
materials are documented, not built (`docs/vfx.md`); cascaded shadow maps (three's `CSMShadowNode`) are not wired;
the Streamer keeps CPU copies and re-uploads rather than fetching chunk data on demand (that needs incremental
compile). Design notes live in `docs/design.md`.

### Known limitations of 0.9.0

Each is documented where the mechanism is, and none has a fix in this release.

- Occlusion hides a batch from shadow maps and reflections too (section 7, "Occlusion"): with `occlusion: true`, a
  target its proxy reads as occluded is `visible = false`, which three honours in every render.
- A `World.compile()` that throws part-way leaves what it had done: batches stay in the scene and originals stay
  hidden while `compiled` stays false, so neither `decompile()` nor `dispose()` undoes it (only the pass tracker's
  scene hooks are removed on that path). Rebuild the scene, or reload, rather than retrying `compile()` on it.
- Batching and instancing move mesh-local space for node materials that shade from `positionLocal`, `alphaHash` and
  object-space normal maps (section 7, "Options", and section 8, "Groups the bake leaves to batching"). Measured with
  `bake` off by `test/e2e/local-space.spec.ts` on both backends, on its own four transformed statics: a
  `positionLocal` colour gradient 11.08 %, `alphaHash` 5.56 % (webgl2) / 5.59 % (webgpu), an object-space normal map
  9.54 %, against a plain material on the same boxes at 0 changed pixels. The shares scale with how much of the
  frame the affected meshes cover, so the spec records them as annotations and asserts only that the
  `batch-local-space` hint fires and that the picture changed. Tag such meshes `dynamic` (without `dynamics:
  'batch-sync'`) to keep them individual.
- The bake's seam and buried-face removals leave a hole when the camera's near plane cuts into a module (section 8,
  "Near-plane limitation").
- `memory.unreferenced` has residual blind spots (section 4 and `docs/memory.md`): resources three created before
  `ledger.attach()` count as unreferenced, a render target drawn once and abandoned without `dispose()` is allowed
  as live, and transmission's and XR's viewport textures still count as unreferenced.
- WebGPU pixel parity is not checked in CI (section 12): only a local run on a native adapter checks it.
- `optimize --parity 0` is zero only between the two files as loaded (section 10): each file's own compile check
  stays at 0.5 % whatever `--parity` is, reported in `verify.optimized.parity`. Run `analyze --parity 0` to ask
  about a compile directly.
- `palette` is the one `safe` step never swept across the corpus (section 10). `weld` and `resample` were swept and
  moved out of `safe` on what the sweep showed; `palette` is the step in `safe` that quantises, and its lossless
  proof is two assets, the Fox and the Buggy's 148 materials, at zero changed pixels on both backends
  (`test/e2e/cli.spec.ts`). If any preset step deserves the corpus sweep next, it is this one; `--no-palette` drops
  it from any preset.
- A shadow pass's `#k` suffix is positional (section 4, "Passes"): `shadowPassIds` numbers lights that share a name
  in scene order, so `shadow:DirectionalLight#1` and `#2` can swap between frames when the scene order changes; the
  counts stay right, the labels move. Name shadow-casting lights distinctly to pin them. The `#k` on a `nested:` or
  `scene:` id is positional the same way, handed out in the order the frame enters those passes.
- Two lights sharing one `shadow.camera` object collapse into one pass: the ledger keys shadow passes by camera
  identity (`Map<Camera, ShadowPass>`), which is what makes a nested pass attributable at all, so an app that
  assigns one light's `shadow.camera` onto another loses the second light's pass and its texels from the frame.
  three itself renders both maps.

## 15. Glossary

- submission: one render item three processed (a mesh, a material group of a mesh, a batch, a sprite) in one pass.
- sceneSubmissions: submissions attributable to the user's scene; the budgeted number.
- gpuDraws: draw calls those submissions add to `renderer.info` on this backend; drawCommands counts multi-draw
  ranges with a non-zero index count.
- unattributed: reported draw calls the ledger's model did not predict; always 0 in the tests.
- program: a compiled shader variant, as counted by `renderer.info.memory.programs`.
- tier: `desktop`, `phone-mid`, `phone-low`; drives budgets and hints.
- seam: two coincident faces with opposite winding between touching solid modules (different, closed and manifold,
  outward, opaque, front-side and casting no shadow); removed by the bake. Any other coincident, opposite pair is
  kept and counted (`keptCoincidentFaces`).
- buried face: a face with solid geometry right in front of it in every direction; removed only on request.
