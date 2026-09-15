import { describe, expect, it } from 'vitest';
import { BackSide, BatchedMesh, Box3, BoxGeometry, DodecahedronGeometry, DoubleSide, FrontSide, InstancedMesh, Matrix3, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, Vector3, type Camera, type Material } from 'three';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera, type FakeRendererOptions } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);
const solid = (color: number) => new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });

/** Two chunks of statics far apart on x, so chunkSize splits them into two batches. */
function twoChunkScene() {
  const scene = new Scene();
  for (let i = 0; i < 4; i++) {
    const a = tag.static(new Mesh(box, solid(0x336699)));
    a.name = `left-${i}`;
    a.position.set(i * 2, 0, 0);
    const b = tag.static(new Mesh(box, solid(0x336699)));
    b.name = `right-${i}`;
    b.position.set(100 + i * 2, 0, 0);
    scene.add(a, b);
  }
  return scene;
}

function proxiesIn(scene: Scene): Mesh[] {
  return scene.children.filter((o): o is Mesh => (o as Mesh).isMesh && (o.userData.forge as { kind?: string } | undefined)?.kind === 'occlusion-proxy');
}

function proxyOf(scene: Scene, target: Object3D): Mesh {
  return proxiesIn(scene).find((p) => p.name === `forge:occluder:${target.name}`)!;
}

/** The two batches of `twoChunkScene`, by their scene-space box: the chunk near the origin first. */
function leftAndRight(scene: Scene): [BatchedMesh, BatchedMesh] {
  const batches = scene.children.filter((o): o is BatchedMesh => (o as BatchedMesh).isBatchedMesh);
  expect(batches).toHaveLength(2);
  const left = batches.find((b) => b.boundingBox!.max.x < 50)!;
  return [left, batches.find((b) => b !== left)!];
}

function lookFrom<T extends Camera>(camera: T, [x, y, z]: [number, number, number], [tx, ty, tz]: [number, number, number]): T {
  camera.position.set(x, y, z);
  camera.lookAt(tx, ty, tz);
  camera.updateMatrixWorld();
  return camera;
}

/** The fake renderer plus an occlusion answer per object, like renderer.isOccluded(). Scene hooks on, as in three. */
class OcclusionRenderer extends FakeRenderer {
  occluded = new Set<Object3D>();
  constructor(options: FakeRendererOptions = {}) {
    super({ sceneHooks: true, ...options });
  }
  isOccluded(object: Object3D): boolean {
    return this.occluded.has(object);
  }
}

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
 *   one per nesting depth).
 * - A draw ends the previous object's query and begins its own, reading `occlusionTest` at that moment; the end of the
 *   render ends the last one the same way. The fake throws when `occlusionTest` changed between an object's draw and the
 *   end of its query (an unbalanced begin/end), or when a draw would begin a query the list did not count (an index
 *   beyond the query set).
 * - The result set of render k of a context becomes what `isOccluded()` reads in that context from its render
 *   k + `lag` on, replacing the one before: three maps the buffer after the next render of that context ends and
 *   assigns the set asynchronously, so `lag` is at least 2 and has no upper bound.
 * - What the GPU counts is decided at the draw. A proxy's far faces lie behind its target, so a query counts samples
 *   only when a triangle three rasterises faces the eye (`facesEye`) and `wall(object, camera)` does not cover it.
 */
class QueryRenderer extends FakeRenderer {
  lag = 2;
  wall: (object: Object3D, camera: Camera) => boolean = () => false;
  /** Every query issued: the object, the nesting depth (0 outermost) and the frame. */
  readonly queries: { object: Object3D; depth: number; frame: number }[] = [];
  private readonly contexts: QueryContext[] = [];
  private readonly open: OpenRender[] = [];

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

