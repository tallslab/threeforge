import { DoubleSide, type Material, type Object3D, type Scene } from 'three';

export interface BackendInfo {
  backend: 'webgl2' | 'webgpu' | 'unknown';
  multiDraw: boolean;
}

/** Material fields three's `renderObject` reads that the base Material type does not declare. */
type SourceMaterial = Material & {
  transmission?: number;
  transmissionNode?: { isNode?: boolean } | null;
  backdropNode?: { isNode?: boolean } | null;
};

type Counted = Object3D & {
  isBatchedMesh?: boolean;
  isInstancedMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isLineSegments?: boolean;
  isLineLoop?: boolean;
  count?: number;
  instanceCount?: number;
  _multiDrawCount?: number;
  _multiDrawCounts?: ArrayLike<number>;
  geometry?: {
    isInstancedBufferGeometry?: boolean;
    instanceCount?: number;
    index?: { count: number } | null;
    attributes?: { position?: { count: number } | null };
    drawRange?: { start: number; count: number };
  };
};

/** A `geometry.groups` entry, as three hands it to `renderObject` — null when the object draws with one material. */
export interface DrawGroup {
  start: number;
  count: number;
  materialIndex?: number;
}

/**
 * Whether three's vertex range for this submission is empty, so `RenderObject.getDrawParameters()` returns null and the
 * backend draws nothing (`RenderObject.js:640-671`): `count = min(lastVertex, itemCount) - max(firstVertex, 0)`, and
 * `count < 0 || count === Infinity` draws nothing. Three reachable ways to get there, none of them modelled before
 * (independent review M4):
 * - no index and no `position` attribute, so `itemCount` is `Infinity`, under the default `drawRange` of
 *   `{ start: 0, count: Infinity }` (`BufferGeometry.js:188`) — geometry driven from storage buffers whose author did
 *   not call `setDrawRange`. A finite `drawRange` on the same geometry does draw;
 * - a `drawRange` disjoint from the group three is drawing (two groups `(0,18)` and `(18,18)` with
 *   `setDrawRange(0, 10)`: group 1 gets `firstVertex` 18 and `lastVertex` 10);
 * - a `drawRange` starting past the last vertex, which the `itemCount` clamp turns negative.
 *
 * `rangeFactor` follows three (2 for a wireframe mesh); the item count is scaled by it as an approximation of three's
 * generated wireframe index, the same approximation the FakeRenderer makes (`test/unit/helpers/fakeRendererRules.ts`).
 * It can only matter for a wireframe mesh whose range is already disjoint.
 */
function drawsNoVertices(o: Counted, material: Material | null, group: DrawGroup | null): boolean {
  const geometry = o.geometry;
  const range = geometry?.drawRange;
  if (geometry === undefined || range === undefined) return false;
  const line = o.isPoints === true || o.isLineSegments === true || o.isLine === true || o.isLineLoop === true;
  const rangeFactor = (material as (Material & { wireframe?: boolean }) | null)?.wireframe === true && !line ? 2 : 1;
  let firstVertex = range.start * rangeFactor;
  let lastVertex = (range.start + range.count) * rangeFactor;
  if (group !== null) {
    firstVertex = Math.max(firstVertex, group.start * rangeFactor);
    lastVertex = Math.min(lastVertex, (group.start + group.count) * rangeFactor);
  }
  const index = geometry.index;
  const position = geometry.attributes?.position;
  const items = index !== undefined && index !== null ? index.count : position !== undefined && position !== null ? position.count : undefined;
  const itemCount = items === undefined ? Infinity : items * rangeFactor;
  firstVertex = Math.max(firstVertex, 0);
  lastVertex = Math.min(lastVertex, itemCount);
  const count = lastVertex - firstVertex;
  return count < 0 || count === Infinity;
}

/**
 * Draws one `renderObject` call makes for `material` in `scene`: 2 when the material three draws is transparent,
 * DoubleSide and not `forceSinglePass` (a BackSide draw, then a FrontSide one), else 1. Follows three r186's
 * `Renderer.renderObject` (Renderer.js ~3717-3810): a material with `allowOverride` draws as `scene.overrideMaterial`,
 * whose `transparent` three sets from the source (transparent, transmissive or with a backdrop node) and whose side is
 * its own, except on a shadow pass material, whose side is `shadowSide ?? _shadowSide[side]` (VSM: `shadowSide ?? side`).
 * `_shadowSide` swaps FrontSide and BackSide and keeps DoubleSide, so both shadow rules agree on whether the side is
 * DoubleSide, which is all this reads.
 *
 * Evaluate it BEFORE the call: three puts the override material's side back as `renderObject` returns. The source side
 * is the one the call starts with, which `_renderTransparents` has already set to BackSide or FrontSide for the two
 * submissions of a transmissive double-sided material. A side `object.onBeforeRender` changes inside the call is not
 * seen; the sprite batch's hook only swaps FrontSide and BackSide, which cannot change the factor.
 */
