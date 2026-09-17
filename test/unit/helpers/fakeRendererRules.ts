/**
 * Pure rules the fake renderer copies from three r186 (node_modules/three/src), kept apart from its control flow:
 * render-list placement (RenderList.push, needsDoublePass), the override derivation of Renderer.renderObject,
 * RenderObject.getDrawParameters, Info.update's triangle count and PointShadowNode's cube faces.
 */
import {
  BackSide,
  type BufferGeometry,
  DoubleSide,
  FrontSide,
  type Material,
  type Object3D,
  type Side,
  Vector3,
} from 'three';

/** Material fields three reads that the base Material type does not declare. */
type RenderMaterial = Material & {
  transmission?: number;
  transmissionNode?: { isNode?: boolean } | null;
  backdropNode?: { isNode?: boolean } | null;
  wireframe?: boolean;
};

/** Renderer.js `_shadowSide`. */
const SHADOW_SIDE: Record<Side, Side> = { [FrontSide]: BackSide, [BackSide]: FrontSide, [DoubleSide]: DoubleSide };

const hasTransmission = (m: RenderMaterial): boolean =>
  (m.transmission ?? 0) > 0 || m.transmissionNode?.isNode === true;

/** RenderList.push: transparent, transmissive and backdrop materials go to the transparent list. */
export function isTransparentItem(material: Material): boolean {
  const m = material as RenderMaterial;
  return m.transparent === true || hasTransmission(m) || m.backdropNode?.isNode === true;
}

/** RenderList needsDoublePass: transmissive double-sided materials also render in a back-side pass first. */
export function needsDoublePass(material: Material): boolean {
  return (
    hasTransmission(material as RenderMaterial) && material.side === DoubleSide && material.forceSinglePass === false
  );
}

/** Renderer.renderObject: the value it assigns to `overrideMaterial.transparent` (a raw `||` chain, as in three). */
export function overrideTransparent(material: Material): boolean {
  const m = material as RenderMaterial;
  return (m.transparent ||
    (m.transmission as number) > 0 ||
    (m.transmissionNode && m.transmissionNode.isNode) ||
    (m.backdropNode && m.backdropNode.isNode)) as boolean;
}

/** Renderer.renderObject: the side of a shadow-pass override material, `shadowSide ?? flipped side` (VSM keeps the side). */
export function shadowPassSide(material: Material, vsm: boolean): Side {
  if (material.shadowSide !== null) return material.shadowSide;
  return vsm ? material.side : SHADOW_SIDE[material.side];
}

export interface DrawParameters {
  vertexCount: number;
  instanceCount: number;
}

type Drawable = Object3D & {
  count?: number;
  isBatchedMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isLineSegments?: boolean;
  isLineLoop?: boolean;
  geometry: BufferGeometry & { isInstancedBufferGeometry?: boolean; instanceCount?: number };
};

/**
 * RenderObject.getDrawParameters, null when nothing is drawn. The instance count is `geometry.instanceCount` for an
 * InstancedBufferGeometry, else `object.count` (1 on Mesh, Sprite and BatchedMesh; undefined, so 1, on Points and
 * Lines). A BatchedMesh returns before the vertex range: its backends draw `_multiDrawCounts`.
 */
export function drawParameters(
  object: Object3D,
  material: Material,
  group: { start: number; count: number } | null,
): DrawParameters | null {
  const o = object as Drawable;
  const geometry = o.geometry;
  let instanceCount = 1;
  if (geometry.isInstancedBufferGeometry === true) instanceCount = geometry.instanceCount as number;
  else if (o.count !== undefined) instanceCount = Math.max(0, o.count);
  if (instanceCount === 0) return null;
  if (o.isBatchedMesh === true) return { vertexCount: 0, instanceCount };
  const rangeFactor =
    (material as RenderMaterial).wireframe === true && !o.isPoints && !o.isLineSegments && !o.isLine && !o.isLineLoop
      ? 2
      : 1;
  const range = geometry.drawRange;
  let first = range.start * rangeFactor;
  let last = (range.start + range.count) * rangeFactor;
  if (group !== null) {
    first = Math.max(first, group.start * rangeFactor);
    last = Math.min(last, (group.start + group.count) * rangeFactor);
  }
  // getIndex(): the index or, for wireframe, a generated line index (approximated here as twice the item count).
  const items = geometry.index?.count ?? geometry.attributes.position?.count;
  const itemCount = items === undefined ? Infinity : items * rangeFactor;
  first = Math.max(first, 0);
  last = Math.min(last, itemCount);
  const count = last - first;
  if (count < 0 || count === Infinity) return null;
  return { vertexCount: count, instanceCount };
}

/** Info.update: the triangles one draw adds (meshes and sprites; points and lines are counted separately in three). */
export function trianglesOf(object: Object3D, count: number, instanceCount: number): number {
  const o = object as Object3D & { isMesh?: boolean; isSprite?: boolean };
  return o.isMesh === true || o.isSprite === true ? instanceCount * (count / 3) : 0;
}

/** The instance id each multi-draw slot with a non-zero index count draws: slot i reads `indirect[i]`. */
export function slotIds(counts: readonly number[], indirect: ArrayLike<number>): number[] {
  const ids: number[] = [];
  counts.forEach((count, i) => {
    if (count > 0) ids.push(indirect[i] as number);
  });
  return ids;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

/** PointShadowNode: look direction and up per cube face, order +X, -X, +Y, -Y, +Z, -Z. */
export const CUBE_FACES_WEBGL = {
  directions: [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)],
  ups: [v(0, -1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1), v(0, -1, 0), v(0, -1, 0)],
};

/** PointShadowNode for the WebGPU coordinate system: the Y faces are swapped. */
export const CUBE_FACES_WEBGPU = {
  directions: [v(1, 0, 0), v(-1, 0, 0), v(0, -1, 0), v(0, 1, 0), v(0, 0, 1), v(0, 0, -1)],
  ups: [v(0, -1, 0), v(0, -1, 0), v(0, 0, -1), v(0, 0, 1), v(0, -1, 0), v(0, -1, 0)],
};
