import type { Budgets } from './budgets.js';
import type { Reason } from './reasons.js';
import type { FrameSnapshot, Hint } from './snapshot.js';
import { capMessage, capName } from './text.js';

/** The fields a hint rule can read off a draw-call item (a subset of `SubmissionRecord`). */
export interface HintItem {
  name: string;
  pass: string;
  reason: Reason;
  transparent: boolean;
}

/** Facts the hint rules need that are not in the snapshot itself (gathered by the ledger's periodic rescan). */
export interface HintContext {
  /** Static-tagged objects that still auto-update their matrices every frame. */
  staticAutoUpdated?: string[];
  /** Visible point lights that cast shadows. */
  pointShadowLights?: string[];
  /** Meshes whose material uses transmission. */
  transmissive?: string[];
  /** This frame's draw-call items, for rules that need per-submission detail (main-pass transparency ordering). */
  items?: HintItem[];
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
  // The statics `unique-materials` used to count although another draw shares their material: the same threshold.
  const unbatched = f.byReason['static-unbatched'];
  if (unbatched && unbatched.submissions > 20) push('drawCalls', 'info', 'static-unbatched', `${unbatched.submissions} static meshes draw one by one although other draws share their material: batch them with World`, unbatched.top);
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
  const shadowLights = ctx.pointShadowLights ?? [];
  // One hint per code, not one per object: both this and transmissive scale with the scene (every visible
  // shadow-casting point light, every transmissive mesh), and a large scene used to mean a large number of
  // near-identical hints — and, before sanitizeDeep's array-cap fix, risked the (+N more) string marker landing
  // in an array the JSON schema requires to be Hint objects. The message states the true count; objects holds
  // only the first 5 names (capped as every other hint's objects already are, via push()).
  if (shadowLights.length > 0) {
    const n = shadowLights.length;
    const message = n === 1 ? `1 point light renders 6 shadow faces per frame: use a spot light or freeze its map` : `${n} point lights render 6 shadow faces per frame: use spot lights or freeze their maps`;
    push('lighting', 'warn', 'point-light-shadow', message, shadowLights.slice(0, 5));
  }
  if (f.lighting.shadowTexels > b.shadowTexels) push('lighting', 'warn', 'shadow-texels', `${f.lighting.shadowTexels} shadow texels per frame, budget ${b.shadowTexels}`);
  const transmissive = ctx.transmissive ?? [];
  if (transmissive.length > 0) {
    const n = transmissive.length;
    const message = n === 1 ? `1 mesh uses transmission: it renders in two passes and copies the frame buffer` : `${n} meshes use transmission: they render in two passes and copy the frame buffer`;
    push('overdraw', 'info', 'transmission', message, transmissive.slice(0, 5));
  }
  if (f.memory.textures.bytes > b.textureBytes) push('memory', 'warn', 'texture-bytes', `${mb(f.memory.textures.bytes)} of textures, budget ${mb(b.textureBytes)}: compress to KTX2 or shrink`);
  if (f.memory.geometries.bytes > b.geometryBytes) push('memory', 'warn', 'geometry-bytes', `${mb(f.memory.geometries.bytes)} of geometry, budget ${mb(b.geometryBytes)}: compress (meshopt, Draco), LOD, or stream chunks`);
  const unreferenced = f.memory.unreferenced.geometries + f.memory.unreferenced.textures;
  if (unreferenced >= 8) push('memory', 'warn', 'unreferenced-resources', `${f.memory.unreferenced.geometries} geometries and ${f.memory.unreferenced.textures} textures are still on the GPU but no longer in the scene: dispose them (ResourceTracker.release)`);
  if (f.js.objects > b.objects) push('js', 'warn', 'js-objects', `${f.js.objects} objects walked by three every frame (matrices and culling), budget ${b.objects}: batch, detach originals, flatten empty groups`);
  if (f.js.hiddenOriginals >= 1000) push('js', 'info', 'detach-originals', `${f.js.hiddenOriginals} hidden originals are still walked every frame: construct World with originals: 'detach'`);
  if (ctx.staticAutoUpdated?.length) push('js', 'info', 'static-auto-update', `${ctx.staticAutoUpdated.length} static-tagged objects still auto-update their matrices every frame`, ctx.staticAutoUpdated.slice(0, 5));
  // One pass over the frame's items, copying only the names of threeforge's transparent batches.
  let mainTransparent = 0;
  const names: string[] = [];
  for (const i of ctx.items ?? []) {
    if (i.pass !== 'main' || !i.transparent) continue;
    mainTransparent++;
    if (i.reason === 'batched' && i.name.startsWith('forge:batch:')) names.push(i.name);
  }
  // A batch "shares the pass with other transparent submissions" whenever the main pass has more than one
  // transparent item and at least one of them is a threeforge batch (two threeforge batches alone still qualify:
  // each is the other's "other transparent submission").
  if (names.length > 0 && mainTransparent > 1) {
    const n = names.length;
    const message =
      n === 1
        ? `1 threeforge transparent batch shares the main pass with other transparent draws: three sorts a BatchedMesh by its own centre, not per instance, so draw order across them is approximate`
        : `${n} threeforge transparent batches share the main pass with other transparent draws: three sorts each BatchedMesh by its own centre, not per instance, so draw order across them is approximate`;
    push('overdraw', 'info', 'transparent-batch-order', `${message} — use transparent: 'keep' if exact per-object order matters here`, names.slice(0, 5));
  }
  return hints;
}
