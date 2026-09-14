import { Matrix4, Sphere, type Camera, type Frustum, type Material, type Object3D, type Sprite, type SpriteMaterial } from 'three';

/** Sprites that share a material (by registry keys, not instance) and become one instanced billboard draw. */
export interface SpriteGroup {
  /** `variantHash|colorHex`: everything the batch material copies from the first sprite's material. */
  key: string;
  programHash: string;
  material: SpriteMaterial;
  sprites: Sprite[];
}

export interface SpriteSkip {
  sprite: Sprite;
  rule: string;
}

export interface SpriteKeys {
  programHash: string;
  variantHash: string;
  colorHex: string;
}

const OWN = Object.prototype.hasOwnProperty;

/** Why a sprite cannot join a batch, or null. Visibility is not a rule: the per-frame fill collapses hidden sprites. */
export function spriteRule(sprite: Sprite): string | null {
  if (Array.isArray(sprite.material)) return 'multi-material';
  if (sprite.center.x !== 0.5 || sprite.center.y !== 0.5) return 'sprite-center';
  if (sprite.layers.mask !== 1) return 'layers';
  if (sprite.renderOrder !== 0) return 'render-order';
  if (OWN.call(sprite, 'onBeforeRender') || OWN.call(sprite, 'onAfterRender')) return 'custom-hook';
  return null;
}

/** Groups sprites by material keys; groups under `threshold` are skipped with `sprite-threshold`. Order is first-seen. */
export function groupSprites(sprites: Sprite[], threshold: number, describe: (material: Material) => SpriteKeys): { groups: SpriteGroup[]; skipped: SpriteSkip[] } {
  const byKey = new Map<string, SpriteGroup>();
  const skipped: SpriteSkip[] = [];
  for (const sprite of sprites) {
    const rule = spriteRule(sprite);
    if (rule) {
      skipped.push({ sprite, rule });
      continue;
    }
    const material = sprite.material;
    const keys = describe(material);
    const key = `${keys.variantHash}|${keys.colorHex}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, programHash: keys.programHash, material, sprites: [] };
      byKey.set(key, group);
    }
    group.sprites.push(sprite);
  }
  const groups: SpriteGroup[] = [];
  for (const group of byKey.values()) {
    if (group.sprites.length >= threshold) groups.push(group);
    else for (const sprite of group.sprites) skipped.push({ sprite, rule: 'sprite-threshold' });
  }
  return { groups, skipped };
}

/** `object.visible` and every ancestor's up to (and including) `root`. */
export function isVisibleInGraph(object: Object3D, root: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return true;
}

export interface SpriteFillOptions {
  /** The camera to sort for (view depth); null when unsorted. */
  camera: Camera | null;
  /** Back-to-front order, what three does for blended sprites. */
  sorted: boolean;
  /** Keep at most this many instances: the nearest when sorted, the first otherwise (ParticleBudget). */
  cap: number;
  /** Visibility is resolved up to this root (the scene). */
  root: Object3D;
  /**
   * When given, instances whose bounding sphere lies outside the frustum's four side planes are left out (what
   * three does per sprite). Near and far planes are ignored on purpose: a reflector's virtual camera carries an
   * oblique projection whose near plane is the mirror, and the far plane never decides a sprite.
   */
  frustum: Frustum | null;
}

let order: Uint32Array = new Uint32Array(0);
let depths: Float32Array = new Float32Array(0);
const _sphere = new Sphere();
const _projScreen = new Matrix4();
/** Half the diagonal of the unit quad: a sprite's bounding-sphere radius per unit of scale. */
const QUAD_RADIUS = Math.SQRT1_2;

/** The frustum's planes 0–3 are right, left, bottom and top (setFromProjectionMatrix order); 4 and 5 are far and near. */
function insideSidePlanes(frustum: Frustum, sphere: Sphere): boolean {
  const planes = frustum.planes;
  for (let i = 0; i < 4; i++) if (planes[i]!.distanceToPoint(sphere.center) < -sphere.radius) return false;
  return true;
}

/**
 * Copies every sprite's world position and scale into the instanced attributes (an invisible sprite gets scale 0),
 * culled against `frustum` when given, optionally sorted back to front for `camera`, capped to `cap`. Returns the
 * instance count written.
 */
export function fillSpriteInstances(sprites: Sprite[], centers: Float32Array, scales: Float32Array, options: SpriteFillOptions): number {
  const total = sprites.length;
  if (order.length < total) {
    order = new Uint32Array(total);
    depths = new Float32Array(total);
  }
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (options.frustum) {
      const m = sprites[i]!.matrixWorld.elements;
      _sphere.center.set(m[12]!, m[13]!, m[14]!);
      _sphere.radius = QUAD_RADIUS * Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!));
      if (!insideSidePlanes(options.frustum, _sphere)) continue;
    }
    order[n++] = i;
  }
  const limit = Math.max(0, Math.min(n, Number.isFinite(options.cap) ? Math.floor(options.cap) : n));
  let start = 0;
  if (options.sorted && options.camera) {
    // Depth the way three sorts transparent objects: clip-space z after the perspective divide. Under a
    // reflector's oblique projection this order differs from view-space z, and matching it keeps the pixels.
    const e = _projScreen.multiplyMatrices(options.camera.projectionMatrix, options.camera.matrixWorldInverse).elements;
    for (let k = 0; k < n; k++) {
      const m = sprites[order[k]!]!.matrixWorld.elements;
      const x = m[12]!;
      const y = m[13]!;
      const z = m[14]!;
      const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
      depths[order[k]!] = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) / (w === 0 ? 1e-9 : w);
    }
    const view = order.subarray(0, n);
    // Larger projected depth is farther: farthest first; a cap keeps the nearest, at the end of the sorted run.
    view.sort((a, b) => depths[b]! - depths[a]!);
    start = n - limit;
  }
  let written = 0;
  for (let k = start; k < start + limit; k++) {
    const sprite = sprites[order[k]!]!;
    const m = sprite.matrixWorld.elements;
    const o = written * 3;
    centers[o] = m[12]!;
    centers[o + 1] = m[13]!;
    centers[o + 2] = m[14]!;
    const s = written * 2;
    if (isVisibleInGraph(sprite, options.root)) {
      scales[s] = Math.hypot(m[0]!, m[1]!, m[2]!);
      scales[s + 1] = Math.hypot(m[4]!, m[5]!, m[6]!);
    } else {
      scales[s] = 0;
      scales[s + 1] = 0;
    }
    written++;
  }
  return written;
}
