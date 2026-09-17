import { type Light, type Material, type Object3D, ObjectSpaceNormalMap } from 'three';
import { hasNodeSlot, hasOwnFunctions } from '../compiler/materialCode.js';
import { isBuiltInMaterial } from '../registry/builtInMaterials.js';
import { FORGE_TAG_KEY } from '../tags.js';
import type { FrameState } from './frameState.js';
import type { HintContext } from './hints.js';
import type { DisplayNames } from './names.js';
import type { WalkedLight } from './passNames.js';
import { type LightInfo, lightInfoOf, visitLights } from './sections.js';
import { shadowPassIds } from './shadowPasses.js';

/** Layer 31 mask, where World parks batched originals. */
const HIDDEN_MASK = (1 << 31) >>> 0;

/** What the rescan's traversal finds: the hint context it fills and the js section's scene-graph statistics. */
export interface SceneScan {
  hints: Required<Omit<HintContext, 'items' | 'objects' | 'unsupportedObjects'>>;
  /** Objects under the scene (the scene object itself is not part of the count). */
  objects: number;
  autoUpdatedMatrices: number;
  hiddenOriginals: number;
}

/**
 * The full traversal behind `rescan()`: the scene-graph statistics of the js section (objects, matrices three updates
 * every frame) and the hint context the traversal alone can fill. `shadowMapsOn` is `renderer.shadowMap.enabled`: three
 * renders no shadow map with shadow maps off (ShadowNode builds none), so no point light's six faces.
 */
export function scanScene(scene: Object3D, names: DisplayNames, shadowMapsOn: boolean): SceneScan {
  let objects = 0;
  let auto = 0;
  let hidden = 0;
  const ctx: SceneScan['hints'] = {
    staticAutoUpdated: [],
    pointShadowLights: [],
    transmissive: [],
    localSpaceDraws: [],
  };
  const paths = names.forRoot(scene);
  scene.traverse((o) => {
    objects++;
    if (o.layers.mask === HIDDEN_MASK) hidden++;
    if (o.matrixAutoUpdate && o.matrixWorldAutoUpdate) {
      auto++;
      if (
        (o.userData as Record<string, unknown> | null)?.[FORGE_TAG_KEY] === 'static' &&
        (o as { isMesh?: boolean }).isMesh
      )
        ctx.staticAutoUpdated.push(names.of(o, scene, paths));
    }
    const light = o as Light & { isPointLight?: boolean };
    // Both lists name what three renders: its render lists skip a hidden subtree, lights included (Renderer.js
    // `_projectObject` returns at `visible === false`), so a light or mesh under a hidden parent costs nothing. The
    // static-auto-update list keeps hidden objects: `updateMatrixWorld` recomposes their matrices all the same.
    if (light.isLight && light.isPointLight && light.castShadow && shadowMapsOn && worldVisible(o, scene))
      ctx.pointShadowLights.push(names.of(o, scene, paths));
    const material = (o as { material?: Material | Material[] }).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      if (((m as Material & { transmission?: number }).transmission ?? 0) > 0) {
        if (worldVisible(o, scene)) ctx.transmissive.push(names.of(o, scene, paths));
        break;
      }
    }
    const reader = compiledLocalSpaceReader(o);
    if (reader && worldVisible(o, scene))
      ctx.localSpaceDraws.push({ object: names.of(o, scene, paths), material: reader.name || reader.type });
  });
  // The scene object itself is not part of the count.
  return { hints: ctx, objects: objects - 1, autoUpdatedMatrices: auto - 1, hiddenOriginals: hidden };
}

/**
 * The frame's one walk of a scene, over world-visible objects only (three's render lists skip a hidden subtree, lights
 * included). It gives every shadow-casting light's shadow camera a pass id, and keeps the main scene's lights for the
 * lighting section in case no renderObject call brings a lights node.
 */
