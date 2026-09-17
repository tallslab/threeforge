/**
 * A stand-in for three r186's common Renderer (`three/webgpu`) for node unit tests: the surface the ledger patches and
 * reads (render, renderAsync, renderObject, info, backend, shadowMap, lighting, getRenderTarget, getDrawingBufferSize)
 * and the state the overdraw measurement saves and sets (render target, MRT, render-object function, clear colour,
 * `autoClear`, `opaque`/`transparent`, read-backs). It follows three's source (node_modules/three/src) where that
 * decides what is drawn:
 * - Renderer._projectObject: a hidden object hides its subtree; the camera's layers gate each object alone.
 * - Renderer._renderScene: the render list in traversal order, opaque items first, then a back-side pass of transmissive
 *   double-sided items, then transparent items (insertion order: no sorting); the projected lights as renderObject's
 *   lights node; `scene.onAfterRender`, plus `scene.onBeforeRender` with `sceneHooks`, given the render's target. A
 *   render with no target set also draws the "Output Color Transform" quad (Renderer._renderOutput, one fullscreen
 *   triangle); a render into a target (a reflection, a count pass, a shadow map) draws none.
 * - Renderer.renderObject: the object hooks, the override copies (alphaTest, alphaMap, displacement, positionNode,
 *   `transparent`, the shadow side) and their restore, and two draws, BackSide then FrontSide, for a double-sided
 *   transparent material.
 * - RenderObject.getDrawParameters and the backends' Info.update: nothing for zero instances or an empty range; one draw
 *   per call, N per BatchedMesh on WebGPU or on WebGL without WEBGL_multi_draw; triangles = instances x count / 3
 *   (`fakeRendererRules.ts`). A BatchedMesh draw reads its index texture as last uploaded: at the draw on WebGL, when
 *   the render() call ends on WebGPU (the pass is submitted then).
 * - Shadow maps (`fakeShadows.ts`) and instance buffers (`fakeInstancing.ts`) are separate models this class drives.
 * Not modelled: frustum culling, sorting, matrix updates (call `scene.updateMatrixWorld()`), pipeline readiness,
 * `material.visible` (an invisible material still draws), array materials without groups on Lines and Points,
 * `LineLoop` (drawn as a line), a `first-receiver` trigger keyed on `receiveShadow` alone (three needs a lit node
 * material), and the frame-buffer target as the current target during a canvas render (a nested render with no
 * target of its own draws an extra output quad here). A test that depends on one of these must model it first.
 */
import {
  BackSide,
  BatchedMesh,
  BufferGeometry,
  type Camera,
  Color,
  type CoordinateSystem,
  DataUtils,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  type Light,
  Material,
  type Matrix4,
  Mesh,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  type ShadowMapType,
  type Side,
  type Texture,
  Vector2,
  VSMShadowMap,
  WebGLCoordinateSystem,
} from 'three';
import { FakeInstanceBuffers, type Instanced, type InstanceReads } from './fakeInstancing.js';
import {
  drawParameters,
  isTransparentItem,
  needsDoublePass,
  overrideTransparent,
  shadowPassSide,
  slotIds,
  trianglesOf,
} from './fakeRendererRules.js';
import { FakeShadowMaps, type ShadowHost } from './fakeShadows.js';

export interface FakeRendererOptions {
  webgpu?: boolean;
  multiDraw?: boolean;
  /** One shadow-casting light; the same as `shadowLights: [shadowLight]`. */
  shadowLight?: Light;
  /**
   * Lights whose shadow maps this renderer updates, like ShadowNode.updateBefore (see `FakeShadowMaps.update` for when a
   * map renders). A map renders the scene with a shadow-pass override material and `shadow.camera` (directional and
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
  /**
   * With `record`: fields of the drawn material copied into `FakeDraw.slots` as each draw is issued, for callers that
   * write per-draw slots on an override material and put them back after the draw (three's own override copies, the
   * overdraw count's).
   */
  materialSlots?: readonly string[];
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
  /** The material renderObject was given (the object's own); the same as `material` when no override applied. */
  source: Material;
  /** `material.side` when drawn: BackSide then FrontSide for the two draws of a double-sided transparent material. */
  side: Side;
  /** `FakeRendererOptions.materialSlots` of the drawn material when the draw was issued, else null. */
  slots: Record<string, unknown> | null;
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
   * per row, from the GPU buffer three r186 would bind (see `FakeInstanceBuffers.upload`). Read when the draw is issued
   * on WebGL, when its render() call ends on WebGPU (queue writes land at once; the pass is submitted then).
   */
  instanceRows: Float32Array | null;
  /** InstancedMesh draws with `instanceColor` only (with `record`), else null: the colour rows `[0, instanceCount)`, 3 floats per row, read like `instanceRows`. */
  instanceColorRows: Float32Array | null;
}

