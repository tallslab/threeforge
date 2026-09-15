/**
 * A stand-in for three r186's common Renderer (`three/webgpu`) for node unit tests. It exposes the surface the ledger
 * patches and reads (render, renderAsync, renderObject, info, backend, shadowMap, getRenderTarget,
 * getDrawingBufferSize), the state the overdraw measurement saves and sets (render target, MRT, render-object function,
 * clear colour, `autoClear`, `opaque`/`transparent`, a zero read-back), and follows three's source where it decides what
 * is drawn:
 * - Renderer._projectObject: a hidden object hides its subtree; the camera's layers gate each object alone.
 * - Renderer._renderScene: the render list in traversal order, opaque items first, then a back-side pass of transmissive
 *   double-sided items, then transparent items (three also sorts each list; tests control order by insertion); the
 *   lights node of the projected lights as renderObject's argument 7; `scene.onAfterRender`, plus
 *   `scene.onBeforeRender` with `sceneHooks`, both given the render's target (`renderer.frameBufferTarget` for a canvas
 *   render). Non-Scene roots (quads) use an internal scene, like three's `_scene`.
 * - Renderer.renderObject: object hooks around the call, the override copy (`transparent`, the shadow side, restored
 *   side) and two draws, BackSide then FrontSide, for double-sided transparent materials.
 * - RenderObject.getDrawParameters and the backends' Info.update: nothing for zero instances or an empty range; one
 *   draw per call, N per BatchedMesh on WebGPU or on WebGL without WEBGL_multi_draw; triangles = instances x count / 3.
 * - ShadowNode and PointShadowNode: shadow maps per light (see `shadowLights`), six faces per point light, VSM quads,
 *   and `light.shadow.map` built as a light's map first renders.
 * Every Scene render without an override material also draws an "Output Color Transform" quad, like three's output
 * pass (a QuadMesh: one fullscreen triangle). Not modelled: frustum culling, sorting, matrix updates (call `scene.updateMatrixWorld()`), pipeline readiness.
 */
import {
  BackSide,
  BatchedMesh,
  BufferGeometry,
  Color,
  DepthTexture,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type BufferAttribute,
  type Camera,
  type CoordinateSystem,
  type Light,
  type LightShadow,
  type ShadowMapType,
  type Side,
} from 'three';
import { CUBE_FACES_WEBGL, CUBE_FACES_WEBGPU, drawParameters, isTransparentItem, needsDoublePass, overrideTransparent, shadowPassSide, slotIds, trianglesOf } from './fakeRendererRules.js';

export interface FakeRendererOptions {
  webgpu?: boolean;
  multiDraw?: boolean;
  /** One shadow-casting light; the same as `shadowLights: [shadowLight]`. */
  shadowLight?: Light;
  /**
   * Lights whose shadow maps this renderer updates, like ShadowNode.updateBefore. A light renders its map when
   * `renderer.shadowMap.enabled`, `light.castShadow`, the light is among the render's projected lights,
   * `shadow.autoUpdate || shadow.needsUpdate`, and the map has not rendered for that camera in this frame; `needsUpdate`
   * is then cleared. A map renders the scene with a shadow-pass override material and `shadow.camera` (directional and
   * spot lights after `shadow.updateMatrices(light)`; point lights six times, re-aiming that camera per face), drawing
   * casters only (plus receivers under VSM). `renderer.shadowMap.enabled` starts true when this or `shadowLight` is set.
   */
  shadowLights?: Light[];
  /**
   * When shadow maps render. Unset: at the start of every Scene render without an override material, before its
   * render list (the fake's earlier model). 'first-receiver': inside the renderObject of the first object with
   * `receiveShadow`, after its onBeforeRender and before its draw, as AnalyticLightNode's ShadowNode does.
   */
  shadowTrigger?: 'first-receiver';
  /**
   * Call `scene.onBeforeRender(renderer, scene, camera, renderTarget)` at the start of every render() call, as three
   * does. `renderTarget` (also passed to `scene.onAfterRender`) is `renderer.renderTarget`, or
   * `renderer.frameBufferTarget` when that is null: a canvas render draws into the frame-buffer target.
   */
  sceneHooks?: boolean;
  /** Record the render() calls and draws of the last frame in `renderer.passes` (see FakePass). */
  record?: boolean;
  /** With `renderer.shadowMap.type === VSMShadowMap`, render the two blur quads after each non-point map (ShadowNode.vsmPass). */
  vsmQuad?: boolean;
  /**
   * Bytes of instance matrices (`instanceMatrix.count * 64`) three r186 keeps in a uniform buffer (`Instance.js`,
   * `builder.getUniformBufferLimit()`); above it they go to one vertex buffer shared by every render object. Default
   * 65536, WebGPU's default `maxUniformBufferBindingSize`. Read with `record` only (see `FakeDraw.instanceRows`).
   */
  uniformBufferLimit?: number;
}

