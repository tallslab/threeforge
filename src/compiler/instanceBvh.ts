import {
  BVH,
  type BVHNode,
  WebGLCoordinateSystem as BvhWebGL,
  WebGPUCoordinateSystem as BvhWebGPU,
  type FloatArray,
  HybridBuilder,
} from 'bvh.js';
import {
  type Box3,
  type Camera,
  type CoordinateSystem,
  Frustum,
  Matrix4,
  type Object3D,
  WebGLCoordinateSystem,
} from 'three';

/**
 * Scratch both cullers share: the running camera's view-projection in the culled object's frame, and the frustum built
 * from it. `viewProjection` and `frustumFor` fill it; it holds until the next call to either.
 */
export const cameraView = { matrix: new Matrix4(), frustum: new Frustum() };

/** `cameraView.matrix`: the camera's projection times its view times `target.matrixWorld`. */
export function viewProjection(camera: Camera, target: Object3D): Matrix4 {
  return cameraView.matrix
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(target.matrixWorld);
}

/** `cameraView.frustum` set from `viewProjection(camera, target)`, in `coordinateSystem` and the given depth convention. */
export function frustumFor(
  camera: Camera,
  target: Object3D,
  coordinateSystem: CoordinateSystem,
  reversedDepth?: boolean,
): Frustum {
  return cameraView.frustum.setFromProjectionMatrix(viewProjection(camera, target), coordinateSystem, reversedDepth);
}

/** Writes `box` as the `[minX, maxX, minY, maxY, minZ, maxZ]` bvh.js reads. */
function toBvhBox(box: Box3, out: FloatArray): FloatArray {
  out[0] = box.min.x;
  out[1] = box.max.x;
  out[2] = box.min.y;
  out[3] = box.max.y;
  out[4] = box.min.z;
  out[5] = box.max.z;
  return out;
}

/**
 * A bvh.js tree over instance ids, with the leaf bookkeeping `move`/`insert`/`remove` need. `boxOf` gives an instance's
 * box in the tree's frame and may return shared scratch: it is read before the next call.
 */
export class InstanceBvh {
  readonly bvh: BVH<object, number>;
  private readonly nodes = new Map<number, BVHNode<object, number>>();

  constructor(
    coordinateSystem: CoordinateSystem,
    private readonly boxOf: (id: number) => Box3,
    /** The box margin leaves are built and refitted with (see `CullingOptions.margin`). */
    readonly margin = 0,
  ) {
    this.bvh = new BVH<object, number>(
      new HybridBuilder(),
      coordinateSystem === WebGLCoordinateSystem ? BvhWebGL : BvhWebGPU,
    );
  }

  /** Builds the tree over `ids`; `bounds`, when given, grows to cover every box. */
  build(ids: number[], bounds?: Box3): void {
    const boxes: FloatArray[] = [];
    for (const id of ids) {
      const box = this.boxOf(id);
      if (bounds) bounds.union(box);
      boxes.push(toBvhBox(box, new Float32Array(6)));
    }
    this.bvh.createFromArray(ids, boxes, (node) => this.nodes.set(node.object!, node), this.margin);
  }

  /** Re-reads an instance's box and refits its leaf. */
  move(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    toBvhBox(this.boxOf(id), node.box);
    this.bvh.move(node, this.margin);
  }

  insert(id: number): void {
    this.nodes.set(id, this.bvh.insert(id, toBvhBox(this.boxOf(id), new Float32Array(6)), this.margin));
  }

  remove(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.bvh.delete(node);
    this.nodes.delete(id);
  }

  clear(): void {
    this.bvh.clear();
    this.nodes.clear();
  }
}
