import { Matrix4, Sphere, type Camera, type Frustum, type Material, type Object3D, type Sprite, type SpriteMaterial } from 'three';
import type { SceneSpace } from './space.js';

/** Sprites that share a material (by registry keys, not instance) and become one instanced billboard draw. */
export interface SpriteGroup {
  /** `variantHash|colorKey`: everything the batch material copies from the first sprite's material. */
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
  /** Exact colour key (`MaterialDescription.colorKey`), not the rounded display hex: two colours under 1/255
   *  apart must group separately, since a sprite group's batch material copies just the first sprite's colour. */
  colorKey: string;
}

const OWN = Object.prototype.hasOwnProperty;

type AncestorLike = Object3D & { isGroup?: boolean; isClippingGroup?: boolean; enabled?: boolean };

/**
 * The first ancestor-scoped exclusion rule between `object` (exclusive) and `root` (inclusive), or null.
 *
 * `group-render-order`: three's `Renderer._projectObject` reassigns `groupOrder = object.renderOrder` at every
 * `isGroup` object on the way down (a plain, non-accumulating overwrite), so only the *nearest* Group ancestor's
 * `renderOrder` ever reaches the mesh — a closer Group with `renderOrder` 0 resets whatever a farther Group set, and
 * a non-Group `Object3D` in between is never read for this at all (three only assigns `groupOrder` inside the
 * `isGroup` branch). So this only looks at the first `isGroup` ancestor found, whatever its value, and stops there.
 *
 * `clipping-group`: an enabled `isClippingGroup` ancestor builds its `ClippingContext` from its *parent* context
 * (`getGroupContext` does `new ClippingContext(this)`), so clipping planes chain down through every enabled
 * `ClippingGroup` in the chain, not just the nearest — this keeps checking every ancestor up to `root`.
 *
 * Shared by `exclusionRule` and `spriteRule` so there is one ancestor walker, not one per rule.
 */
export function ancestorExclusionRule(object: Object3D, root: Object3D): string | null {
  let current: Object3D | null = object.parent;
  let nearestGroupSeen = false;
  while (current) {
    const node = current as AncestorLike;
    if (!nearestGroupSeen && node.isGroup) {
      nearestGroupSeen = true;
      if (node.renderOrder !== 0) return 'group-render-order';
    }
    if (node.isClippingGroup && node.enabled) return 'clipping-group';
    if (current === root) break;
    current = current.parent;
  }
  return null;
}

/**
 * A node material with any node slot set. three r186's `NodeMaterial` declares its slots as `*Node` instance properties
 * (`NodeMaterial.js` ~103-390: `lightsNode`, `envNode`, `aoNode`, `colorNode`, `normalNode`, `opacityNode`,
 * `backdropNode`, `backdropAlphaNode`, `alphaTestNode`, `maskNode`, `maskShadowNode`, `positionNode`, `geometryNode`,
 * `depthNode`, `receivedShadowPositionNode`, `castShadowPositionNode`, `receivedShadowNode`, `castShadowNode`,
 * `outputNode`, `mrtNode`, `fragmentNode`, `vertexNode`, `contextNode`); `SpriteNodeMaterial` adds `rotationNode` and
 * `scaleNode` (`SpriteNodeMaterial.js` ~63-86). Every own property ending in `Node` is read, so a subclass's slots count.
 */
function hasNodeSlot(material: Material): boolean {
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial !== true) return false;
  for (const key of Object.keys(material)) {
    if (!key.endsWith('Node')) continue;
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value !== null && value !== undefined) return true;
  }
  return false;
}

/**
 * Why a sprite cannot join a batch, or null. Visibility is not a rule: the per-frame fill collapses hidden sprites.
 * `root` scopes `group-render-order` and `clipping-group` (ancestor-based); omit it to skip those two checks.
 *
 * `sprite-node-material`: the batch replaces a node material's position and scale nodes with its instance attributes,
 * clears its vertex node, and any node reading the object (`modelWorldMatrix`, `positionWorld`) would read the batch mesh.
 * `sprite-count`: three draws `count` instances of a sprite (`RenderObject.getDrawParameters`, `object.count`), while a
 * batch draws one quad per sprite.
 */