/** One draw as the backend issued it. */
export interface FakeDraw {
  object: Object3D;
  /** The material drawn: the scene's override material when renderObject applied it. */
  material: Material;
  /** `material.side` when drawn: BackSide then FrontSide for the two draws of a double-sided transparent material. */
  side: Side;
  /** Added to `info.render.drawCalls`. */
  drawCalls: number;
  /** Added to `info.render.triangles`. */
  triangles: number;
  /** RenderObject.getDrawParameters().instanceCount: geometry.instanceCount for an InstancedBufferGeometry, else object.count (1 on a BatchedMesh). */
  instanceCount: number;
  /**
   * BatchedMesh draws only, else null: the instance id of every multi-draw slot whose index count is non-zero, in slot
   * order. Slot counts are read when the draw is issued. Slot i draws `indirect[i]` of the batch's index texture as last
   * uploaded (on a `_indirectTexture.version` change): when the draw was issued on WebGL, when its render() call ended
   * on WebGPU (the pass is submitted then; filled in at that point).
   */
  batchIds: number[] | null;
  /**
   * InstancedMesh draws only (with `record`), else null: the matrix rows `[0, instanceCount)` the draw reads, 16 floats
   * per row, from the GPU buffer three r186 would bind (see `uploadInstances`). Read when the draw is issued on WebGL,
   * when its render() call ends on WebGPU (queue writes land at once; the pass is submitted then).
   */
  instanceRows: Float32Array | null;
  /** InstancedMesh draws with `instanceColor` only (with `record`), else null: the colour rows `[0, instanceCount)`, 3 floats per row, read like `instanceRows`. */
  instanceColorRows: Float32Array | null;
}

/** One render() call of the last frame. */
export interface FakePass {
  /** 'shadow': a shadow map render (one per point-light face); 'vsm': a VSM blur quad; 'render': any other call. */
  kind: 'render' | 'shadow' | 'vsm';
  /** 0 for the outermost call; nested calls (shadow maps, reflections) are deeper. */
  depth: number;
  /** `renderer.frameId` during the call. */
  frameId: number;
  /** The root and camera passed to render(). */
  scene: Object3D;
  camera: Camera;
  /** Copies of the camera matrices at the start of the call (the faces of a point light share one camera). */
  projectionMatrix: Matrix4;
  matrixWorldInverse: Matrix4;
  renderTarget: object | null;
  /** The light of a 'shadow' or 'vsm' pass, else null. */
  light: Light | null;
  /** The cube face (0..5) of a point light's 'shadow' pass, else null. */
  face: number | null;
  /** Draws in issue order, the output quad included. */
  draws: FakeDraw[];
}

/** LightsNode: the lights of the current render list (RenderList.finish), restored when a render ends (Lighting.finishRender). */
class FakeLightsNode {
  private lights: Light[] = [];

  getLights(): Light[] {
    return this.lights;
  }

  setLights(lights: Light[]): this {
    this.lights = lights;
    return this;
  }
}

type ShadowLight = Light & { shadow: LightShadow; isPointLight?: boolean; distance?: number };
type DrawGroup = { start: number; count: number; materialIndex?: number };
type IndexTexture = { version: number; image: { data: Uint32Array } };
type Batch = Object3D & { isBatchedMesh?: boolean; _multiDrawCount: number; _multiDrawCounts: Int32Array; _indirectTexture: IndexTexture };
type RenderObjectFunction = (
  object: Object3D,
  scene: Scene,
  camera: Camera,
  geometry: BufferGeometry,
  material: Material,
  group: DrawGroup | null,
  lightsNode: FakeLightsNode,
  clippingContext: unknown,
  passId: string | null,
) => void;

interface RenderItem {
  object: Object3D;
  geometry: BufferGeometry;
  material: Material;
  group: DrawGroup | null;
}
type PassKind = Pick<FakePass, 'kind' | 'light' | 'face'>;
interface RenderCall {
  kind: PassKind;
  pass: FakePass | null;
  /** WebGPU batch draws whose ids resolve when the call ends. */
  pending: Array<{ draw: FakeDraw; texture: IndexTexture; counts: number[] }>;
  /** WebGPU instanced draws whose rows resolve when the call ends. */
  pendingInstances: Array<{ draw: FakeDraw; read: InstanceReads; count: number }>;
}
type Instanced = Object3D & { isInstancedMesh?: boolean; count: number; instanceMatrix: BufferAttribute; instanceColor: BufferAttribute | null };
/** How to read the matrix rows and colour rows a draw binds, at draw time (WebGL) or when its render() call ends (WebGPU). */
interface InstanceReads {
  rows: () => Float32Array;
  colors: (() => Float32Array) | null;
}
/** A RenderObject of an InstancedMesh with its NodeBuilderState (three keys both by object, material and render context). */
interface InstanceRenderObject {
  /** `instanceMatrix.version` at the last refresh (NodeMaterialObserver). */
  version: number;
  /** `instanceColor.version` at the last refresh, null without colours. */
  colorVersion: number | null;
  /** frameId when its OnBeforeFrameUpdate event last ran. */
  frame: number;
  /** The uniform buffer of the uniform path. */
  buffer: Float32Array | null;
  /** Whether Geometries.updateAttribute has checked its attribute once (the first check is not keyed by the render call). */
  checked: boolean;
}
/** Instance.js's InstancedInterleavedBuffer over `instanceMatrix` (or its InstancedBufferAttribute over `instanceColor`), and its GPU buffer. */
interface InstanceVertexBuffer {
  version: number;
  ranges: { start: number; count: number }[];
  /** The version uploaded last; -1 before the buffer exists. */
  uploaded: number;
  /** `info.render.calls` of the last upload check. */
  call: number;
  data: Float32Array;
}