  override render(scene: Object3D, camera: Camera): void {
    const depth = this.open.length;
    const context = (this.contexts[depth] ??= { renders: 0, pending: [], delivered: new Set() });
    context.renders++;
    while (context.pending.length > 0 && context.pending[0]!.render + this.lag <= context.renders) context.delivered = context.pending.shift()!.occluded;
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
    if (last !== null && (last.object.occlusionTest === true) !== last.began) throw new Error(`${last.object.name}: occlusionTest changed between its draw and the end of its query`);
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
function facesEye(mesh: Mesh, material: Material, camera: Camera): boolean {
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

describe('World occlusion', () => {
  it('adds one invisible proxy per batch that carries the occlusion test', () => {
    const scene = twoChunkScene();
    const report = new World(scene, { chunkSize: 50, occlusion: true }).compile();
    const proxies = proxiesIn(scene);
    expect(proxies).toHaveLength(2);
    for (const proxy of proxies) {
      expect(proxy.occlusionTest).toBe(true);
      const material = proxy.material as MeshStandardMaterial;
      expect(material.colorWrite).toBe(false);
      expect(material.depthWrite).toBe(false);
      expect(material.side).toBe(FrontSide);
      expect(proxy.name).toMatch(/^forge:occluder:forge:batch:/);
      expect(proxy.geometry.boundingBox).not.toBeNull();
    }
    expect(report.occlusion).toEqual({ proxies: 2 });
  });

  it('hides a batch whose proxy was reported occluded and shows it again when it is not', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const { camera } = sceneWithCamera();
    const batches = scene.children.filter((o): o is BatchedMesh => (o as BatchedMesh).isBatchedMesh);
    const proxies = proxiesIn(scene);
    renderer.occluded.add(proxies[1]!);
    renderer.render(scene, camera); // results are read after the frame
    expect(batches[0]!.visible).toBe(true);
    expect(batches[1]!.visible).toBe(false);
    expect(proxies[1]!.visible).toBe(true); // the proxy keeps testing
    renderer.occluded.clear();
    renderer.render(scene, camera);
    expect(batches[1]!.visible).toBe(true);
  });

  it('is attributed by the ledger as occlusion-proxy and removes hidden batches from the count', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { camera } = sceneWithCamera();
    renderer.occluded.add(proxiesIn(scene)[0]!);
    renderer.render(scene, camera);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.byReason['occlusion-proxy']?.submissions).toBe(2);
    expect(frame.byReason.batched?.submissions).toBe(1);
  });

  it('does nothing when the renderer has no isOccluded', () => {
    const scene = twoChunkScene();
    new World(scene, { chunkSize: 50, occlusion: true }).compile();
    const renderer = new FakeRenderer({ sceneHooks: true });
    const { camera } = sceneWithCamera();
    expect(() => renderer.render(scene, camera)).not.toThrow();
  });

  it('decompile removes proxies and restores visibility', () => {
    const scene = twoChunkScene();
    const world = new World(scene, { chunkSize: 50, occlusion: true });
    world.compile();
    const renderer = new OcclusionRenderer();
    const { camera } = sceneWithCamera();
    renderer.occluded.add(proxiesIn(scene)[0]!);
    renderer.render(scene, camera);
    world.decompile();
    expect(proxiesIn(scene)).toHaveLength(0);
    expect(scene.children.every((o) => o.visible)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(scene, 'onAfterRender')).toBe(false);
  });

  it('covers instanced groups too', () => {
    const scene = new Scene();
    for (let i = 0; i < 70; i++) {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.position.set(i * 2, 0, 0);
      scene.add(m);
    }
    const world = new World(scene, { occlusion: true });
    world.compile();
    expect(world.instancedMeshes).toHaveLength(1);
    expect(proxiesIn(scene)).toHaveLength(1);
    const cam = new PerspectiveCamera();
    void cam;
    expect(scene.children.some((o) => (o as InstancedMesh).isInstancedMesh)).toBe(true);
  });
});

