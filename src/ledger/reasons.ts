import { DoubleSide, type Material, type Object3D } from 'three';
import { tag, type ForgeTag } from '../tags.js';

/** Why a submission exists. One primary reason per submission; `excluded:<rule>` comes from the compiler. */
export type Reason =
  | 'batched'
  | 'baked'
  | 'sprite-batch'
  | 'vat-instanced'
  | 'instanced'
  | 'unique-material'
  | 'dynamic'
  | 'skinned'
  | 'morph'
  | 'transparent'
  | 'multi-material-group'
  | 'untagged'
  | 'unsupported-material'
  | 'renderer-internal'
  | 'fullscreen-pass'
  | 'occlusion-proxy'
  | 'points'
  | 'sprite'
  | 'line'
  | 'unclassified'
  | `excluded:${string}`;

export type Flag = 'shadow-caster' | 'double-sided-transparent' | 'custom-hook' | 'render-order' | 'layers' | 'transparent';

export type SubmissionKind = 'mesh' | 'batched' | 'instanced' | 'skinned' | 'sprite' | 'line' | 'points' | 'other';

type Flags = Object3D & {
  isMesh?: boolean;
  isBatchedMesh?: boolean;
  isInstancedMesh?: boolean;
  isSkinnedMesh?: boolean;
  isSprite?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  morphTargetInfluences?: number[];
  material?: Material | Material[];
};

export function kindOf(object: Object3D): SubmissionKind {
  const o = object as Flags;
  if (o.isBatchedMesh) return 'batched';
  if (o.isInstancedMesh) return 'instanced';
  if (o.isSkinnedMesh) return 'skinned';
  if (o.isMesh) return 'mesh';
  if (o.isSprite) return 'sprite';
  if (o.isLine) return 'line';
  if (o.isPoints) return 'points';
  return 'other';
}

/** The object's own tag, or the nearest ancestor's. */
export function effectiveTag(object: Object3D): ForgeTag | undefined {
  let current: Object3D | null = object;
  while (current) {
    const t = tag.of(current);
    if (t) return t;
    current = current.parent;
  }
  return undefined;
}

export function isDescendantOf(object: Object3D, root: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

export function isDoubleSidedTransparent(material: Material): boolean {
  return material.transparent && material.side === DoubleSide && !material.forceSinglePass;
}

const OWN = Object.prototype.hasOwnProperty;
const FORGE_HOOK = Symbol.for('threeforge.hook');

function isUserHook(object: Object3D, name: 'onBeforeRender' | 'onAfterRender'): boolean {
  if (!OWN.call(object, name)) return false;
  const fn = object[name] as unknown as Record<symbol, unknown>;
  return fn[FORGE_HOOK] !== true;
}

export function flagsOf(object: Object3D, material: Material): Flag[] {
  return flagsInto(object, material, []);
}

/** `flagsOf`, pushed onto `flags` (the ledger reuses one array per pooled record). */
export function flagsInto(object: Object3D, material: Material, flags: Flag[]): Flag[] {
  if (object.castShadow) flags.push('shadow-caster');
  if (isDoubleSidedTransparent(material)) flags.push('double-sided-transparent');
  // Own-property hooks are user-installed; BatchedMesh defines its own on the prototype and threeforge marks its hooks.
  if (isUserHook(object, 'onBeforeRender') || isUserHook(object, 'onAfterRender')) flags.push('custom-hook');
  if (object.renderOrder !== 0) flags.push('render-order');
  if (object.layers.mask !== 1) flags.push('layers');
  if (material.transparent) flags.push('transparent');
  return flags;
}

/**
 * One primary reason per submission. A single walk up the ancestors answers both questions that need them: whether
 * `root` is among them (`isDescendantOf`) and the nearest tag (`effectiveTag`, which may sit above the root).
 */
export function reasonOf(object: Object3D, material: Material, group: unknown, root: Object3D, unsupported: boolean, annotation: Reason | undefined): Reason {
  const o = object as Flags;
  let underRoot = false;
  let nearestTag: ForgeTag | undefined;
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (current === root) underRoot = true;
    if (nearestTag === undefined) nearestTag = tag.of(current);
    if (underRoot && nearestTag !== undefined) break;
  }
  if (!underRoot) return 'renderer-internal';
  if ((root as { isScene?: boolean }).isScene !== true) return 'fullscreen-pass';
  const forgeKind = (object.userData.forge as { kind?: string } | undefined)?.kind;
  if (forgeKind === 'occlusion-proxy') return 'occlusion-proxy';
  if (forgeKind === 'bake') return 'baked';
  if (forgeKind === 'sprites') return 'sprite-batch';
  if (forgeKind === 'vat') return 'vat-instanced';
  if (o.isPoints) return 'points';
  if (o.isSprite) return 'sprite';
  if (o.isLine) return 'line';
  if (o.isBatchedMesh) return 'batched';
  if (o.isInstancedMesh) return 'instanced';
  if (o.isSkinnedMesh) return 'skinned';
  if (o.morphTargetInfluences && o.morphTargetInfluences.length > 0) return 'morph';
  if (unsupported) return 'unsupported-material';
  if (group !== null || Array.isArray(o.material)) return 'multi-material-group';
  if (annotation) return annotation;
  if (nearestTag === 'dynamic') return 'dynamic';
  if (material.transparent) return 'transparent';
  if (nearestTag === 'static') return 'unique-material';
  if (nearestTag === undefined) return 'untagged';
  return 'unclassified';
}

/**
 * `name`, or a path of ancestor names with `Type[index]` for unnamed nodes; the root is implied. The ledger names
 * submissions through `DisplayNames` (`names.ts`), a cache that returns exactly this string.
 */
export function displayName(object: Object3D, root: Object3D | null): string {
  if (object.name) return object.name;
  const parts: string[] = [];
  let current: Object3D | null = object;
  while (current && current !== root) {
    const parent: Object3D | null = current.parent;
    parts.unshift(current.name || `${current.type}[${parent ? parent.children.indexOf(current) : 0}]`);
    current = parent;
  }
  return parts.join('/');
}