const _position = new Vector3();
const _target = new Vector3();

export class FakeRenderer {
  readonly info = { render: { drawCalls: 0, triangles: 0, calls: 0, frameCalls: 0 }, memory: { programs: 0 } };
  readonly backend: { isWebGPUBackend?: boolean; hasFeature(name: string): boolean; capabilities: { getUniformBufferLimit(): number } };
  readonly coordinateSystem: CoordinateSystem = WebGLCoordinateSystem;
  readonly outputQuad: Mesh;
  /** `enabled` starts true when `shadowLight` or `shadowLights` is set (three's own default is false). */
  readonly shadowMap: { enabled: boolean; type: ShadowMapType };
  readonly shadowLights: Light[];
  /** What getDrawingBufferSize() reports: three's default 300x150 canvas at pixel ratio 1. */
  readonly drawingBufferSize = new Vector2(300, 150);
  /** With `record`: the render() calls of the last frame, in the order they started. Reset by every outermost render(). */
  passes: FakePass[] = [];
  /** +1 at the start of every outermost render(): the fake's NodeFrame.frameId (three advances it once per animation frame). */
  frameId = 0;
  renderTarget: object | null = null;
  /** Renderer.opaque and Renderer.transparent: whether render() draws the opaque list and the transparent lists. */
  opaque = true;
  transparent = true;
  /** Renderer.autoClear and autoClearColor: stored only (the fake draws no pixels). */
  autoClear = true;
  autoClearColor = true;
  /**
   * Renderer._getFrameBufferTarget: the target a render with no render target draws into (three's defaults, an sRGB
   * output colour space, need one) and that the scene hooks receive. The output quad then resolves it to the canvas.
   */
  readonly frameBufferTarget = { isPostProcessingRenderTarget: true };
  /** Renderer.lighting: `getNode(scene)` is the lights node of that root (Lighting.getNode), holding the lights of its current render. */
  readonly lighting: { getNode(scene: Object3D): { getLights(): Light[] } } = { getNode: (scene) => this.lightsNodeFor(scene) };

  private readonly options: FakeRendererOptions;
  private readonly instanceObjects = new Map<string, InstanceRenderObject>();
  private readonly instanceBuffers = new WeakMap<BufferAttribute, InstanceVertexBuffer>();
  /** ShadowBaseNode's shadow material, flagged so renderObject derives the shadow side for it. */
  private readonly shadowMaterial = Object.assign(new MeshDepthMaterial(), { isShadowPassMaterial: true });
  private readonly internalScene = new Scene();
  private readonly defaultLights = new FakeLightsNode();
  private readonly lightsNodes = new WeakMap<Object3D, FakeLightsNode>();
  /** ShadowNode._cameraFrameId per light. */
  private readonly shadowFrames = new WeakMap<Light, Map<Camera, number>>();
  /** The GPU copy of each batch index texture. */
  private readonly uploads = new WeakMap<IndexTexture, { version: number; data: Uint32Array }>();
  private readonly vsmQuad: Mesh;
  private readonly vsmCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly vsmMaterials: Material[];
  private renderObjectFunction: RenderObjectFunction | null = null;
  private activeCubeFace = 0;
  private activeMipmapLevel = 0;
  private mrt: unknown = null;
  private readonly clearColor = new Color(0, 0, 0);
  private clearAlpha = 1;
  private nextPass: PassKind | null = null;
  private readonly calls: RenderCall[] = [];

  constructor(options: FakeRendererOptions = {}) {
    this.options = options;
    const multiDraw = options.multiDraw ?? true;
    // WebGPUCapabilities / WebGLCapabilities.getUniformBufferLimit, which NodeBuilder.getUniformBufferLimit reads.
    const capabilities = { getUniformBufferLimit: () => options.uniformBufferLimit ?? 65536 };
    this.backend = options.webgpu
      ? { isWebGPUBackend: true, hasFeature: () => false, capabilities }
      : { hasFeature: (name: string) => name === 'WEBGL_multi_draw' && multiDraw, capabilities };
    this.shadowLights = [...(options.shadowLight ? [options.shadowLight] : []), ...(options.shadowLights ?? [])];
    this.shadowMap = { enabled: this.shadowLights.length > 0, type: PCFShadowMap };
    // QuadMesh's shared QuadGeometry: one fullscreen triangle.
    const triangle = new BufferGeometry();
    triangle.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    // Like three's "Output Color Transform" QuadMesh (Renderer._renderOutput): rendered every frame, never part of the user scene.
    this.outputQuad = Object.assign(new Mesh(triangle, new Material()), { isQuadMesh: true });
    this.outputQuad.name = 'Output Color Transform';
    // ShadowNode.vsmPass draws a QuadMesh with each blur material.
    this.vsmQuad = Object.assign(new Mesh(triangle, new Material()), { isQuadMesh: true });
    this.vsmMaterials = ['VSMVertical', 'VSMHorizontal'].map((name) => Object.assign(new Material(), { name }));
  }

