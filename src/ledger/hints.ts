import type { Budgets } from './budgets.js';
import type { FrameSnapshot, Hint } from './snapshot.js';
import { capMessage, capName } from './text.js';

/** Facts the hint rules need that are not in the snapshot itself (gathered by the ledger's periodic rescan). */
export interface HintContext {
  /** Static-tagged objects that still auto-update their matrices every frame. */
  staticAutoUpdated?: string[];
  /** Visible point lights that cast shadows. */
  pointShadowLights?: string[];
  /** Meshes whose material uses transmission. */
  transmissive?: string[];
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(0)} MB`;

/** SP1 rules: what the six sections already know how to say. Later modules add their own. */
export function hintsFor(f: FrameSnapshot, b: Budgets, ctx: HintContext = {}): Hint[] {
  const hints: Hint[] = [];
  // `message` may already embed an untrusted name (e.g. a point light's), and `objects` may carry one directly
  // (ctx.pointShadowLights/transmissive/staticAutoUpdated do not pass through snapshot.ts's own capping), so
  // both are capped here, once, for every hint this function can push.
  const push = (category: Hint['category'], severity: Hint['severity'], code: string, message: string, objects: string[] = []): void => {
    hints.push({ category, severity, code, message: capMessage(message), objects: objects.map(capName) });
  };
  const t = f.totals;
  if (t.sceneSubmissions > b.sceneSubmissions) push('drawCalls', 'error', 'over-budget-submissions', `${t.sceneSubmissions} scene submissions, budget ${b.sceneSubmissions} for this tier`);
  if (t.triangles > b.triangles) push('drawCalls', 'warn', 'over-budget-triangles', `${t.triangles} triangles, budget ${b.triangles}`);
  const untagged = f.byReason.untagged;
  if (untagged) push('drawCalls', 'warn', 'untagged', `${untagged.submissions} untagged meshes: tag.static() or tag.dynamic() them`, untagged.top);
  const unique = f.byReason['unique-material'];
  if (unique && unique.submissions > 20) push('drawCalls', 'info', 'unique-materials', `${unique.submissions} meshes each with a material used once: share materials through the registry`, unique.top);
  const unsupported = f.byReason['unsupported-material'];
  if (unsupported) push('drawCalls', 'error', 'unsupported-material', `${unsupported.submissions} ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer`, unsupported.top);
  if (t.programs > 40) push('drawCalls', 'warn', 'programs', `${t.programs} shader programs: fewer material variants means fewer compiles and switches`);
  if (f.overdraw.measured && f.overdraw.transparent > b.transparentOverdraw) push('overdraw', 'warn', 'transparent-overdraw', `${f.overdraw.transparent.toFixed(2)} transparent fragments per pixel, budget ${b.transparentOverdraw}`);
  if (f.overdraw.particles > b.particles) push('overdraw', 'warn', 'particles-over-budget', `${f.overdraw.particles} particles drawn per frame, budget ${b.particles} for this tier: apply a ParticleBudget`);
  const sprites = f.byReason.sprite;
  if (sprites && sprites.submissions >= 8) push('overdraw', 'info', 'sprites-unbatched', `${sprites.submissions} sprites drawn one by one: World batches sprites that share a material (sprites: 'batch')`, sprites.top);
  if (f.skinning.vertices > b.skinnedVertices) push('skinning', 'warn', 'skinned-vertices', `${f.skinning.vertices} skinned vertices per frame, budget ${b.skinnedVertices}`);
  if (f.skinning.bones > b.bones) push('skinning', 'warn', 'bones-over-budget', `${f.skinning.bones} skeleton bones updated on the CPU every frame, budget ${b.bones} for this tier`);
  if (f.skinning.submissions >= 50) push('skinning', 'info', 'skinned-crowd', `${f.skinning.submissions} skinned draws: bake the clips to an animation texture and instance the characters (AnimatedInstances)`);
  for (const name of ctx.pointShadowLights ?? []) push('lighting', 'warn', 'point-light-shadow', `point light '${name}' renders 6 shadow faces per frame; use a spot light or freeze its map`, [name]);
  if (f.lighting.shadowTexels > b.shadowTexels) push('lighting', 'warn', 'shadow-texels', `${f.lighting.shadowTexels} shadow texels per frame, budget ${b.shadowTexels}`);
  for (const name of ctx.transmissive ?? []) push('overdraw', 'info', 'transmission', `'${name}' uses transmission: it renders in two passes and copies the frame buffer`, [name]);
  if (f.memory.textures.bytes > b.textureBytes) push('memory', 'warn', 'texture-bytes', `${mb(f.memory.textures.bytes)} of textures, budget ${mb(b.textureBytes)}: compress to KTX2 or shrink`);
  if (f.memory.geometries.bytes > b.geometryBytes) push('memory', 'warn', 'geometry-bytes', `${mb(f.memory.geometries.bytes)} of geometry, budget ${mb(b.geometryBytes)}: compress (meshopt, Draco), LOD, or stream chunks`);
  const unreferenced = f.memory.unreferenced.geometries + f.memory.unreferenced.textures;
  if (unreferenced >= 8) push('memory', 'warn', 'unreferenced-resources', `${f.memory.unreferenced.geometries} geometries and ${f.memory.unreferenced.textures} textures are still on the GPU but no longer in the scene: dispose them (ResourceTracker.release)`);
  if (f.js.objects > b.objects) push('js', 'warn', 'js-objects', `${f.js.objects} objects walked by three every frame (matrices and culling), budget ${b.objects}: batch, detach originals, flatten empty groups`);
  if (f.js.hiddenOriginals >= 1000) push('js', 'info', 'detach-originals', `${f.js.hiddenOriginals} hidden originals are still walked every frame: construct World with originals: 'detach'`);
  if (ctx.staticAutoUpdated?.length) push('js', 'info', 'static-auto-update', `${ctx.staticAutoUpdated.length} static-tagged objects still auto-update their matrices every frame`, ctx.staticAutoUpdated.slice(0, 5));
  return hints;
}
