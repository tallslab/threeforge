import {
  BackSide,
  type Camera,
  DoubleSide,
  type Material,
  Matrix3,
  type Mesh,
  type Object3D,
  type Scene,
  Vector3,
  Vector4,
} from 'three';
import { FakeRenderer, type FakeRendererOptions } from './fakeRenderer.js';

interface QueryContext {
  renders: number;
  pending: { render: number; occluded: Set<Object3D> }[];
  delivered: Set<Object3D>;
}

interface OpenRender {
  camera: Camera;
  context: QueryContext;
  /** The objects the render list counted (`occlusionTest` when the list was built). */
  counted: Set<Object3D>;
  occluded: Set<Object3D>;
  last: { object: Object3D; began: boolean } | null;
}

/**
 * three r186's occlusion queries (`WebGPUBackend`, `WebGLBackend`), with the scene hooks three always calls:
 * - `RenderList.push` counts the objects with `occlusionTest` when the list is built (after the scene's
 *   `onBeforeRender`, before any object hook). A render whose count is not zero issues a query at each draw of such an
 *   object and yields one result set, in its render context (`RenderContexts.get(renderTarget, mrt, callDepth)`: here
 *   one per nesting depth). A render whose count is zero yields none (the `else` branch of both backends' `beginRender`).
 * - A draw ends the previous object's query and begins its own, reading `occlusionTest` at that moment; the end of the
 *   render ends the last one the same way. The fake throws when `occlusionTest` changed between an object's draw and the
 *   end of its query (an unbalanced begin/end), or when a draw would begin a query the list did not count (an index
 *   beyond the query set).
 * - The result set of render k of a context becomes what `isOccluded()` reads in that context from its render
 *   k + `lag` on, replacing the one before: three reads it back after the next render of that context ends and
 *   publishes it then (WebGL, when the results are ready) or after `mapAsync` (WebGPU), so `lag` is at least 2 and
 *   has no upper bound.
 * - What the GPU counts is decided at the draw. A proxy's far faces lie behind its target, so a query counts samples
 *   only when a triangle three rasterises faces the eye (`facesEye`) and `wall(object, camera)` does not cover it.
 * - The scissor state is kept (as `World.warmup` reads and restores it) but draws are not clipped: a test that needs a
 *   scissored render's answers says so through `wall`, for example `() => renderer.getScissorTest()`.
 */
export class QueryRenderer extends FakeRenderer {
  lag = 2;
  wall: (object: Object3D, camera: Camera) => boolean = () => false;
  /** Every query issued: the object, the nesting depth (0 outermost) and the frame. */
  readonly queries: { object: Object3D; depth: number; frame: number }[] = [];
  private readonly contexts: QueryContext[] = [];
  private readonly open: OpenRender[] = [];
  private readonly scissor = new Vector4(0, 0, 300, 150);
  private scissorTest = false;

  constructor(options: FakeRendererOptions = {}) {
    super({ sceneHooks: true, ...options });
    // The backend's draw runs between an object's onBeforeRender and onAfterRender (Renderer.renderObject).
    const self = this as unknown as { drawObject(object: Object3D, material: Material, ...rest: unknown[]): void };
    const draw = self.drawObject.bind(this);
    self.drawObject = (object, material, ...rest) => {
      this.query(object, material);
      draw(object, material, ...rest);
    };
  }

  getScissor(target: Vector4): Vector4 {
    return target.copy(this.scissor);
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.scissor.set(x, y, width, height);
  }

  getScissorTest(): boolean {
    return this.scissorTest;
  }

  setScissorTest(value: boolean): void {
    this.scissorTest = value;
  }

  /** Renderer.compileAsync: the scene's onBeforeRender runs (Renderer.js ~967), nothing is drawn, and onAfterRender never runs. */
  async compileAsync(scene: Object3D, camera: Camera): Promise<void> {
    const root = scene as Scene;
    if (root.isScene === true) (root.onBeforeRender as (...args: unknown[]) => void)(this, root, camera, null);
  }

  override render(scene: Object3D, camera: Camera): void {
    const depth = this.open.length;
    const context = (this.contexts[depth] ??= { renders: 0, pending: [], delivered: new Set() });
    context.renders++;
    while (context.pending.length > 0 && context.pending[0]!.render + this.lag <= context.renders)
      context.delivered = context.pending.shift()!.occluded;
    // threeforge's scene hooks never change occlusionTest, so counting before them is counting when the list is built.
    const counted = new Set<Object3D>();
    scene.traverse((o) => {
      if (o.visible && o.layers.test(camera.layers) && o.occlusionTest) counted.add(o);
    });
    const call: OpenRender = { camera, context, counted, occluded: new Set(), last: null };
    this.open.push(call);
    try {
      super.render(scene, camera);
    } finally {
      this.open.pop();
    }
    if (counted.size > 0) context.pending.push({ render: context.renders, occluded: call.occluded });
  }

  isOccluded(object: Object3D): boolean {
    return this.open[this.open.length - 1]?.context.delivered.has(object) === true;
  }

  private query(object: Object3D, material: Material): void {
    const call = this.open[this.open.length - 1];
    if (!call || call.counted.size === 0) return; // no query set: three issues no query in this render
    const last = call.last;
    if (last !== null && last.object === object) return;
    // Every scene render ends with the output quad's draw, which ends the last query like finishRender does.
    if (last !== null && (last.object.occlusionTest === true) !== last.began)
      throw new Error(`${last.object.name}: occlusionTest changed between its draw and the end of its query`);
    const began = object.occlusionTest === true;
    if (began) {
      if (!call.counted.has(object)) throw new Error(`${object.name}: begins a query the render list did not count`);
      this.queries.push({ object, depth: this.open.length - 1, frame: this.frameId });
      if (this.wall(object, call.camera) || !facesEye(object as Mesh, material, call.camera)) call.occluded.add(object);
    }
    call.last = { object, began };
  }
}

/**
 * Whether a triangle three rasterises for this draw faces the eye. The front face is decided by the winding on screen,
 * flipped when `side === BackSide` and again when the object's world matrix mirrors, and `Back` is culled unless
 * DoubleSide (`WebGPUPipelineUtils._getPrimitiveState`; `WebGLBackend.draw` -> `WebGLState.setMaterial`). From inside
 * a box no face faces the eye.
 */
export function facesEye(mesh: Mesh, material: Material, camera: Camera): boolean {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex()!;
  const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
  const flip = (material.side === BackSide) !== mesh.matrixWorld.determinant() < 0;
  const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const world = [new Vector3(), new Vector3(), new Vector3()];
  const screen = [new Vector3(), new Vector3(), new Vector3()];
  for (let t = 0; t < index.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      world[k]!.fromBufferAttribute(position, index.getX(t + k)).applyMatrix4(mesh.matrixWorld);
      screen[k]!.copy(world[k]!).project(camera);
    }
    const outward = new Vector3().fromBufferAttribute(normal, index.getX(t)).applyMatrix3(normalMatrix);
    if (outward.dot(eye.clone().sub(world[0]!)) <= 0) continue;
    if (material.side === DoubleSide) return true;
    const [a, b, c] = screen as [Vector3, Vector3, Vector3];
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y); // > 0: counter-clockwise on screen
    if (flip ? area < 0 : area > 0) return true;
  }
  return false;
}