  getRenderTarget(): object | null {
    return this.renderTarget;
  }

  setRenderTarget(target: object | null, activeCubeFace = 0, activeMipmapLevel = 0): void {
    this.renderTarget = target;
    this.activeCubeFace = activeCubeFace;
    this.activeMipmapLevel = activeMipmapLevel;
  }

  getActiveCubeFace(): number {
    return this.activeCubeFace;
  }

  getActiveMipmapLevel(): number {
    return this.activeMipmapLevel;
  }

  /** Renderer.setMRT / getMRT: stored only. */
  setMRT(mrt: unknown): this {
    this.mrt = mrt;
    return this;
  }

  getMRT(): unknown {
    return this.mrt;
  }

  /** Renderer.setRenderObjectFunction: render() calls it for every item of its lists instead of renderObject. */
  setRenderObjectFunction(fn: RenderObjectFunction | null): void {
    this.renderObjectFunction = fn;
  }

  getRenderObjectFunction(): RenderObjectFunction | null {
    return this.renderObjectFunction;
  }

  getClearColor(target: Color): Color {
    return target.copy(this.clearColor);
  }

  setClearColor(color: Color, alpha = 1): void {
    this.clearColor.copy(color);
    this.clearAlpha = alpha;
  }

  getClearAlpha(): number {
    return this.clearAlpha;
  }

  /** Renderer.readRenderTargetPixelsAsync on a half-float target: raw halves, all zero (the fake draws no pixels). */
  async readRenderTargetPixelsAsync(_target: object, _x: number, _y: number, width: number, height: number): Promise<Uint16Array> {
    return new Uint16Array(width * height * 4);
  }

  getDrawingBufferSize(target: Vector2): Vector2 {
    return target.copy(this.drawingBufferSize).floor();
  }

  /** Renderer.init: the fake backend is ready at once. */
  async init(): Promise<this> {
    return this;
  }

  /** Renderer.renderAsync (deprecated since r181): `await this.init(); this.render(scene, camera);`. */
  async renderAsync(scene: Object3D, camera: Camera): Promise<void> {
    await this.init();
    this.render(scene, camera);
  }

  render(scene: Object3D, camera: Camera): void {
    this.info.render.calls++;
    if (this.calls.length === 0) {
      this.frameId++;
      if (this.options.record) this.passes = [];
    }
    const kind: PassKind = this.nextPass ?? { kind: 'render', light: null, face: null };
    this.nextPass = null;
    const root = scene as Scene;
    const sceneRef = root.isScene === true ? root : this.internalScene;
    const renderObjectFunction = this.renderObjectFunction;
    const lightsNode = this.lightsNodeFor(scene);
    const previousLights = lightsNode.getLights();
    // Renderer._renderScene: with no render target the pass draws into the frame-buffer target; both scene hooks get it.
    const hookTarget = this.renderTarget ?? this.frameBufferTarget;
    const call: RenderCall = { kind, pass: null, pending: [], pendingInstances: [] };
    if (this.options.record) {
      call.pass = {
        ...kind,
        depth: this.calls.length,
        frameId: this.frameId,
        scene,
        camera,
        projectionMatrix: camera.projectionMatrix.clone(),
        matrixWorldInverse: camera.matrixWorldInverse.clone(),
        renderTarget: this.renderTarget,
        draws: [],
      };
      this.passes.push(call.pass);
    }
    this.calls.push(call);
    if (this.options.sceneHooks) (sceneRef.onBeforeRender as (...args: unknown[]) => void)(this, scene, camera, hookTarget);

    // Renderer._projectObject into the render list: a hidden object returns before its children, so it hides its whole
    // subtree; the camera's layers gate the object itself only, and its children are still projected.
    const opaque: RenderItem[] = [];
    const transparent: RenderItem[] = [];
    const doublePass: RenderItem[] = [];
    const lights: Light[] = [];
    const project = (object: Object3D): void => {
      if (!object.visible) return;
      if (object.layers.test(camera.layers)) this.projectItem(object, lights, opaque, transparent, doublePass);
      const children = object.children;
      for (let i = 0; i < children.length; i++) project(children[i]!);
    };
    project(scene);
    lightsNode.setLights(lights);
    const plainScene = sceneRef === root && root.overrideMaterial === null;
    if (this.options.shadowTrigger === undefined && plainScene) this.updateShadows(root, camera, lightsNode);

    const renderList = (items: RenderItem[], passId: string | null) => {
      for (const { object, geometry, material, group } of items) {
        // Renderer._renderObjects calls it as a renderer method (`this._currentRenderObjectFunction( ... )`).
        if (renderObjectFunction) renderObjectFunction.call(this, object, sceneRef, camera, geometry, material, group, lightsNode, null, passId);
        else this.renderObject(object, sceneRef, camera, geometry, material, group, lightsNode, null, passId);
      }
    };
    if (this.opaque) renderList(opaque, null);
    if (!this.transparent) {
      // Renderer._renderScene skips _renderTransparents, the back-side pass included.
    } else if (doublePass.length > 0) {
      // Renderer._renderTransparents: the side is set on the material before each renderObject call.
      for (const { material } of doublePass) material.side = BackSide;
      renderList(doublePass, 'backSide');
      for (const { material } of doublePass) material.side = FrontSide;
      renderList(transparent, null);
      for (const { material } of doublePass) material.side = DoubleSide;
    } else {
      renderList(transparent, null);
    }
    if (plainScene) {
      this.renderObject(this.outputQuad, root, camera, this.outputQuad.geometry, this.outputQuad.material as Material, null, this.defaultLights, null, null);
    }

    // Backend.finishRender: WebGPU submits the pass now, so its batch draws read the index textures as uploaded by now.
    for (const { draw, texture, counts } of call.pending) draw.batchIds = slotIds(counts, this.uploads.get(texture)!.data);
    for (const { draw, read, count } of call.pendingInstances) {
      draw.instanceRows = read.rows().slice(0, count * 16);
      if (read.colors !== null) draw.instanceColorRows = read.colors().slice(0, count * 3);
    }
    lightsNode.setLights(previousLights);
    this.calls.pop();
    (sceneRef.onAfterRender as (...args: unknown[]) => void)(this, scene, camera, hookTarget);
  }

