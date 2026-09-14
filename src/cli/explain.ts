import type { HintCategory } from '../ledger/snapshot.js';

export interface Remedy {
  code: string;
  category: HintCategory;
  severity: 'info' | 'warn' | 'error';
  /** What the hint means. */
  meaning: string;
  /** What to change, imperative and concrete. */
  fix: string;
  /** The threeforge or three.js API to reach for. */
  api: string;
  /** Where to read more in the repository. */
  docs: string;
}

const remedy = (code: string, category: HintCategory, severity: Remedy['severity'], meaning: string, fix: string, api: string, docs = 'README.md'): [string, Remedy] => [code, { code, category, severity, meaning, fix, api, docs }];

/** One entry per hint code `hintsFor` can emit (a unit test enforces the match). */
export const REMEDIES: Record<string, Remedy> = Object.fromEntries([
  remedy('over-budget-submissions', 'drawCalls', 'error', 'The frame issues more scene submissions (render items) than the device tier can afford.', 'Tag static meshes with tag.static() and run world.compile() so they batch; lower instanceThreshold so repeated geometry instances; use fewer shadow-casting lights (each is one more pass over the casters).', 'tag.static(), new World(scene, { instanceThreshold }).compile()', 'README.md#what-the-numbers-mean'),
  remedy('over-budget-triangles', 'drawCalls', 'warn', 'More triangles are rasterised per frame than the tier budget.', 'Generate LODs with prepareLods() and pass lod distances to World so distant batches draw simplified geometry; simplify heavy assets at build time; make sure per-instance culling is on (culling: "bvh").', 'prepareLods(scene, { ratios }), new World(scene, { lod: { distances } })'),
  remedy('untagged', 'drawCalls', 'warn', 'Meshes without a forge tag are left alone by the compiler and drawn one by one.', 'Call tag.static(mesh) on everything that never moves and tag.dynamic(mesh) on the rest, or construct World with policy: "auto" to batch untagged plain meshes.', 'tag.static(), tag.dynamic(), new World(scene, { policy: "auto" })'),
  remedy('unique-materials', 'drawCalls', 'info', 'Many meshes carry a material instance used by nothing else, so nothing can share a batch or a program.', 'Create one material per surface type and share it, or pass every material through registry.register() and use the canonical it returns; identical materials then merge.', 'registry.register(material), registry.stats().byProgram'),
  remedy('unsupported-material', 'drawCalls', 'error', 'ShaderMaterial and RawShaderMaterial do not render on WebGPURenderer at all.', 'Rewrite the effect with three shading language (TSL) on a NodeMaterial, or use a built-in material with node overrides.', 'MeshStandardNodeMaterial, three/tsl'),
  remedy('programs', 'drawCalls', 'warn', 'Many distinct shader programs: every variant costs a compile and every switch costs GPU state changes.', 'Reduce material variants: same map slots, same flags (side, transparent, alphaTest, vertexColors) across materials of a kind; colour differences are free, flag differences are not.', 'registry.stats().byProgram, registry.describe(material)'),
  remedy('transparent-overdraw', 'overdraw', 'warn', 'Transparent fragments per pixel exceed the tier budget: fill rate, not draw calls, is the cost.', 'Use alphaTest cutouts instead of blending for foliage and fences, cap particles with ParticleBudget, batch sprites (World\'s default sprites: "batch"), shrink billboard sizes, and scale the drawing buffer with ResolutionScaler on low tiers.', 'material.alphaTest, ParticleBudget, ResolutionScaler, ledger.measureOverdraw()'),
  remedy('particles-over-budget', 'overdraw', 'warn', 'More particles (points vertices, sprites and sprite-batch instances) are drawn per frame than the tier budget; each is a transparent quad that costs fill rate.', 'Apply new ParticleBudget({ tier }).apply(scene) so every system\'s drawRange scales down to the budget, spawn fewer particles on phones, and shrink point sizes (pointSizeScale).', 'new ParticleBudget({ tier, particles, pointSizeScale }).apply(scene), geometry.setDrawRange()'),
  remedy('sprites-unbatched', 'overdraw', 'info', 'Many Sprite objects are drawn one submission each although they share a material.', 'Keep World\'s sprites: "batch" (the default) so sprites sharing a material become one instanced billboard draw synced every frame; give each effect one SpriteMaterial instead of one per sprite.', 'new World(scene, { sprites: "batch", spriteThreshold })'),
  remedy('skinned-vertices', 'skinning', 'warn', 'Skinned vertices per frame exceed the tier budget; each is skinned by the GPU every frame.', 'Merge gear onto one skeleton with assembleCharacter(), use lower-poly rigs for background characters, keep fewer skinned meshes on screen; crowds will instance through baked animation textures.', 'assembleCharacter({ skeleton, wardrobe, equipped })'),
  remedy('point-light-shadow', 'lighting', 'warn', 'A shadow-casting point light renders six shadow faces every frame.', 'Replace it with a spot light (one face), or freeze its shadow map with light.shadow.autoUpdate = false and set needsUpdate = true only when casters move.', 'SpotLight, light.shadow.autoUpdate, light.shadow.needsUpdate'),
  remedy('shadow-texels', 'lighting', 'warn', 'Shadow-map texels rendered per frame exceed the tier budget.', 'Lower light.shadow.mapSize, cast shadows from fewer lights, freeze static shadow maps, and turn shadows off on the low tier.', 'light.shadow.mapSize, light.castShadow, renderer.shadowMap.enabled'),
  remedy('transmission', 'overdraw', 'info', 'A transmissive material renders in two passes and copies the frame buffer for refraction.', 'Keep transmission for a few hero objects, set forceSinglePass when the object is not double sided, and fake distant glass with opacity.', 'material.transmission, material.forceSinglePass'),
  remedy('texture-bytes', 'memory', 'warn', 'Estimated texture memory exceeds the tier budget.', 'Compress textures to KTX2 (toktx or gltf-transform), cap sizes per tier, share atlases, and drop mipmaps only for UI textures.', 'KTX2Loader.detectSupportAsync(renderer), gltf-transform etc'),
  remedy('static-auto-update', 'js', 'info', 'Static-tagged objects still recompute their world matrices every frame.', 'After placing a static object set matrixAutoUpdate = false (and matrixWorldAutoUpdate = false on whole static subtrees); update matrices manually when something does move.', 'object.matrixAutoUpdate, object.updateMatrix()'),
]);

export function explain(code: string): Remedy | null {
  return REMEDIES[code] ?? null;
}
