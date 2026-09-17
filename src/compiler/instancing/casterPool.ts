import type { BVH, BVHNode } from 'bvh.js';
import { Box3, type Camera, type Light, Matrix4, type Object3D, type Scene, Vector3 } from 'three';
import { cameraView, frustumFor } from '../instanceBvh.js';

type ShadowCamera = Camera & { reversedDepth?: boolean; far?: number };
type ShadowLight = Light & {
  isPointLight?: boolean;
  distance?: number;
  shadow?: {
    camera: ShadowCamera;
    autoUpdate: boolean;
    needsUpdate: boolean;
    updateMatrices(light: Light): void;
  } | null;
};
/** What the hook reads from three r186's renderer: `lighting` (Lighting.getNode) and the backend's uniform-buffer limit. */
export type RendererLike = {
  lighting?: { getNode?(scene: Object3D): { getLights?(): Light[] } };
  backend?: { capabilities?: { getUniformBufferLimit?(): number } };
} | null;

const _box = new Box3();
const _nodeBox = new Box3();
const _matrix = new Matrix4();
const _inverse = new Matrix4();
const _position = new Vector3();
const _cube = new Float32Array(6);

/** The bit of the `i`th shadow camera of the frame; 0 past the 32nd (see `CasterPool.lightBits`). */
function bitFor(i: number): number {
  return i < 32 ? (1 << i) >>> 0 : 0;
}

/**
 * The caster pool of a culled instanced mesh: every instance any shadow-casting light of the frame reaches (a
 * directional or spot light's frustum, a point light's cube of half-size `light.distance || shadow.camera.far`, the six
 * faces of `PointShadowNode`), deduplicated, built once per frame at the first shadow pass and rebuilt only when a
 * light, its view or the instances changed. No pass draws the pool itself: each appends the entries its own light
 * reaches, which `lightBits` records as one bit per shadow camera (see `each`).
 */
export class CasterPool {
  /** Every instance a shadow-casting light of the frame reaches, each once, in query order. */
  readonly ids: Int32Array;
  count = 0;
  /** Per instance in the list: a bit per shadow camera of the frame that reaches it (bit i = `shadowCameras[i]`). */
  readonly lightBits: Uint32Array;
  private readonly marks: Uint32Array;
  private mark = 0;
  /** The bit the running query sets; 0 for a camera past the 32nd, whose pass appends the whole list instead. */
  private queryBit = 0;
  /** The tracker frame the pool was checked for. */
  private frame = -1;
  /** The shadow cameras the pool covers this frame (a point light's one camera covers its six faces). */
  private readonly shadowCameras: Camera[] = [];
  /** The nested key: the lights the pool was built from, and 16 numbers per light after the group's matrix. */
  private readonly poolLights: Light[] = [];
  private key = new Float64Array(16);
  private nextKey = new Float64Array(16);
  private readonly nextLights: Light[] = [];
  /** Visibility, a matrix or an extra camera changed the pool since it was built. */
  private dirty = true;

  constructor(
    n: number,
    private readonly bvh: BVH<object, number>,
    private readonly visibleMask: Uint8Array,
  ) {
    this.ids = new Int32Array(n);
    this.lightBits = new Uint32Array(n);
    this.marks = new Uint32Array(n);
  }

  /** Visibility or a matrix changed: the next frame rebuilds the pool. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Brings the frame's caster list up to date at its first shadow pass, and covers `camera` if no listed light does.
   * Returns the index of `camera` among the frame's shadow cameras, whose bit its casters carry in `lightBits`.
   */
  ensure(frame: number, renderer: RendererLike, scene: Scene, camera: Camera, group: Object3D): number {
    if (this.frame !== frame) {
      this.frame = frame;
      this.rebuild(renderer, scene, group);
    }
    // Identity, not equality: two lights sharing one `LightShadow.camera` object would give the second the first's
    // bit and lose its own casters. three's own API never shares a shadow camera (`Light.copy` clones the shadow).
    let index = this.shadowCameras.indexOf(camera);
    if (index < 0) {
      // A shadow camera no listed light owns (or a renderer without `lighting`): cover it too, and rebuild next frame.
      index = this.shadowCameras.length;
      this.queryBit = bitFor(index);
      this.addFrustum(group, camera);
      this.shadowCameras.push(camera);
      this.dirty = true;
    }
    return index;
  }

  /** Calls `visit` with every caster the frame's shadow camera `index` reaches, in the list's order. */
  each(index: number, visit: (id: number) => void): void {
    const bit = bitFor(index);
    const ids = this.ids;
    const lightBits = this.lightBits;
    for (let j = 0, n = this.count; j < n; j++) {
      const id = ids[j]!;
      if (bit !== 0 && (lightBits[id]! & bit) === 0) continue; // a caster this shadow camera does not reach
      visit(id);
    }
  }