  renderObject(
    object: Object3D,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    group: DrawGroup | null,
    lightsNode: FakeLightsNode | null,
    _clippingContext: unknown = null,
    _passId: string | null = null, // three's 'backSide' pass id only keys its render-object cache
  ): void {
    object.onBeforeRender(this as never, scene, camera, geometry, material, group as never);
    const overrideMaterial = material.allowOverride === true ? scene.overrideMaterial : null;
    let overrideSide: Side = FrontSide;
    if (overrideMaterial !== null) {
      overrideSide = overrideMaterial.side;
      overrideMaterial.transparent = overrideTransparent(material);
      if ((overrideMaterial as Material & { isShadowPassMaterial?: boolean }).isShadowPassMaterial) {
        overrideMaterial.side = shadowPassSide(material, this.shadowMap.type === VSMShadowMap);
      }
      material = overrideMaterial;
    }
    if (material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false) {
      material.side = BackSide;
      this.drawObject(object, material, scene, camera, lightsNode, group);
      material.side = FrontSide;
      this.drawObject(object, material, scene, camera, lightsNode, group);
      material.side = DoubleSide;
    } else {
      this.drawObject(object, material, scene, camera, lightsNode, group);
    }
    if (overrideMaterial !== null) overrideMaterial.side = overrideSide; // `transparent` is not restored, as in three
    object.onAfterRender(this as never, scene, camera, geometry, material, group as never);
  }

  /** Renderer._renderObjectDirect and the backend's draw: the shadow maps a receiver needs, uploads, then the draw. */
  private drawObject(object: Object3D, material: Material, scene: Scene, camera: Camera, lightsNode: FakeLightsNode | null, group: DrawGroup | null): void {
    const call = this.calls[this.calls.length - 1];
    // NodeMaterialObserver.needsRefresh decides the refresh before any updateBefore node runs.
    const instances = this.options.record && (object as Instanced).isInstancedMesh === true && call ? this.instanceRenderObject(object as Instanced, material, call) : null;
    // NodeManager.updateBefore runs the render object's updateBeforeNodes in order. The instance OnBeforeFrameUpdate event
    // sits in the position stack, which NodeBuilder.build flows before its fragment/vertex loop (NodeBuilder.js ~3193)
    // and Node.build registers in the setup branch, so it runs before a receiver's ShadowNode (dumped from three r186 on
    // both backends: ['EventNode:beforeFrame', 'ShadowNode']).
    if (instances) this.syncInstances(object as Instanced, instances.state);
    // Then a receiver's ShadowNode renders its map before this object draws.
    const shadowPass = (material as Material & { isShadowPassMaterial?: boolean }).isShadowPassMaterial === true;
    if (this.options.shadowTrigger === 'first-receiver' && object.receiveShadow && lightsNode !== null && !shadowPass) {
      this.updateShadows(scene, camera, lightsNode);
    }
    // Then Geometries.updateForRender and Bindings.updateForRender.
    const readInstances = instances ? this.uploadInstances(object as Instanced, instances.state, instances.full) : null;
    const params = drawParameters(object, material, group);
    if (params === null) return;
    let drawCalls = 1;
    let triangles = trianglesOf(object, params.vertexCount, params.instanceCount);
    let counts: number[] | null = null;
    const batch = object as Batch;
    if (batch.isBatchedMesh) {
      counts = Array.from(batch._multiDrawCounts.subarray(0, batch._multiDrawCount));
      const multiDraw = !this.backend.isWebGPUBackend && this.backend.hasFeature('WEBGL_multi_draw');
      drawCalls = multiDraw ? Math.min(counts.length, 1) : counts.length;
      triangles = trianglesOf(object, counts.reduce((sum, c) => sum + c, 0), 1);
    }
    this.info.render.drawCalls += drawCalls;
    this.info.render.triangles += triangles;
    if (!call?.pass) return;
    const draw: FakeDraw = { object, material, side: material.side, drawCalls, triangles, instanceCount: params.instanceCount, batchIds: null, instanceRows: null, instanceColorRows: null };
    call.pass.draws.push(draw);
    if (readInstances !== null) {
      if (this.backend.isWebGPUBackend) {
        call.pendingInstances.push({ draw, read: readInstances, count: params.instanceCount });
      } else {
        draw.instanceRows = readInstances.rows().slice(0, params.instanceCount * 16);
        if (readInstances.colors !== null) draw.instanceColorRows = readInstances.colors().slice(0, params.instanceCount * 3);
      }
      return;
    }
    if (counts === null) return;
    // Bindings.updateForRender: the index texture uploads when its version changed since the last upload.
    const texture = batch._indirectTexture;
    let upload = this.uploads.get(texture);
    if (!upload || upload.version !== texture.version) {
      upload = { version: texture.version, data: texture.image.data.slice() };
      this.uploads.set(texture, upload);
    }
    if (this.backend.isWebGPUBackend) call.pending.push({ draw, texture, counts });
    else draw.batchIds = slotIds(counts, upload.data);
  }

