/**
 * A stand-in for three r186's common Renderer (`three/webgpu`) for node unit tests. It exposes the surface the ledger
 * patches and reads (render, renderAsync, renderObject, info, backend, shadowMap, getRenderTarget,
 * getDrawingBufferSize) and follows three's source where it decides what is drawn:
 * - Renderer._renderScene: the render list in traversal order, opaque items first, then a back-side pass of transmissive
 *   double-sided items, then transparent items (three also sorts each list; tests control order by insertion); the
 *   lights node of the projected lights as renderObject's argument 7; `scene.onAfterRender`, plus
 *   `scene.onBeforeRender` with `sceneHooks`. Non-Scene roots (quads) use an internal scene, like three's `_scene`.
 * - Renderer.renderObject: object hooks around the call, the override copy (`transparent`, the shadow side, restored
 *   side) and two draws, BackSide then FrontSide, for double-sided transparent materials.
 * - RenderObject.getDrawParameters and the backends' Info.update: nothing for zero instances or an empty range; one
 *   draw per call, N per BatchedMesh on WebGPU or on WebGL without WEBGL_multi_draw; triangles = instances x count / 3.
 * - ShadowNode and PointShadowNode: shadow maps per light (see `shadowLights`), six faces per point light, VSM quads.
 * Every Scene render without an override material also draws an "Output Color Transform" quad, like three's output
 * pass. Not modelled: frustum culling, sorting, matrix updates (call `scene.updateMatrixWorld()`), pipeline readiness.
 */
import {
  BackSide,
  BatchedMesh,
  BufferGeometry,
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
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
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
  /** Call `scene.onBeforeRender(renderer, scene, camera, renderTarget)` at the start of every render() call, as three does. */
  sceneHooks?: boolean;
  /** Record the render() calls and draws of the last frame in `renderer.passes` (see FakePass). */
  record?: boolean;
  /** With `renderer.shadowMap.type === VSMShadowMap`, render the two blur quads after each non-point map (ShadowNode.vsmPass). */
  vsmQuad?: boolean;
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
  pass: FakePass | null;
  /** WebGPU batch draws whose ids resolve when the call ends. */
  pending: Array<{ draw: FakeDraw; texture: IndexTexture; counts: number[] }>;
}

const _position = new Vector3();
const _target = new Vector3();

export class FakeRenderer {
  readonly info = { render: { drawCalls: 0, triangles: 0, calls: 0, frameCalls: 0 }, memory: { programs: 0 } };
  readonly backend: { isWebGPUBackend?: boolean; hasFeature(name: string): boolean };
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

  private readonly options: FakeRendererOptions;
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
  private nextPass: PassKind | null = null;
  private readonly calls: RenderCall[] = [];

  constructor(options: FakeRendererOptions = {}) {
    this.options = options;
    const multiDraw = options.multiDraw ?? true;
    this.backend = options.webgpu
      ? { isWebGPUBackend: true, hasFeature: () => false }
      : { hasFeature: (name: string) => name === 'WEBGL_multi_draw' && multiDraw };
    this.shadowLights = [...(options.shadowLight ? [options.shadowLight] : []), ...(options.shadowLights ?? [])];
    this.shadowMap = { enabled: this.shadowLights.length > 0, type: PCFShadowMap };
    // Like three's "Output Color Transform" quad: rendered every frame, never part of the user scene.
    this.outputQuad = new Mesh(new PlaneGeometry(2, 2), new Material());
    this.outputQuad.name = 'Output Color Transform';
    // ShadowNode.vsmPass draws a QuadMesh (one fullscreen triangle) with each blur material.
    const triangle = new BufferGeometry();
    triangle.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    this.vsmQuad = Object.assign(new Mesh(triangle, new Material()), { isQuadMesh: true });
    this.vsmMaterials = ['VSMVertical', 'VSMHorizontal'].map((name) => Object.assign(new Material(), { name }));
  }

  getRenderTarget(): object | null {
    return this.renderTarget;
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
    const call: RenderCall = { pass: null, pending: [] };
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
    if (this.options.sceneHooks) (sceneRef.onBeforeRender as (...args: unknown[]) => void)(this, scene, camera, this.renderTarget);

    // Renderer._projectObject into the render list.
    const opaque: RenderItem[] = [];
    const transparent: RenderItem[] = [];
    const doublePass: RenderItem[] = [];
    const lights: Light[] = [];
    scene.traverse((object) => {
      if (!object.visible || !object.layers.test(camera.layers)) return;
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
    });
    lightsNode.setLights(lights);
    const plainScene = sceneRef === root && root.overrideMaterial === null;
    if (this.options.shadowTrigger === undefined && plainScene) this.updateShadows(root, camera, lightsNode);

    const renderList = (items: RenderItem[], passId: string | null) => {
      for (const { object, geometry, material, group } of items) {
        if (renderObjectFunction) renderObjectFunction(object, sceneRef, camera, geometry, material, group, lightsNode, null, passId);
        else this.renderObject(object, sceneRef, camera, geometry, material, group, lightsNode, null, passId);
      }
    };
    renderList(opaque, null);
    if (doublePass.length > 0) {
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
    lightsNode.setLights(previousLights);
    this.calls.pop();
    (sceneRef.onAfterRender as (...args: unknown[]) => void)(this, scene, camera, this.renderTarget);
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
    // NodeManager.updateBefore: a receiver's ShadowNode renders its map before this object draws.
    const shadowPass = (material as Material & { isShadowPassMaterial?: boolean }).isShadowPassMaterial === true;
    if (this.options.shadowTrigger === 'first-receiver' && object.receiveShadow && lightsNode !== null && !shadowPass) {
      this.updateShadows(scene, camera, lightsNode);
    }
    const params = drawParameters(object, material, group);
    if (params === null) return;
    const call = this.calls[this.calls.length - 1];
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
    const draw: FakeDraw = { object, material, side: material.side, drawCalls, triangles, instanceCount: params.instanceCount, batchIds: null };
    call.pass.draws.push(draw);
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
