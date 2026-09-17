import type { Material, Object3D } from 'three';
import { FORGE_HOOK_KEY } from '../compiler/materialCode.js';
import { FORGE_TAG_KEY, type ForgeTag, tag } from '../tags.js';

/**
 * Why a submission exists. One primary reason per submission; `excluded:<rule>` comes from the compiler. `reasonOf` gives
 * a static drawn alone `unique-material`; the ledger relabels it `static-unbatched` at the end of any frame in which
 * another object of the main pass draws the same canonical material.
 */
export type Reason =
  | 'batched'
  | 'baked'
  | 'sprite-batch'
  | 'vat-instanced'
  | 'instanced'
  | 'unique-material'
  | 'static-unbatched'
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

export type Flag =
  | 'shadow-caster'
  | 'double-sided-transparent'
  | 'custom-hook'
  | 'render-order'
  | 'layers'
  | 'transparent';

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

const OWN = Object.prototype.hasOwnProperty;
/** The same symbol as culling.ts's `FORGE_HOOK`, made here so the ledger does not import the compiler's culling module. */
const FORGE_HOOK = Symbol.for(FORGE_HOOK_KEY);

function isUserHook(object: Object3D, name: 'onBeforeRender' | 'onAfterRender'): boolean {
  if (!OWN.call(object, name)) return false;
  const fn = object[name] as unknown as Record<symbol, unknown>;
  return fn[FORGE_HOOK] !== true;
}

/**
 * The flags of one submission, written over `flags` in place (the ledger reuses one array per pooled record): an element
 * is written only where it differs and `length` only when it changes. V8 releases an array's backing store when its
 * length is set to 0, so emptying a record's array and pushing its flags again allocated a new store for every flagged
 * submission of every frame, most of the ledger's per-submission allocation. `sides` is the pass's draws per call
 * (`sideFactor()` in expectedDraws.ts), so `double-sided-transparent` follows the material three draws in that pass.
 */
export function flagsInto(object: Object3D, material: Material, sides: number, flags: Flag[]): Flag[] {
  let n = 0;
  if (object.castShadow) n = putFlag(flags, n, 'shadow-caster');
  if (sides === 2) n = putFlag(flags, n, 'double-sided-transparent');
  // Own-property hooks are user-installed; BatchedMesh defines its own on the prototype and threeforge marks its hooks.
  if (isUserHook(object, 'onBeforeRender') || isUserHook(object, 'onAfterRender')) n = putFlag(flags, n, 'custom-hook');
  if (object.renderOrder !== 0) n = putFlag(flags, n, 'render-order');
  if (object.layers.mask !== 1) n = putFlag(flags, n, 'layers');
  if (material.transparent) n = putFlag(flags, n, 'transparent');
  if (flags.length !== n) flags.length = n;
  return flags;
}

/** Writes `flag` at index `n` of `flags` unless it is already there (appending at the end); returns `n + 1`. */
function putFlag(flags: Flag[], n: number, flag: Flag): number {
  if (n === flags.length) flags.push(flag);
  else if (flags[n] !== flag) flags[n] = flag;
  return n + 1;
}

/** The materials three r186's ShadowNode.vsmPass blurs a VSM shadow map with (ShadowNode.js, `material.name`). */
const VSM_BLUR_MATERIALS = new Set(['VSMVertical', 'VSMHorizontal']);

/** A VSM blur quad: the QuadMesh three renders with a `VSMVertical` or `VSMHorizontal` material right after a VSM shadow map. */
export function isVsmBlur(object: Object3D): boolean {
  const quad = object as Object3D & { isQuadMesh?: boolean; material?: Material | Material[] };
  const material = quad.material;
  return (
    quad.isQuadMesh === true &&
    material !== undefined &&
    !Array.isArray(material) &&
    VSM_BLUR_MATERIALS.has(material.name)
  );
}

/**
 * One primary reason per submission. A single walk up the ancestors answers both questions that need them: whether
 * `root` is among them and the nearest tag (as `effectiveTag` reads it, which may sit above the root).
 *
 * Both reads of `userData` here — the walk's tag, read off it rather than through `tag.of`, and the drawn object's own
 * `forge` kind — are guarded: three fills `userData` on its own constructors, but app code and non-three loaders
 * assign null and `Object3D.copy` propagates it to every clone, and three renders such a scene without complaint, so
 * neither read may throw on the per-submission path.
 */
export function reasonOf(
  object: Object3D,
  material: Material,
  group: unknown,
  root: Object3D,
  unsupported: boolean,
  annotation: Reason | undefined,
): Reason {
  const o = object as Flags;
  let underRoot = false;
  let nearestTag: ForgeTag | undefined;
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (current === root) underRoot = true;
    if (nearestTag === undefined) {
      const value: unknown = current.userData?.[FORGE_TAG_KEY];
      if (value === 'static' || value === 'dynamic') nearestTag = value;
    }
    if (underRoot && nearestTag !== undefined) break;
  }
  if (!underRoot) return 'renderer-internal';
  if ((root as { isScene?: boolean }).isScene !== true)
    return isVsmBlur(object) ? 'renderer-internal' : 'fullscreen-pass';
  const forgeKind = (object.userData?.forge as { kind?: string } | undefined)?.kind;
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