  /**
   * The render object of an InstancedMesh draw and whether it refreshes in full (NodeMaterialObserver: the first draw, or
   * `instanceMatrix.version` changed since its last refresh). three keys it by object, material and render context (the
   * target's attachments and the call depth); a shadow map's override material is one per light
   * (ShadowBaseNode `_shadowMaterialLib`), where the fake shares one, so the light is part of the key.
   */
  private instanceRenderObject(mesh: Instanced, material: Material, call: RenderCall): { state: InstanceRenderObject; full: boolean } {
    const target = this.renderTarget as { texture?: { name?: string } } | null;
    const key = `${mesh.uuid}|${material.uuid}|${call.kind.light?.uuid ?? ''}|${this.calls.length - 1}|${target?.texture?.name ?? 'default'}`;
    let state = this.instanceObjects.get(key);
    const colorVersion = mesh.instanceColor === null ? null : mesh.instanceColor.version;
    const full = state === undefined || state.version !== mesh.instanceMatrix.version || state.colorVersion !== colorVersion;
    if (state === undefined) {
      state = { version: 0, colorVersion: null, frame: -1, buffer: null, checked: false };
      this.instanceObjects.set(key, state);
    }
    state.version = mesh.instanceMatrix.version;
    state.colorVersion = colorVersion;
    return { state, full };
  }

  /** Instance.js: matrices above `uniformBufferLimit` bytes go to the shared vertex buffer instead of a uniform buffer per render object. */
  private instanceVertexPath(mesh: Instanced): boolean {
    return mesh.instanceMatrix.count * 64 > (this.options.uniformBufferLimit ?? 65536);
  }

  private instanceBuffer(attribute: BufferAttribute): InstanceVertexBuffer {
    let gpu = this.instanceBuffers.get(attribute);
    if (gpu === undefined) {
      gpu = { version: 0, ranges: [], uploaded: -1, call: -1, data: new Float32Array(attribute.array.length) };
      this.instanceBuffers.set(attribute, gpu);
    }
    return gpu;
  }

  /**
   * Instance.js's OnBeforeFrameUpdate event, which exists when the matrices use the vertex buffer or the mesh has
   * colours: once per frame per node builder it copies each shared buffer's version and update ranges from its source
   * attribute (replacing the ranges the buffer held) and clears the source's ranges.
   */
  private syncInstances(mesh: Instanced, state: InstanceRenderObject): void {
    const vertexPath = this.instanceVertexPath(mesh);
    if ((!vertexPath && mesh.instanceColor === null) || state.frame === this.frameId) return;
    state.frame = this.frameId;
    for (const attribute of [vertexPath ? mesh.instanceMatrix : null, mesh.instanceColor]) {
      if (attribute === null) continue;
      const gpu = this.instanceBuffer(attribute);
      if (gpu.version === attribute.version) continue;
      gpu.ranges = attribute.updateRanges.map((range) => ({ start: range.start, count: range.count }));
      attribute.clearUpdateRanges();
      gpu.version = attribute.version;
    }
  }

