import type { Camera, Material, Object3D, Sprite, SpriteMaterial } from 'three';

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
}

let order: Uint32Array = new Uint32Array(0);
let depths: Float32Array = new Float32Array(0);

/**
 * Copies every sprite's world position and scale into the instanced attributes (an invisible sprite gets scale 0),
 * optionally sorted back to front for `camera`, capped to `cap`. Returns the instance count written.
 */
export function fillSpriteInstances(sprites: Sprite[], centers: Float32Array, scales: Float32Array, options: SpriteFillOptions): number {
  const n = sprites.length;
  const limit = Math.max(0, Math.min(n, Number.isFinite(options.cap) ? Math.floor(options.cap) : n));
  if (order.length < n) {
    order = new Uint32Array(n);
    depths = new Float32Array(n);
  }
  for (let i = 0; i < n; i++) order[i] = i;
  let start = 0;
  if (options.sorted && options.camera) {
    const e = options.camera.matrixWorldInverse.elements;
    for (let i = 0; i < n; i++) {
      const m = sprites[i]!.matrixWorld.elements;
      // View-space z of the sprite's origin: more negative is farther from the camera.
      depths[i] = e[2]! * m[12]! + e[6]! * m[13]! + e[10]! * m[14]! + e[14]!;
    }
    const view = order.subarray(0, n);
    view.sort((a, b) => depths[a]! - depths[b]!);
    // Farthest first; a cap keeps the nearest, which sit at the end of the sorted run.
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