export function sideFactor(material: Material, scene: Scene): 1 | 2 {
  const override = material.allowOverride === true ? ((scene.overrideMaterial ?? null) as (Material & { isShadowPassMaterial?: boolean }) | null) : null;
  if (override === null) return material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false ? 2 : 1;
  const m = material as SourceMaterial;
  // The raw `||` chain three assigns to `overrideMaterial.transparent`, then compared with `=== true` as three does.
  const transparent = m.transparent || (m.transmission as number) > 0 || (m.transmissionNode && m.transmissionNode.isNode) || (m.backdropNode && m.backdropNode.isNode);
  const side = override.isShadowPassMaterial ? (material.shadowSide !== null ? material.shadowSide : material.side) : override.side;
  return transparent === true && side === DoubleSide && override.forceSinglePass === false ? 2 : 1;
}

/**
 * Draw calls one submission adds to three's `info.render.drawCalls`, with `sides` from `sideFactor()` taken before the
 * call. Evaluate it AFTER the call: BatchedMesh fills `_multiDrawCount` in its onBeforeRender, and a sprite batch writes
 * `geometry.instanceCount` in its own.
 * - `RenderObject.getDrawParameters()` returns null, and nothing is drawn, when the instance count is 0: the geometry's
 *   `instanceCount` for an InstancedBufferGeometry (sprite batches, VAT parts), else `object.count` (InstancedMesh; 1 on
 *   Mesh, Sprite and BatchedMesh; undefined, so 1, on Points and Lines).
 * - It also returns null when the vertex range is empty (`drawsNoVertices`, which needs the `material` and the `group`
 *   three is drawing with). A BatchedMesh returns before that test in three, so it is skipped for one here too.
 * - A BatchedMesh adds one draw call per multi-draw slot on WebGPU (`WebGPUBackend.draw`) and on WebGL without
 *   WEBGL_multi_draw, one for the whole list with it (`WebGLBufferRenderer.renderMultiDraw`), none for an empty list.
 *   `Info.update` counts a slot whose index count a nested pass zeroed like any other.
 */
export function expectedGpuDraws(object: Object3D, sides: number, info: BackendInfo, material: Material | null = null, group: DrawGroup | null = null): number {
  const o = object as Counted;
  const geometry = o.geometry;
  if (geometry?.isInstancedBufferGeometry === true ? geometry.instanceCount === 0 : o.count !== undefined && o.count <= 0) return 0;
  if (!o.isBatchedMesh) return drawsNoVertices(o, material, group) ? 0 : sides;
  const n = o._multiDrawCount ?? 0;
  return (n === 0 ? 0 : info.backend === 'webgpu' || !info.multiDraw ? n : 1) * sides;
}

/**
 * Instances covered by a submission and how many of them the renderer will actually draw, written into `into` (the
 * ledger's pooled record). Like `expectedGpuDraws`, read after the renderer processed the object. A BatchedMesh draws
 * the multi-draw slots whose index count is not zero: a slot a nested pass zeroed (stable-prefix culling,
 * `src/compiler/culling.ts`) still adds a draw call but draws no instance.
 *
 * A submission whose vertex range three rejects (`drawsNoVertices`, the same three inputs `expectedGpuDraws` predicts
 * 0 draws for) draws no instance either, so `instancesDrawn` is 0 for it — without that, a total counted work three
 * skipped. `instances`, what the submission *covers*, is unchanged: the mesh is still the submission's subject. A
 * BatchedMesh is exempt as it is there, because three returns before the vertex range for one.
 */
export function writeInstanceCounts<T extends { instances: number; instancesDrawn: number }>(object: Object3D, into: T, material: Material | null = null, group: DrawGroup | null = null): T {
  const o = object as Counted;
  if (o.isBatchedMesh) {
    into.instances = o.instanceCount ?? 0;
    const n = o._multiDrawCount ?? 0;
    const counts = o._multiDrawCounts;
    let drawn = n;
    if (counts !== undefined) {
      drawn = 0;
      for (let i = 0; i < n; i++) if ((counts[i] as number) > 0) drawn++;
    }
    into.instancesDrawn = drawn;
  } else if (o.geometry?.isInstancedBufferGeometry) {
    // A plain mesh over an InstancedBufferGeometry (sprite batches, VAT parts): one draw, geometry.instanceCount instances.
    const n = o.geometry.instanceCount ?? 0;
    into.instances = n;
    into.instancesDrawn = n;
  } else if (o.isInstancedMesh) {
    const total = (object.userData as { forge?: { instances?: number } } | null)?.forge?.instances;
    into.instances = total ?? o.count ?? 0;
    into.instancesDrawn = o.count ?? 0;
  } else {
    into.instances = 1;
    into.instancesDrawn = 1;
  }
  if (!o.isBatchedMesh && into.instancesDrawn !== 0 && drawsNoVertices(o, material, group)) into.instancesDrawn = 0;
  return into;
}