  /**
   * Geometries.updateForRender and Bindings.updateForRender for the instance attributes (`nodes/accessors/Instance.js`);
   * returns how to read the buffers the draw binds.
   * - Matrices up to `uniformBufferLimit` bytes: a uniform buffer per render object (objectGroup bindings are cloned per
   *   render object, NodeBuilderState.createBindings), written from the array on a full refresh.
   * - Matrices above it: the InstancedInterleavedBuffer, one GPU buffer for every render object. On a full refresh
   *   Geometries.updateAttribute uploads when the GPU copy is older than the synced version: the ranges, or the whole
   *   array when there are none (WebGPUAttributeUtils.updateAttribute). After a render object's first check of its
   *   interleaved attribute, the shared buffer is checked at most once per `info.render.calls`, which every render()
   *   advances and nothing restores after a nested one.
   * - Divergence, on the strict side: three's Attributes.update keeps `data.version` per attribute object, and each render
   *   object builds its own interleaved attributes over the shared buffer, so another render object that refreshes
   *   later uploads again, with the ranges already consumed: the whole array (a second shadow light does). The fake keeps
   *   one uploaded version per buffer, so it never re-uploads rows that way and never hides a lost range.
   * - Colours: one InstancedBufferAttribute shared by every render object, checked at most once per render call.
   */
  private uploadInstances(mesh: Instanced, state: InstanceRenderObject, full: boolean): InstanceReads {
    const matrices = mesh.instanceMatrix;
    let rows: () => Float32Array;
    if (!this.instanceVertexPath(mesh)) {
      if (full || state.buffer === null) state.buffer = (matrices.array as Float32Array).slice();
      rows = () => state.buffer!;
    } else {
      const gpu = this.instanceBuffer(matrices);
      if (full && (!state.checked || gpu.call !== this.info.render.calls)) {
        if (state.checked) gpu.call = this.info.render.calls;
        state.checked = true;
        this.uploadInstanceBuffer(gpu, matrices);
      }
      const data = gpu.data;
      rows = () => data;
    }
    let colors: (() => Float32Array) | null = null;
    if (mesh.instanceColor !== null) {
      const gpu = this.instanceBuffer(mesh.instanceColor);
      if (full && gpu.call !== this.info.render.calls) {
        gpu.call = this.info.render.calls;
        this.uploadInstanceBuffer(gpu, mesh.instanceColor);
      }
      const data = gpu.data;
      colors = () => data;
    }
    return { rows, colors };
  }

  /** Attributes.update: creation uploads the whole array; later, a synced version newer than the upload writes the ranges, or everything without ranges. */
  private uploadInstanceBuffer(gpu: InstanceVertexBuffer, attribute: BufferAttribute): void {
    const array = attribute.array as Float32Array;
    if (gpu.uploaded < 0) {
      gpu.data.set(array);
      gpu.uploaded = gpu.version;
    } else if (gpu.uploaded < gpu.version) {
      if (gpu.ranges.length === 0) gpu.data.set(array);
      else for (const range of gpu.ranges) gpu.data.set(array.subarray(range.start, range.start + range.count), range.start);
      gpu.ranges = [];
      gpu.uploaded = gpu.version;
    }
  }

  /** One visible object the camera's layers see, pushed where Renderer._projectObject puts it: a light, or render items. */
  private projectItem(object: Object3D, lights: Light[], opaque: RenderItem[], transparent: RenderItem[], doublePass: RenderItem[]): void {
    if ((object as Light).isLight) {
      lights.push(object as Light);
      return;
    }
    const mesh = object as Mesh & { isPoints?: boolean; isSprite?: boolean; isLine?: boolean };
    if (!(mesh.isMesh || mesh.isPoints || mesh.isSprite || mesh.isLine)) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = mesh.isMesh && mesh.geometry.groups.length > 0 && Array.isArray(mesh.material) ? mesh.geometry.groups : [null];
    for (const group of groups) {
      const material = group ? materials[group.materialIndex ?? 0] : materials[0];
      if (!material) continue;
      const item = { object, geometry: mesh.geometry, material, group };
      if (!isTransparentItem(material)) opaque.push(item);
      else {
        if (needsDoublePass(material)) doublePass.push(item);
        transparent.push(item);
      }
    }
  }

  /** Lighting.getNode: one lights node per Scene or Group root; other roots share a default node. */
  private lightsNodeFor(root: Object3D): FakeLightsNode {
    if ((root as Scene).isScene !== true && (root as Group).isGroup !== true) return this.defaultLights;
    let node = this.lightsNodes.get(root);
    if (!node) {
      node = new FakeLightsNode();
      this.lightsNodes.set(root, node);
    }
    return node;
  }

  /** ShadowNode.updateBefore for every shadow light the render projected. */
  private updateShadows(scene: Scene, camera: Camera, lightsNode: FakeLightsNode): void {
    if (!this.shadowMap.enabled) return;
    const projected = lightsNode.getLights();
    for (const light of this.shadowLights as ShadowLight[]) {
      if (!light.castShadow || !light.shadow || !projected.includes(light)) continue;
      if (!(light.shadow.needsUpdate || light.shadow.autoUpdate)) continue;
      let frames = this.shadowFrames.get(light);
      if (!frames) {
        frames = new Map();
        this.shadowFrames.set(light, frames);
      }
      if (frames.get(camera) === this.frameId) continue;
      frames.set(camera, this.frameId);
      this.updateShadow(light, scene, camera);
      light.shadow.needsUpdate = false;
    }
  }