describe('World occlusion with queries as three runs them', () => {
  it('keeps a batch visible while the camera is inside its box, and a query issued from inside never hides it later, whatever the lag', () => {
    for (const lag of [2, 3, 5]) {
      const scene = twoChunkScene();
      new World(scene, { chunkSize: 50, occlusion: true }).compile();
      scene.updateMatrixWorld();
      const [left, right] = leftAndRight(scene);
      const leftProxy = proxyOf(scene, left);
      const renderer = new QueryRenderer();
      renderer.lag = lag;
      renderer.wall = (object) => object === proxyOf(scene, right); // the far chunk stands behind a wall
      // The left box spans x -0.5..6.5 and y, z -0.5..0.5: this eye is inside it.
      const camera = lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 0, 0], [3, 0, -10]);
      const hidden: string[] = [];
      for (let frame = 0; frame < 8; frame++) {
        renderer.render(scene, camera);
        if (!left.visible) hidden.push(`inside, frame ${frame}`);
        expect(leftProxy.occlusionTest, 'restored once the render is over').toBe(true);
      }
      const fromInside = renderer.queries.filter((q) => q.object === leftProxy).length;
      lookFrom(camera, [3, 0, 20], [3, 0, 0]);
      for (let frame = 0; frame < 8; frame++) {
        renderer.render(scene, camera);
        if (!left.visible) hidden.push(`outside, frame ${frame}`);
      }
      expect(hidden, `lag ${lag}: frames the batch around or in front of the camera was hidden`).toEqual([]);
      expect(fromInside, `lag ${lag}: queries of the proxy around the camera`).toBe(0);
      expect(renderer.queries.filter((q) => q.object === leftProxy).length, `lag ${lag}: queries resume outside`).toBe(8);
      expect(right.visible, `lag ${lag}: the chunk behind the wall is still hidden`).toBe(false);
    }
  });

  it('issues no query while the near plane can reach into the box: an eye within twice the near distance, a wide field of view, an orthographic near plane through the box', () => {
    const scene = twoChunkScene();
    new World(scene, { chunkSize: 50, occlusion: true }).compile();
    scene.updateMatrixWorld();
    const [left] = leftAndRight(scene);
    const leftProxy = proxyOf(scene, left);
    const renderer = new QueryRenderer();
    const queried = (camera: Camera): boolean => {
      const before = renderer.queries.filter((q) => q.object === leftProxy).length;
      renderer.render(scene, camera);
      return renderer.queries.filter((q) => q.object === leftProxy).length > before;
    };
    const down = (camera: OrthographicCamera): OrthographicCamera => {
      camera.up.set(0, 0, -1);
      return camera;
    };
    const cases: [string, Camera, boolean][] = [
      // The box's +z face is at z = 0.5; near 0.1.
      ['eye 0.15 in front of a face', lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 0, 0.65], [3, 0, -10]), false],
      ['eye 2.5 in front of a face', lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 0, 3], [3, 0, -10]), true],
      // Near 1, eye 2.5 from the face (beyond twice near), looking along it: the near plane's half-width is what reaches.
      ['fov 170, looking along the face', lookFrom(new PerspectiveCamera(170, 2, 1, 500), [3, 0, 3], [-10, 0, 3]), false],
      ['fov 60, looking along the face', lookFrom(new PerspectiveCamera(60, 2, 1, 500), [3, 0, 3], [-10, 0, 3]), true],
      // Looking down from 23 units beside the box: the near plane lies at y = 0, through the box, and spans x -50..10.
      ['orthographic, near plane through the box', lookFrom(down(new OrthographicCamera(-30, 30, 30, -30, 5, 100)), [-20, 5, 0], [-20, -10, 0]), false],
      ['orthographic, near plane above the box', lookFrom(down(new OrthographicCamera(-30, 30, 30, -30, 5, 100)), [-20, 50, 0], [-20, -10, 0]), true],
    ];
    const outcome = cases.map(([name, camera]) => `${name}: ${queried(camera) ? 'queried' : 'no query'}`);
    expect(outcome).toEqual(cases.map(([name, , expected]) => `${name}: ${expected ? 'queried' : 'no query'}`));
    expect(left.visible).toBe(true);
  });

  it('never changes target visibility from a nested pass (a reflection rendering the scene again)', () => {
    const scene = twoChunkScene();
    new World(scene, { chunkSize: 50, occlusion: true }).compile();
    scene.updateMatrixWorld();
    const [left] = leftAndRight(scene);
    const leftProxy = proxyOf(scene, left);
    const renderer = new QueryRenderer();
    const main = lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 1, 12], [3, 0, 0]);
    const mirrorCamera = lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 1, -12], [3, 0, 0]);
    // Like three's Reflector: while it is drawn it renders the scene into its target with a virtual camera. Added after
    // compile, it draws after the proxies.
    const reflector = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial());
    reflector.name = 'reflector';
    reflector.position.set(3, -5, 0);
    reflector.onBeforeRender = () => {
      reflector.visible = false;
      renderer.renderTarget = { name: 'reflection' };
      renderer.render(scene, mirrorCamera);
      renderer.renderTarget = null;
      reflector.visible = true;
    };
    scene.add(reflector);
    scene.updateMatrixWorld();
    // The reflection sees the left chunk's box behind a wall; the main camera sees it.
    renderer.wall = (object, camera) => object === leftProxy && camera === mirrorCamera;
    const shown: boolean[] = [];
    for (let frame = 0; frame < 6; frame++) {
      renderer.render(scene, main);
      shown.push(left.visible);
    }
    expect(renderer.queries.some((q) => q.object === leftProxy && q.depth === 1), 'the nested pass queried the proxy').toBe(true);
    expect(shown, 'hidden by nothing the main camera sees').toEqual([true, true, true, true, true, true]);
    // The other way round: hidden for the main camera, a nested pass that sees the box does not show it.
    renderer.wall = (object, camera) => object === leftProxy && camera === main;
    for (let frame = 0; frame < 6; frame++) renderer.render(scene, main);
    expect(left.visible, 'hidden for the main camera').toBe(false);
  });

  it('gives no proxy to a batch holding a batch-synced mover, so a mover that leaves the box stays visible, also when the scene moves', () => {
    const scene = twoChunkScene();
    const mover = tag.dynamic(new Mesh(box, solid(0x336699)));
    mover.name = 'mover';
    mover.position.set(3, 0, 0);
    scene.add(mover);
    const world = new World(scene, { chunkSize: 50, occlusion: true, dynamics: 'batch-sync' });
    const report = world.compile();
    expect(report.synced).toBe(1);
    const holder = world.slotOf(mover)!.batch as BatchedMesh;
    const [left, right] = leftAndRight(scene);
    expect(holder).toBe(left);
    const renderer = new QueryRenderer();
    // Both compile-time boxes stand behind a wall; the mover flies out of its box into the open.
    renderer.wall = (object) => proxiesIn(scene).includes(object as Mesh);
    const camera = lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [3, 1, 30], [3, 0, 0]);
    mover.position.set(3, 12, 0);
    const shown: boolean[] = [];
    for (let frame = 0; frame < 6; frame++) {
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      shown.push(holder.visible);
    }
    scene.position.set(0, -8, 0);
    for (let frame = 0; frame < 6; frame++) {
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      shown.push(holder.visible);
    }
    expect(shown).toEqual(new Array(12).fill(true));
    expect(right.visible, 'a batch without movers is still culled').toBe(false);
    expect(report.occlusion).toEqual({ proxies: 1 });
  });

  it('keeps a visible target visible under a mirrored scene: three flips the front face with the mirror, so the FrontSide proxy still rasterises the faces toward the eye', () => {
    const scene = twoChunkScene();
    // Shifted so no batch straddles a world-space chunk cell boundary once mirrored.
    scene.position.x = -20;
    scene.scale.x = -1;
    scene.updateMatrixWorld(true);
    new World(scene, { chunkSize: 50, occlusion: true }).compile();
    scene.updateMatrixWorld(true);
    const [left, right] = leftAndRight(scene);
    const leftProxy = proxyOf(scene, left);
    const renderer = new QueryRenderer();
    renderer.wall = (object) => object === proxyOf(scene, right);
    // The left chunk spans world x -26.5..-19.5 while mirrored.
    const camera = lookFrom(new PerspectiveCamera(60, 1, 0.1, 500), [-23, 1, 12], [-23, 0, 0]);
    const shown: string[] = [];
    const frames = (label: string): void => {
      scene.updateMatrixWorld(true);
      for (let frame = 0; frame < 5; frame++) {
        renderer.render(scene, camera);
        shown.push(`${label} ${frame}: ${left.visible ? 'shown' : 'hidden'}`);
      }
    };
    frames('mirrored at compile');
    expect(right.visible, 'a covered box is still culled while mirrored').toBe(false);
    scene.scale.x = 1;
    frames('unmirrored after compile');
    scene.scale.x = -1;
    frames('mirrored again');
    expect(shown).toEqual(['mirrored at compile', 'unmirrored after compile', 'mirrored again'].flatMap((label) => [0, 1, 2, 3, 4].map((f) => `${label} ${f}: shown`)));
    expect((leftProxy.material as Material).side).toBe(FrontSide);
  });
});

