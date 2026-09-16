# Lighting and shadows with threeforge

The ledger's lighting section counts visible lights by type, shadow-casting lights, shadow passes per frame,
unique casters, shadow texels (`mapSize² × faces`, six faces for a point light) and shadow submissions. Three
modules act on it: `DayNight`, `ShadowBudget`, and the lightmap path through the compiler and the bake.

## What a shadow costs

Every shadow-casting light renders the casters again into its map, once per frame while `shadow.autoUpdate` is
true: a 2048² directional map is 4.19 M texels of depth and one extra submission per caster (one per batch after
`compile()`); a point light renders six faces. The budgets per tier are 4 M / 1 M / 262 k texels
(desktop / phone-mid / phone-low), and `shadow-texels` warns above them.

## DayNight

```ts
import { DayNight } from 'threeforge';
const sky = new DayNight(scene, { shadow: { mapSize: 2048, extent: 140, everyDegrees: 0.5 } });
sky.setTime(hours); // 0..24 every frame or whenever your clock advances
```

One `DirectionalLight` sun on a circle (rise at 6, set at 18; a faint moon below the horizon), a gradient sky
dome (an inverted sphere with vertex colours, `sky-dome`, tagged static so the compiler freezes it and draws it
once; it is one full-screen opaque layer, about +1 `overdraw.opaque`, so pass `dome: false` on `phone-low` and
let the background colour carry the sky: the measured overdraw never counts the background), a `HemisphereLight`, and `scene.fog` and `scene.background` following the horizon colour. The shadow map
re-renders only when the sun moved `everyDegrees` since the last render (0 = every frame): a 24-minute day cycle
moves 0.25° per second, so the map renders every two seconds instead of sixty times a second. Call
`refreshShadow()` after `world.markDirty()` moved a caster. `dispose()` removes everything it added and restores
the fog and background.

## ShadowBudget

```ts
import { ShadowBudget } from 'threeforge';
const report = new ShadowBudget({ tier }).apply(scene); // { tier, budget, before, after, lights[] }
```

Point-light shadows go off on phone tiers (`pointShadows: true` keeps them), every shadow goes off on the tiers
listed in `off`, and then the largest map halves until the texel sum fits the tier budget (never below
`minMapSize`, 256). three resizes the render targets on the next shadow render. `release()` restores every size
and flag. For a light that never moves, `const refresh = ShadowBudget.freeze(light)` renders its map once and
then only when you call `refresh()`; a freshly created map renders twice on its first request (three allocates
the target first), then once per refresh.

## Lightmaps

Bake lighting into one atlas per group of statics: each mesh gets `material.lightMap` (the shared atlas) with
`lightMap.channel = 1` and its coordinates in `geometry.attributes.uv1`. The registry keys the lightmap texture
and channel into the program and `lightMapIntensity` as a uniform, so meshes sharing an atlas batch together and
meshes with different atlases become different batches. `attributeSignature` includes `uv1`, so lightmapped
geometry batches; the bake carries `uv`, `uv1`, `uv2` and `uv3` through seam removal and welds only vertices whose
sets all agree. Turn dynamic shadows off for lightmapped statics (`castShadow = false`, `receiveShadow = false`)
and keep one small map for the dynamics.

## Reading the section

| number | means | act with |
|---|---|---|
| `shadowTexels` above the tier budget | the maps rendered this frame are too large for the device (a frozen map counts only on frames it refreshes) | `ShadowBudget` |
| `shadowPasses` = shadow lights every frame while nothing moves | maps re-render needlessly | `ShadowBudget.freeze`, `DayNight` with `everyDegrees` |
| `point-light-shadow` hint | six faces per frame for one light | a spot light, or `ShadowBudget` on phones |
| `shadowCasters` high after `compile()` | casters are not batched (it counts objects: a batch is one) | tag statics, check the compile report |

**What each number covers.** `lights` and `shadowLights` describe the **main pass only**: the lights three projected
for it. `shadowPasses`, `shadowSubmissions`, `shadowCasters` and `shadowTexels` cover every scene of the frame, nested
scenes included. An object casting for several lights counts **once** in `shadowCasters` (a point light's six faces
count once too), and a `BatchedMesh` or `InstancedMesh` is one caster whatever it draws.

**`shadowTexels` is per frame, so the hint alternates.** A frozen or quantized map adds its texels only on the frames
it actually renders on, so with a `DayNight` stepping the map every second frame the `shadow-texels` hint and the
overlay appear on those frames and not on the others. A single-frame `inspect` therefore depends on which frame it
lands on: average over a few frames before acting on it.

Shadow pass ids are `shadow:<light name>`; lights that share a name get `shadow:<name>#1`, `#2`, …, so name lights
you want to find in `passes`. An id is not stable across frames: a light keeps the bare `shadow:lamp` only while no
other shadow-casting light of its scene shares that name, so hiding a namesake, or turning its `castShadow` off,
moves the id between `shadow:lamp` and `shadow:lamp#1`. Numbering is per scene, and an id another scene already took
moves on to the next free number: two `sun` lights in the main scene become `shadow:sun#1` and `shadow:sun#2`, while a
uniquely named `sun` in a nested scene keeps `shadow:sun`. With `VSMShadowMap`, `shadow:<id>:vsm` holds the map's two
blur quads (renderer-internal).