  /** ShadowNode.updateShadow: render the map with the shadow material and render-object function, then the VSM quads. */
  private updateShadow(light: ShadowLight, scene: Scene, camera: Camera): void {
    const shadow = light.shadow;
    // ShadowNode.setupShadow builds the light's map when a receiver's lighting first sets up and sets `shadow.map`
    // (ShadowNode.js ~529): a colour target with a depth texture (PointShadowNode.setupRenderTarget: a cube target and a
    // cube depth texture, two textures too). Built here as the map first renders.
    const built = shadow as unknown as { map: RenderTarget | null };
    if (!built.map) {
      built.map = new RenderTarget(shadow.mapSize.x, shadow.mapSize.y);
      built.map.depthTexture = new DepthTexture(shadow.mapSize.x, shadow.mapSize.y);
    }
    const vsm = this.shadowMap.type === VSMShadowMap;
    const layerMask = shadow.camera.layers.mask;
    if ((layerMask & 0xfffffffe) === 0) shadow.camera.layers.mask = camera.layers.mask;
    const saved = { renderTarget: this.renderTarget, overrideMaterial: scene.overrideMaterial, renderObjectFunction: this.renderObjectFunction };
    scene.overrideMaterial = this.shadowMaterial;
    this.renderObjectFunction = this.shadowRenderObjectFunction(shadow, vsm);
    this.renderTarget = { name: 'shadow', texture: { name: light.isPointLight ? 'PointShadowMap' : 'ShadowMap' } };
    if (light.isPointLight) {
      this.renderPointShadow(light, scene);
    } else {
      shadow.updateMatrices(light);
      this.renderPass({ kind: 'shadow', light, face: null }, scene, shadow.camera);
    }
    this.renderObjectFunction = saved.renderObjectFunction;
    if (vsm && !light.isPointLight && this.options.vsmQuad) {
      for (const material of this.vsmMaterials) {
        this.renderTarget = { texture: { name: '' } };
        this.vsmQuad.material = material;
        this.renderPass({ kind: 'vsm', light, face: null }, this.vsmQuad, this.vsmCamera);
      }
    }
    shadow.camera.layers.mask = layerMask;
    scene.overrideMaterial = saved.overrideMaterial;
    this.renderTarget = saved.renderTarget;
  }

  /** PointShadowNode.renderShadow: six renders with the same camera, re-aimed along each cube face. */
  private renderPointShadow(light: ShadowLight, scene: Scene): void {
    const shadow = light.shadow;
    const camera = shadow.camera as PerspectiveCamera;
    const faces = this.coordinateSystem === WebGPUCoordinateSystem ? CUBE_FACES_WEBGPU : CUBE_FACES_WEBGL;
    for (let face = 0; face < 6; face++) {
      const far = light.distance || camera.far;
      if (far !== camera.far) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
      _position.setFromMatrixPosition(light.matrixWorld);
      camera.position.copy(_position);
      camera.up.copy(faces.ups[face]!);
      camera.lookAt(_target.copy(_position).add(faces.directions[face]!));
      camera.updateMatrixWorld();
      shadow.matrix.makeTranslation(-_position.x, -_position.y, -_position.z);
      this.renderPass({ kind: 'shadow', light, face }, scene, camera);
    }
  }

  /** ShadowBaseNode's render-object function: casters only (and receivers under VSM), bracketed by the shadow hooks. */
  private shadowRenderObjectFunction(shadow: LightShadow, vsm: boolean): RenderObjectFunction {
    return (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
      if (object.castShadow !== true && !(object.receiveShadow && vsm)) return;
      const depthMaterial = scene.overrideMaterial as Material;
      // three passes the object where @types/three declares a scene.
      object.onBeforeShadow(this as never, object as never, camera, shadow.camera, geometry, depthMaterial, group as never);
      this.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
      object.onAfterShadow(this as never, object as never, camera, shadow.camera, geometry, depthMaterial, group as never);
    };
  }

  /** A nested render() of the given kind, through the (possibly patched) instance method, as three's nodes call it. */
  private renderPass(kind: PassKind, scene: Object3D, camera: Camera): void {
    this.nextPass = kind;
    this.render(scene, camera);
  }
}

/** A scene with a camera looking at the origin; helpers return meshes already added to the scene. */
export function sceneWithCamera(): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { scene, camera };
}

export function batchedOf(count: number, material: Material, geometry: BufferGeometry): BatchedMesh {
  const batch = new BatchedMesh(count, geometry.attributes.position!.count * count, (geometry.index?.count ?? 0) * count, material);
  const id = batch.addGeometry(geometry);
  for (let i = 0; i < count; i++) batch.addInstance(id);
  batch.name = `batch-${count}`;
  return batch;
}

export { Group, Scene, Mesh, Material };
