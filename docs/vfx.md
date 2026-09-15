# VFX conventions for threeforge scenes

Overdraw is fill rate: every transparent fragment costs the same whether it is a raindrop, a smoke puff or a
health bar. The ledger measures it (`overdraw.opaque` and `overdraw.transparent` fragments per pixel,
`overdraw.particles` drawn per frame, `overdraw.pixels` in the drawing buffer) and three modules act on it.
The measured fragments ignore colour (a black or tinted effect counts like a white one), count only the texels a
cutout keeps (`alphaTest` with a `map` or `alphaMap`), and never include the background.
These conventions keep effects cheap enough for the phone tiers without changing how they look on desktop.

## What the ledger counts as a particle

- Every vertex a `Points` object draws (its `drawRange`, so a capped system counts what it draws).
- Every `Sprite`, and every instance of a sprite batch (`forge:sprites:*`).
- Mesh effects (ribbons, decals, flipbook quads) are meshes: they count in submissions and overdraw, not here.

`particles-over-budget` fires above 60 000 / 15 000 / 5 000 per frame on desktop / phone-mid / phone-low.

## Sprites: one material per effect

`World.compile()` turns sprites that share a material (by registry keys: same map, colour, opacity, blending and
flags) into one instanced billboard draw whose instances follow the originals every frame. Give each effect one
`SpriteMaterial` instance rather than one per sprite; a sprite with a non-default `center`, a `renderOrder`,
other layers or its own `onBeforeRender` stays a single draw (the compile report names the rule). Keep
`sprites: 'batch'` on; `spriteThreshold` (default 4) decides when a material is worth a batch. The 2 000
raindrops of the lake benchmark go from 3 548 submissions to 7 with 0.3 % of pixels changed.

## Points: additive, depth-write off, capped

- `blending: AdditiveBlending, depthWrite: false, transparent: true` for glows, sparks and magic: no sorting
  needed, no z-fighting, and a `ParticleBudget` can shorten the `drawRange` without visible popping.
- Smoke and dust blend normally: sort matters less at low opacity; keep them few and large rather than many
  and small, because fill cost is size × count.
- Size: `PointsMaterial.size` is in world units with `sizeAttenuation`; a `ParticleBudget` multiplies it by
  `pointSizeScale` (0.75 on `phone-low`). A point that covers a quarter of the screen costs as much as
  thousands of small ones.
- Cap: `new ParticleBudget({ tier }).apply(scene)` scales every system by one ratio so the total, single
  sprites included, fits the tier budget; `release()` restores. Spawn the budgeted count in the first place
  when you can (`budgetsFor(tier).particles`).

## Atlases and mesh effects

- Put the sprites of one effect family in one texture atlas and select frames with `spritesheetUV` or a UV
  offset: one material, one batch, one program.
- Ribbons, trails and decals are meshes with dynamic geometry (`DynamicDrawUsage`): the compiler leaves them
  alone (`excluded:dynamic-geometry`), which is right; keep their vertex counts small and their materials shared.
- Flipbook quads (`MeshBasicMaterial` with `AdditiveBlending`) are cheaper than many points for explosions.

## Soft particles

A soft particle reads the depth buffer per fragment to fade where it intersects geometry. On phones that read
costs more than the popping it hides; threeforge does not build them. Use them only for a handful of large
quads (ground fog, water contact), never for point clouds.

## Resolution

Overdraw per pixel does not change with resolution; the pixel count does. `new ResolutionScaler(renderer,
{ tier, ledger })` steps the pixel ratio down while the median frame time misses the tier's budget and back up
with headroom; `overdraw.pixels` and `env.dpr` report what it did. Scale before dropping effects: a 0.8 scale
removes 36 % of the fill cost of every layer at once.

## Reading a snapshot

| number | means | act with |
|---|---|---|
| `overdraw.transparent` above the tier budget | too many blended layers per pixel | fewer, larger particles; alphaTest cutouts for foliage; ResolutionScaler |
| `overdraw.particles` above the tier budget | too many quads drawn | ParticleBudget, smaller spawn counts |
| `byReason.sprite` at 8 or more | sprites drawn one by one | share materials so the compiler batches them |
| `overdraw.opaque` well above 1 | geometry overlapping in depth | occlusion, LOD, fewer overlapping decals |
