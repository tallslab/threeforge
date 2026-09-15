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
| `shadowTexels` above the tier budget | maps too large for the device | `ShadowBudget` |
| `shadowPasses` = shadow lights every frame while nothing moves | maps re-render needlessly | `ShadowBudget.freeze`, `DayNight` with `everyDegrees` |
| `point-light-shadow` hint | six faces per frame for one light | a spot light, or `ShadowBudget` on phones |
| `shadowCasters` high after `compile()` | casters are not batched | tag statics, check the compile report |