export function walkLights(state: FrameState, scene: Object3D): void {
  const main = state.mainScene === null;
  // Scenes walked before the frame has a main scene (an outermost override render) are candidates in turn: the last one
  // walked is the one the main pass draws, so its lights replace theirs instead of adding to them.
  if (main) state.visibleLights.length = 0;
  let casting: WalkedLight[] | null = null;
  visitLights(scene, (o) => {
    const light = o as WalkedLight;
    if (main) state.visibleLights.push(light);
    if (light.castShadow && light.shadow?.camera) (casting ??= []).push(light);
  });
  if (casting === null) return;
  const lights: WalkedLight[] = casting;
  // The naming rules are `shadowPassIds` (shadowPasses.ts), which also files the ids it hands out in `passIds`.
  // Only the frame state stays here: which ids the frame has taken, and the camera each pass renders with.
  const ids = shadowPassIds(lights, state.passIds);
  for (let i = 0; i < lights.length; i++) {
    const light = lights[i]!;
    state.shadowCameras.set(light.shadow!.camera!, { light, id: ids[i]! });
  }
}

/**
 * The lights three projected for the main pass: renderObject's lights node (argument 7), filled by RenderList.finish
 * before the first draw. Read once per frame; without a `getLights()` the frame keeps the walk's world-visible lights.
 */
export function readLights(state: FrameState, lightsNode: unknown): void {
  state.lightsRead = true;
  const lights = (lightsNode as { getLights?(): Light[] } | null | undefined)?.getLights?.();
  if (!Array.isArray(lights)) return;
  // Copied now: three reuses the array for the next render of this scene and camera.
  const infos: LightInfo[] = [];
  for (let i = 0; i < lights.length; i++) infos.push(lightInfoOf(lights[i]!));
  state.lights = infos;
}

/**
 * The material of a draw `World.compile()` made (a `forge:batch:` BatchedMesh, the base level of a `forge:instanced:`
 * group, a baked mesh) when it may read mesh-local space, else null: a node in any slot (`hasNodeSlot`), code the hint
 * cannot read (a class that is not three's own, or an own function: a `setupPosition` override reads `positionLocal`
 * with no `*Node` property to see, the same test `spriteRule` and `bakeProvesReads` apply), `alphaHash`, or an
 * object-space normal map. three r186 gives such a draw `positionLocal` multiplied by its instance matrix
 * (`Batch.js:148`, `Instance.js:206-207`), the scene's space for World's draws; a node may read it in either stage
 * (`Position.js:45`) and `alphaHash` hashes it (`NodeMaterial.js:893`). An object-space normal map goes through the
 * draw's `modelNormalMatrix` (`NormalMapNode.js:120-122`, `Normal.js:183-197`), so a rotated module shades as if
 * unrotated; a tangent-space map follows the batched normal and tangent and changes nothing.
 * `test/e2e/local-space.spec.ts` measures the change on both backends. `userData` is guarded as in `reasonOf`.
 */
export function compiledLocalSpaceReader(object: Object3D): Material | null {
  const o = object as Object3D & {
    isBatchedMesh?: boolean;
    isInstancedMesh?: boolean;
    material?: Material | Material[];
  };
  const forge = o.userData?.forge as { kind?: string; lodLevel?: number } | null | undefined;
  const compiled =
    (o.isBatchedMesh === true && o.name.startsWith('forge:batch:')) ||
    (o.isInstancedMesh === true && o.name.startsWith('forge:instanced:') && (forge?.lodLevel ?? 0) === 0) ||
    forge?.kind === 'bake';
  const material = o.material;
  if (!compiled || !material || Array.isArray(material)) return null;
  const m = material as Material & { alphaHash?: boolean; normalMap?: unknown; normalMapType?: number };
  const opaqueCode = !isBuiltInMaterial(material) || hasOwnFunctions(material);
  return hasNodeSlot(material) ||
    opaqueCode ||
    m.alphaHash === true ||
    (!!m.normalMap && m.normalMapType === ObjectSpaceNormalMap)
    ? material
    : null;
}

/** Whether `object` and every ancestor up to and including `root` is visible: what three's render lists test. */
export function worldVisible(object: Object3D, root: Object3D): boolean {
  for (let current: Object3D | null = object; current !== null; current = current.parent) {
    if (!current.visible) return false;
    if (current === root) return true;
  }
  return true;
}