/** The renderer and scene settings a render() call started with, as Renderer._renderScene read them. */
export interface FakeRenderState {
  overrideMaterial: Material | null;
  background: unknown;
  backgroundNode: unknown;
  mrt: unknown;
  renderObjectFunction: RenderObjectFunction | null;
  /** getClearColor() and getClearAlpha(): [r, g, b, alpha]. */
  clearColor: [number, number, number, number];
  autoClear: boolean;
  autoClearColor: boolean;
  opaque: boolean;
  transparent: boolean;
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
  state: FakeRenderState;
  /** The light of a 'shadow' or 'vsm' pass, else null. */
  light: Light | null;
  /** The cube face (0..5) of a point light's 'shadow' pass, else null. */
  face: number | null;
  /** Draws in issue order, the output quad included. */
  draws: FakeDraw[];
}

/** LightsNode: the lights of the current render list (RenderList.finish), restored when a render ends (Lighting.finishRender). */
export class FakeLightsNode {
  private lights: Light[] = [];

  getLights(): Light[] {
    return this.lights;
  }

  setLights(lights: Light[]): this {
    this.lights = lights;
    return this;
  }
}

export type DrawGroup = { start: number; count: number; materialIndex?: number };
type IndexTexture = { version: number; image: { data: Uint32Array } };
type Batch = Object3D & {
  isBatchedMesh?: boolean;
  _multiDrawCount: number;
  _multiDrawCounts: Int32Array;
  _indirectTexture: IndexTexture;
};
export type RenderObjectFunction = (
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
export type PassKind = Pick<FakePass, 'kind' | 'light' | 'face'>;
interface RenderCall {
  kind: PassKind;
  pass: FakePass | null;
  /** WebGPU batch draws whose ids resolve when the call ends. */
  pending: Array<{ draw: FakeDraw; texture: IndexTexture; counts: number[] }>;
  /** WebGPU instanced draws whose rows resolve when the call ends. */
  pendingInstances: Array<{ draw: FakeDraw; read: InstanceReads; count: number }>;
}
/** The material fields Renderer.renderObject copies onto an override, and reads back, that the base type does not declare. */
type OverrideMaterial = Material & {
  isNodeMaterial?: boolean;
  isShadowPassMaterial?: boolean;
  colorNode?: unknown;
  depthNode?: unknown;
  positionNode?: { isNode?: boolean } | null;
  alphaMap?: Texture | null;
  displacementMap?: Texture | null;
  displacementScale?: number;
  displacementBias?: number;
};

export class FakeRenderer implements ShadowHost {
  readonly info = { render: { drawCalls: 0, triangles: 0, calls: 0, frameCalls: 0 }, memory: { programs: 0 } };
  readonly backend: {
    isWebGPUBackend?: boolean;
    hasFeature(name: string): boolean;
    capabilities: { getUniformBufferLimit(): number };
  };
  readonly coordinateSystem: CoordinateSystem = WebGLCoordinateSystem;
  readonly outputQuad: Mesh;
  /** `enabled` starts true when `shadowLight` or `shadowLights` is set (three's own default is false). */
  readonly shadowMap: { enabled: boolean; type: ShadowMapType };
  readonly shadowLights: Light[];
  /** What getDrawingBufferSize() reports: three's default 300x150 canvas at pixel ratio 1. */
  readonly drawingBufferSize = new Vector2(300, 150);
  /** The red channel of the next read-backs, one entry per readRenderTargetPixelsAsync call in order; past the end, 0. */
  readbacks: number[] = [];
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
  readonly lighting: { getNode(scene: Object3D): { getLights(): Light[] } } = {
    getNode: (scene) => this.lightsNodeFor(scene),
  };

  private readonly options: FakeRendererOptions;
  private readonly shadows: FakeShadowMaps;
  private readonly instancing: FakeInstanceBuffers;
  private readonly internalScene = new Scene();
  private readonly defaultLights = new FakeLightsNode();
  private readonly lightsNodes = new WeakMap<Object3D, FakeLightsNode>();
  /** The GPU copy of each batch index texture. */
  private readonly uploads = new WeakMap<IndexTexture, { version: number; data: Uint32Array }>();
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
    const uniformBufferLimit = options.uniformBufferLimit ?? 65536;
    // WebGPUCapabilities / WebGLCapabilities.getUniformBufferLimit, which NodeBuilder.getUniformBufferLimit reads.
    const capabilities = { getUniformBufferLimit: () => uniformBufferLimit };
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
    this.shadows = new FakeShadowMaps(this, triangle, options.vsmQuad === true);
    this.instancing = new FakeInstanceBuffers(uniformBufferLimit);
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

  /**
   * Renderer.readRenderTargetPixelsAsync on a half-float target: width x height RGBA raw halves, every red the next
   * entry of `readbacks` (0 past the end: the fake draws no pixels), so a caller decodes what the backends return.
   */
  async readRenderTargetPixelsAsync(
    _target: object,
    _x: number,
    _y: number,
    width: number,
    height: number,
  ): Promise<ArrayLike<number>> {
    const red = DataUtils.toHalfFloat(this.readbacks.shift() ?? 0);
    const px = new Uint16Array(width * height * 4);
    if (red !== 0) for (let i = 0; i < width * height; i++) px[i * 4] = red;
    return px;
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
    // Whether this call writes the output target, decided once at its start as _renderScene decides it: the quad of
    // Renderer._renderOutput is drawn only when _getFrameBufferTarget() returned one, which needs
    // `needsFrameBufferTarget` (Renderer.js:1563, :2609) — tone mapping, or a colour space other than the working one.
    // Both are read through `isOutputTarget` (:2686), so both are off whenever a render target is set. The root's type
    // and the scene's override material do not enter into it.
    const outputPass = this.renderTarget === null;
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
        state: {
          overrideMaterial: sceneRef.overrideMaterial,
          background: sceneRef.background,
          backgroundNode: (sceneRef as { backgroundNode?: unknown }).backgroundNode,
          mrt: this.mrt,
          renderObjectFunction,
          clearColor: [this.clearColor.r, this.clearColor.g, this.clearColor.b, this.clearAlpha],
          autoClear: this.autoClear,
          autoClearColor: this.autoClearColor,
          opaque: this.opaque,
          transparent: this.transparent,
        },
        draws: [],
      };
      this.passes.push(call.pass);
    }
    this.calls.push(call);
    if (this.options.sceneHooks)
      (sceneRef.onBeforeRender as (...args: unknown[]) => void)(this, scene, camera, hookTarget);

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
    if (this.options.shadowTrigger === undefined && plainScene) this.shadows.update(root, camera, lightsNode);

    const renderList = (items: RenderItem[], passId: string | null) => {
      for (const { object, geometry, material, group } of items) {
        // Renderer._renderObjects calls it as a renderer method (`this._currentRenderObjectFunction( ... )`).
        if (renderObjectFunction)
          renderObjectFunction.call(
            this,
            object,
            sceneRef,
            camera,
            geometry,
            material,
            group,
            lightsNode,
            null,
            passId,
          );
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
    if (outputPass) {
      // Renderer._renderOutput renders the quad as its own root (`_renderScene(quad, quad.camera, false)`), so it draws
      // against three's internal scene: the user scene's override material never reaches it, and, with the frame-buffer
      // target off for that call, it draws no output quad of its own.
      const override = sceneRef.overrideMaterial;
      sceneRef.overrideMaterial = null;
      this.renderObject(
        this.outputQuad,
        sceneRef,
        camera,
        this.outputQuad.geometry,
        this.outputQuad.material as Material,
        null,
        this.defaultLights,
        null,
        null,
      );
      sceneRef.overrideMaterial = override;
    }

    // Backend.finishRender: WebGPU submits the pass now, so its batch draws read the index textures as uploaded by now.
    for (const { draw, texture, counts } of call.pending)
      draw.batchIds = slotIds(counts, this.uploads.get(texture)!.data);
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
    const overrideMaterial = (
      material.allowOverride === true ? scene.overrideMaterial : null
    ) as OverrideMaterial | null;
    const source = material as OverrideMaterial;
    let saved: Pick<
      OverrideMaterial,
      'colorNode' | 'depthNode' | 'positionNode' | 'side' | 'displacementMap' | 'displacementScale' | 'displacementBias'
    > | null = null;
    if (overrideMaterial !== null) {
      // Renderer.renderObject (Renderer.js ~3729-3777): what it keeps of the override to put back after the draw, then the
      // copies from the drawn material. Not modelled: the shadow nodes `_getShadowNodes` copies for a shadow pass.
      saved = {
        colorNode: overrideMaterial.isNodeMaterial ? overrideMaterial.colorNode : null,
        depthNode: overrideMaterial.isNodeMaterial ? overrideMaterial.depthNode : null,
        positionNode: overrideMaterial.isNodeMaterial ? overrideMaterial.positionNode : null,
        side: overrideMaterial.side,
        displacementMap: overrideMaterial.displacementMap,
        displacementScale: overrideMaterial.displacementScale,
        displacementBias: overrideMaterial.displacementBias,
      };
      if (source.positionNode?.isNode) overrideMaterial.positionNode = source.positionNode;
      overrideMaterial.alphaTest = source.alphaTest;
      overrideMaterial.alphaMap = source.alphaMap;
      overrideMaterial.displacementMap = source.displacementMap;
      overrideMaterial.displacementScale = source.displacementScale;
      overrideMaterial.displacementBias = source.displacementBias;
      overrideMaterial.transparent = overrideTransparent(material);
      if (overrideMaterial.isShadowPassMaterial) {
        overrideMaterial.side = shadowPassSide(material, this.shadowMap.type === VSMShadowMap);
      }
      material = overrideMaterial;
    }
    if (material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false) {
      material.side = BackSide;
      this.drawObject(object, material, source, scene, camera, lightsNode, group);
      material.side = FrontSide;
      this.drawObject(object, material, source, scene, camera, lightsNode, group);
      material.side = DoubleSide;
    } else {
      this.drawObject(object, material, source, scene, camera, lightsNode, group);
    }
    if (saved !== null) {
      // Renderer.js ~3803-3809 writes the restore to `scene.overrideMaterial` as it is then (its caller may have swapped
      // the override), outside any finally; `transparent`, `alphaTest` and `alphaMap` are not put back, as in three.
      const restored = (scene.overrideMaterial ?? overrideMaterial) as OverrideMaterial;
      restored.colorNode = saved.colorNode;
      restored.depthNode = saved.depthNode;
      restored.positionNode = saved.positionNode;
      restored.side = saved.side;
      restored.displacementMap = saved.displacementMap;
      restored.displacementScale = saved.displacementScale;
      restored.displacementBias = saved.displacementBias;
    }
    object.onAfterRender(this as never, scene, camera, geometry, material, group as never);
  }

  /** A nested render() of the given kind, through the (possibly patched) instance method, as three's nodes call it. */
  renderPass(kind: PassKind, scene: Object3D, camera: Camera): void {
    this.nextPass = kind;
    this.render(scene, camera);
  }

  /** Renderer._renderObjectDirect and the backend's draw: the shadow maps a receiver needs, uploads, then the draw. */
  private drawObject(
    object: Object3D,
    material: Material,
    source: Material,
    scene: Scene,
    camera: Camera,
    lightsNode: FakeLightsNode | null,
    group: DrawGroup | null,
  ): void {
    const call = this.calls[this.calls.length - 1];
    // NodeMaterialObserver.needsRefresh decides the refresh before any updateBefore node runs. three keys the render
    // object by object, material and render context (the target's attachments and the call depth); the pass's light
    // stands in for the per-light shadow material the fake shares.
    const target = this.renderTarget as { texture?: { name?: string } } | null;
    const instances =
      this.options.record && (object as Instanced).isInstancedMesh === true && call
        ? this.instancing.renderObject(
            object as Instanced,
            material,
            `${call.kind.light?.uuid ?? ''}|${this.calls.length - 1}|${target?.texture?.name ?? 'default'}`,
          )
        : null;
    // NodeManager.updateBefore runs the render object's updateBeforeNodes in order. The instance OnBeforeFrameUpdate event
    // sits in the position stack, which NodeBuilder.build flows before its fragment/vertex loop (NodeBuilder.js ~3193)
    // and Node.build registers in the setup branch, so it runs before a receiver's ShadowNode (dumped from three r186 on
    // both backends: ['EventNode:beforeFrame', 'ShadowNode']).
    if (instances) this.instancing.sync(object as Instanced, instances.state, this.frameId);
    // Then a receiver's ShadowNode renders its map before this object draws.
    const shadowPass = (material as OverrideMaterial).isShadowPassMaterial === true;
    if (this.options.shadowTrigger === 'first-receiver' && object.receiveShadow && lightsNode !== null && !shadowPass) {
      this.shadows.update(scene, camera, lightsNode);
    }
    // Then Geometries.updateForRender and Bindings.updateForRender.
    const readInstances = instances
      ? this.instancing.upload(object as Instanced, instances.state, instances.full, this.info.render.calls)
      : null;
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
      triangles = trianglesOf(
        object,
        counts.reduce((sum, c) => sum + c, 0),
        1,
      );
    }
    this.info.render.drawCalls += drawCalls;
    this.info.render.triangles += triangles;
    if (!call?.pass) return;
    const slotNames = this.options.materialSlots;
    const draw: FakeDraw = {
      object,
      material,
      source,
      side: material.side,
      slots: slotNames
        ? Object.fromEntries(slotNames.map((name) => [name, (material as unknown as Record<string, unknown>)[name]]))
        : null,
      drawCalls,
      triangles,
      instanceCount: params.instanceCount,
      batchIds: null,
      instanceRows: null,
      instanceColorRows: null,
    };
    call.pass.draws.push(draw);
    if (readInstances !== null) {
      if (this.backend.isWebGPUBackend) {
        call.pendingInstances.push({ draw, read: readInstances, count: params.instanceCount });
      } else {
        draw.instanceRows = readInstances.rows().slice(0, params.instanceCount * 16);
        if (readInstances.colors !== null)
          draw.instanceColorRows = readInstances.colors().slice(0, params.instanceCount * 3);
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

  /** One visible object the camera's layers see, pushed where Renderer._projectObject puts it: a light, or render items. */
  private projectItem(
    object: Object3D,
    lights: Light[],
    opaque: RenderItem[],
    transparent: RenderItem[],
    doublePass: RenderItem[],
  ): void {
    if ((object as Light).isLight) {
      lights.push(object as Light);
      return;
    }
    const mesh = object as Mesh & { isPoints?: boolean; isSprite?: boolean; isLine?: boolean };
    if (!(mesh.isMesh || mesh.isPoints || mesh.isSprite || mesh.isLine)) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups =
      mesh.isMesh && mesh.geometry.groups.length > 0 && Array.isArray(mesh.material) ? mesh.geometry.groups : [null];
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
  const batch = new BatchedMesh(
    count,
    geometry.attributes.position!.count * count,
    (geometry.index?.count ?? 0) * count,
    material,
  );
  const id = batch.addGeometry(geometry);
  for (let i = 0; i < count; i++) batch.addInstance(id);
  batch.name = `batch-${count}`;
  return batch;
}

export { Group, Material, Mesh, Scene };