export function spriteRule(sprite: Sprite, root?: Object3D): string | null {
  const material = sprite.material as SpriteMaterial | SpriteMaterial[];
  if (Array.isArray(material)) return 'multi-material';
  if (material.visible === false) return 'material-invisible';
  if (hasNodeSlot(material)) return 'sprite-node-material';
  if (sprite.count !== 1) return 'sprite-count';
  if (sprite.center.x !== 0.5 || sprite.center.y !== 0.5) return 'sprite-center';
  if (sprite.layers.mask !== 1) return 'layers';
  if (sprite.renderOrder !== 0) return 'render-order';
  if (root) {
    const ancestor = ancestorExclusionRule(sprite, root);
    if (ancestor) return ancestor;
  }
  if (OWN.call(sprite, 'onBeforeRender') || OWN.call(sprite, 'onAfterRender')) return 'custom-hook';
  return null;
}

/** Groups sprites by material keys; groups under `threshold` are skipped with `sprite-threshold`. Order is first-seen. */
export function groupSprites(sprites: Sprite[], threshold: number, describe: (material: Material) => SpriteKeys, root?: Object3D): { groups: SpriteGroup[]; skipped: SpriteSkip[] } {
  const byKey = new Map<string, SpriteGroup>();
  const skipped: SpriteSkip[] = [];
  for (const sprite of sprites) {
    const rule = spriteRule(sprite, root);
    if (rule) {
      skipped.push({ sprite, rule });
      continue;
    }
    const material = sprite.material;
    const keys = describe(material);
    const key = `${keys.variantHash}|${keys.colorKey}`;
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
  /**
   * The space the batch draws in, its parent's (`World`: the scene). Centres and scales are written relative to it, so
   * the batch's world matrix puts each instance where its sprite is. Without it they are world positions and scales.
   */
  space?: SceneSpace | null;
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
 * Copies every sprite's position and scale, in `space` when given, into the instanced attributes (an invisible sprite gets scale 0),
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
  // Culling and sorting above are in world space, like the camera; the instances are written in the batch's space.
  const space = options.space ?? null;
  const inverse = space !== null && !space.update() ? space.inverse.elements : null;
  const scaleX = inverse === null ? 1 : space!.scaleX;
  const scaleY = inverse === null ? 1 : space!.scaleY;
  let written = 0;
  for (let k = start; k < start + limit; k++) {
    const sprite = sprites[order[k]!]!;
    const m = sprite.matrixWorld.elements;
    const o = written * 3;
    if (inverse === null) {
      centers[o] = m[12]!;
      centers[o + 1] = m[13]!;
      centers[o + 2] = m[14]!;
    } else {
      const x = m[12]!;
      const y = m[13]!;
      const z = m[14]!;
      centers[o] = inverse[0]! * x + inverse[4]! * y + inverse[8]! * z + inverse[12]!;
      centers[o + 1] = inverse[1]! * x + inverse[5]! * y + inverse[9]! * z + inverse[13]!;
      centers[o + 2] = inverse[2]! * x + inverse[6]! * y + inverse[10]! * z + inverse[14]!;
    }
    const s = written * 2;
    if (isVisibleInGraph(sprite, options.root)) {
      // three scales a sprite quad by its model matrix's column lengths: the batch's (the space's) times these.
      scales[s] = Math.hypot(m[0]!, m[1]!, m[2]!) / scaleX;
      scales[s + 1] = Math.hypot(m[4]!, m[5]!, m[6]!) / scaleY;
    } else {
      scales[s] = 0;
      scales[s + 1] = 0;
    }
    written++;
  }
  return written;
}