  /** Reads the render's shadow-casting lights and requeries the pool when they, their views or the instances changed. */
  private rebuild(renderer: RendererLike, scene: Scene, group: Object3D): void {
    // The lights of this render (Lighting.getNode(scene).getLights(): what the shadow render projected), filtered by
    // ShadowNode.updateBefore's own gate.
    const lights = renderer?.lighting?.getNode?.(scene)?.getLights?.() ?? [];
    let nextKey = this.nextKey;
    if (nextKey.length < 16 * (lights.length + 1)) this.nextKey = nextKey = new Float64Array(16 * (lights.length + 1));
    const nextLights = this.nextLights;
    const poolLights = this.poolLights;
    const key = this.key;
    for (let e = 0; e < 16; e++) nextKey[e] = group.matrixWorld.elements[e]!;
    let used = 0;
    for (const candidate of lights) {
      const light = candidate as ShadowLight;
      const shadow = light.shadow;
      if (!light.castShadow || !shadow || !(shadow.autoUpdate || shadow.needsUpdate)) continue;
      const offset = 16 * (used + 1);
      if (light.isPointLight) {
        _position.setFromMatrixPosition(light.matrixWorld);
        nextKey[offset] = _position.x;
        nextKey[offset + 1] = _position.y;
        nextKey[offset + 2] = _position.z;
        nextKey[offset + 3] = light.distance || (shadow.camera.far ?? 0); // PointShadowNode: far = light.distance || camera.far
        for (let e = 4; e < 16; e++) nextKey[offset + e] = 0;
      } else {
        shadow.updateMatrices(light); // what ShadowNode.renderShadow does before this light's map
        _matrix.multiplyMatrices(shadow.camera.projectionMatrix, shadow.camera.matrixWorldInverse);
        for (let e = 0; e < 16; e++) nextKey[offset + e] = _matrix.elements[e]!;
      }
      nextLights[used++] = light;
    }
    let same = !this.dirty && used === poolLights.length && key.length >= 16 * (used + 1);
    for (let i = 0; same && i < used; i++) same = nextLights[i] === poolLights[i];
    for (let e = 0; same && e < 16 * (used + 1); e++) same = nextKey[e] === key[e];
    if (!same) {
      if (this.mark >= 0xfffffffe) {
        this.marks.fill(0);
        this.mark = 0;
      }
      this.mark++;
      this.count = 0;
      for (let i = 0; i < used; i++) {
        const light = nextLights[i] as ShadowLight;
        const offset = 16 * (i + 1);
        this.queryBit = bitFor(i);
        if (light.isPointLight)
          this.addCube(group, nextKey[offset]!, nextKey[offset + 1]!, nextKey[offset + 2]!, nextKey[offset + 3]!);
        else this.addFrustum(group, light.shadow!.camera);
        poolLights[i] = light;
      }
      poolLights.length = used;
      this.key = nextKey;
      this.nextKey = key;
      this.dirty = false;
    }
    this.shadowCameras.length = 0;
    for (let i = 0; i < used; i++) this.shadowCameras.push((poolLights[i] as ShadowLight).shadow!.camera);
  }

  private readonly addCaster = (id: number): void => {
    if (!this.visibleMask[id]) return;
    if (this.marks[id] === this.mark) {
      this.lightBits[id] = this.lightBits[id]! | this.queryBit;
      return;
    }
    this.marks[id] = this.mark;
    this.lightBits[id] = this.queryBit;
    this.ids[this.count++] = id;
  };

  private readonly visitIntersecting = (id: number): boolean => {
    this.addCaster(id);
    return false;
  };

  /** `bvh.traverse` visitor: skips the subtrees whose box misses `cameraView.frustum`. */
  private readonly visitFrustum = (node: BVHNode<object, number>): boolean => {
    const b = node.box;
    _nodeBox.min.set(b[0]!, b[2]!, b[4]!);
    _nodeBox.max.set(b[1]!, b[3]!, b[5]!);
    if (!cameraView.frustum.intersectsBox(_nodeBox)) return true;
    if (node.object !== undefined) this.addCaster(node.object);
    return false;
  };

  /** What `camera` sees, with three's frustum in the camera's own coordinate system and depth convention. */
  private addFrustum(group: Object3D, camera: Camera): void {
    frustumFor(camera, group, camera.coordinateSystem, (camera as ShadowCamera).reversedDepth);
    this.bvh.traverse(this.visitFrustum);
  }

  /** What a point light's faces can see: the cube of half-size `reach` around (x, y, z), in the group's frame. */
  private addCube(group: Object3D, x: number, y: number, z: number, reach: number): void {
    _box.min.set(x - reach, y - reach, z - reach);
    _box.max.set(x + reach, y + reach, z + reach);
    _box.applyMatrix4(_inverse.copy(group.matrixWorld).invert());
    _cube[0] = _box.min.x;
    _cube[1] = _box.max.x;
    _cube[2] = _box.min.y;
    _cube[3] = _box.max.y;
    _cube[4] = _box.min.z;
    _cube[5] = _box.max.z;
    this.bvh.intersectsBox(_cube, this.visitIntersecting);
  }
}