describe('World occlusion proxies after markDirty', () => {
  it('resizes the proxy of a batch and of an instanced group to their new bounds when an instance moves to x = 500', () => {
    const scene = new Scene();
    const dodeca = new DodecahedronGeometry(0.5);
    const boxes = [0, 1, 2].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x336699)));
      m.name = `box-${i}`;
      m.position.set(i * 2, 0, 0);
      scene.add(m);
      return m;
    });
    const dodecas = [0, 1, 2, 3].map((i) => {
      const m = tag.static(new Mesh(dodeca, solid(0x336699)));
      m.name = `dodeca-${i}`;
      m.position.set(i * 2, 5, 0);
      scene.add(m);
      return m;
    });
    const world = new World(scene, { occlusion: true, instanceThreshold: 4 });
    world.compile();
    const batch = world.slotOf(boxes[0]!)!.batch as BatchedMesh;
    const instanced = world.slotOf(dodecas[0]!)!.batch as InstancedMesh;
    expect(batch.isBatchedMesh).toBe(true);
    expect(instanced.isInstancedMesh).toBe(true);
    boxes[2]!.position.x = 500;
    dodecas[3]!.position.x = 500;
    world.markDirty(boxes[2]!);
    world.markDirty(dodecas[3]!);
    scene.updateMatrixWorld();
    for (const [target, originals] of [[batch, boxes], [instanced, dodecas]] as const) {
      const proxy = proxiesIn(scene).find((p) => p.name === `forge:occluder:${target.name}`)!;
      // The union of the instances' boxes, as the batch and the instanced group bound them (scene space is world space here).
      const expected = new Box3();
      for (const m of originals) expected.expandByObject(m);
      const actual = new Box3().setFromObject(proxy);
      [...actual.min.toArray(), ...actual.max.toArray()].forEach((v, i) => expect(v, `${target.name} proxy [${i}]`).toBeCloseTo([...expected.min.toArray(), ...expected.max.toArray()][i]!, 4));
    }
  });
});
