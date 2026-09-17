/**
 * The fake renderer's shadow maps, after three r186's ShadowNode and PointShadowNode (`nodes/lighting/`): when a
 * light's map renders (ShadowNode.updateBefore), what it draws (ShadowBaseNode's render-object function: casters, plus
 * receivers under VSM), the six faces of a point light (PointShadowNode.renderShadow) and the VSM blur quads
 * (ShadowNode.vsmPass). Each map is a nested render() of the host, so a ledger patched onto it sees the pass.
 */
import {
  type BufferGeometry,
  type Camera,
  type CoordinateSystem,
  DepthTexture,
  type Light,
  type LightShadow,
  Material,
  Mesh,
  MeshDepthMaterial,
  type Object3D,
  OrthographicCamera,
  type PerspectiveCamera,
  RenderTarget,
  type Scene,
  type ShadowMapType,
  Vector3,
  VSMShadowMap,
  WebGPUCoordinateSystem,
} from 'three';
import type { FakeLightsNode, PassKind, RenderObjectFunction } from './fakeRenderer.js';
import { CUBE_FACES_WEBGL, CUBE_FACES_WEBGPU } from './fakeRendererRules.js';

type ShadowLight = Light & { shadow: LightShadow; isPointLight?: boolean; distance?: number };

/** The renderer surface a shadow map render drives, as ShadowNode drives three's. */
export interface ShadowHost {
  readonly shadowMap: { enabled: boolean; type: ShadowMapType };
  /** The lights whose maps this host updates (`FakeRendererOptions.shadowLights`). */
  readonly shadowLights: Light[];
  readonly coordinateSystem: CoordinateSystem;
  /** The fake's NodeFrame.frameId: a map renders at most once per camera per frame. */
  readonly frameId: number;
  renderTarget: object | null;
  getRenderObjectFunction(): RenderObjectFunction | null;
  setRenderObjectFunction(fn: RenderObjectFunction | null): void;
  renderObject: RenderObjectFunction;
  /** A nested render() of the given kind, through the (possibly patched) instance method, as three's nodes call it. */
  renderPass(kind: PassKind, scene: Object3D, camera: Camera): void;
}

const _position = new Vector3();
const _target = new Vector3();

export class FakeShadowMaps {
  private readonly host: ShadowHost;
  /** ShadowBaseNode's shadow material, flagged so the host's renderObject derives the shadow side for it. */
  private readonly shadowMaterial = Object.assign(new MeshDepthMaterial(), { isShadowPassMaterial: true });
  /** ShadowNode._cameraFrameId per light. */
  private readonly frames = new WeakMap<Light, Map<Camera, number>>();
  private readonly vsmQuad: Mesh;
  private readonly vsmCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly vsmMaterials: Material[];
  private readonly vsmQuads: boolean;

  /** `quad` is the host's fullscreen triangle (QuadMesh's geometry); `vsmQuads` is `FakeRendererOptions.vsmQuad`. */
  constructor(host: ShadowHost, quad: BufferGeometry, vsmQuads: boolean) {
    this.host = host;
    this.vsmQuads = vsmQuads;
    // ShadowNode.vsmPass draws a QuadMesh with each blur material.
    this.vsmQuad = Object.assign(new Mesh(quad, new Material()), { isQuadMesh: true });
    this.vsmMaterials = ['VSMVertical', 'VSMHorizontal'].map((name) => Object.assign(new Material(), { name }));
  }

  /**
   * ShadowNode.updateBefore for every shadow light the render projected: a light renders its map when
   * `shadowMap.enabled`, `light.castShadow`, the light is among the projected lights, `shadow.autoUpdate || needsUpdate`,
   * and the map has not rendered for that camera in this frame; `needsUpdate` is then cleared.
   */
  update(scene: Scene, camera: Camera, lightsNode: FakeLightsNode): void {
    const host = this.host;
    if (!host.shadowMap.enabled) return;
    const projected = lightsNode.getLights();
    for (const light of host.shadowLights as ShadowLight[]) {
      if (!light.castShadow || !light.shadow || !projected.includes(light)) continue;
      if (!(light.shadow.needsUpdate || light.shadow.autoUpdate)) continue;
      let frames = this.frames.get(light);
      if (!frames) {
        frames = new Map();
        this.frames.set(light, frames);
      }
      if (frames.get(camera) === host.frameId) continue;
      frames.set(camera, host.frameId);
      this.updateShadow(light, scene, camera);
      light.shadow.needsUpdate = false;
    }
  }

  /** ShadowNode.updateShadow: render the map with the shadow material and render-object function, then the VSM quads. */
  private updateShadow(light: ShadowLight, scene: Scene, camera: Camera): void {
    const host = this.host;
    const shadow = light.shadow;
    // ShadowNode.setupShadow builds the light's map when a receiver's lighting first sets up and sets `shadow.map`
    // (ShadowNode.js ~529): a colour target with a depth texture (PointShadowNode.setupRenderTarget: a cube target and a
    // cube depth texture, two textures too). Built here as the map first renders.
    const built = shadow as unknown as { map: RenderTarget | null };
    if (!built.map) {
      built.map = new RenderTarget(shadow.mapSize.x, shadow.mapSize.y);
      built.map.depthTexture = new DepthTexture(shadow.mapSize.x, shadow.mapSize.y);
    }
    const vsm = host.shadowMap.type === VSMShadowMap;
    const layerMask = shadow.camera.layers.mask;
    if ((layerMask & 0xfffffffe) === 0) shadow.camera.layers.mask = camera.layers.mask;
    const saved = {
      renderTarget: host.renderTarget,
      overrideMaterial: scene.overrideMaterial,
      renderObjectFunction: host.getRenderObjectFunction(),
    };
    scene.overrideMaterial = this.shadowMaterial;
    host.setRenderObjectFunction(this.renderObjectFunction(shadow, vsm));
    host.renderTarget = { name: 'shadow', texture: { name: light.isPointLight ? 'PointShadowMap' : 'ShadowMap' } };
    if (light.isPointLight) {
      this.renderPointShadow(light, scene);
    } else {
      shadow.updateMatrices(light);
      host.renderPass({ kind: 'shadow', light, face: null }, scene, shadow.camera);
    }
    host.setRenderObjectFunction(saved.renderObjectFunction);
    if (vsm && !light.isPointLight && this.vsmQuads) {
      for (const material of this.vsmMaterials) {
        host.renderTarget = { texture: { name: '' } };
        this.vsmQuad.material = material;
        host.renderPass({ kind: 'vsm', light, face: null }, this.vsmQuad, this.vsmCamera);
      }
    }
    shadow.camera.layers.mask = layerMask;
    scene.overrideMaterial = saved.overrideMaterial;
    host.renderTarget = saved.renderTarget;
  }

  /** PointShadowNode.renderShadow: six renders with the same camera, re-aimed along each cube face. */
  private renderPointShadow(light: ShadowLight, scene: Scene): void {
    const shadow = light.shadow;
    const camera = shadow.camera as PerspectiveCamera;
    const faces = this.host.coordinateSystem === WebGPUCoordinateSystem ? CUBE_FACES_WEBGPU : CUBE_FACES_WEBGL;
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
      this.host.renderPass({ kind: 'shadow', light, face }, scene, camera);
    }
  }

  /** ShadowBaseNode's render-object function: casters only (and receivers under VSM), bracketed by the shadow hooks. */
  private renderObjectFunction(shadow: LightShadow, vsm: boolean): RenderObjectFunction {
    const host = this.host;
    return (object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId) => {
      if (object.castShadow !== true && !(object.receiveShadow && vsm)) return;
      const depthMaterial = scene.overrideMaterial as Material;
      // three passes the object where @types/three declares a scene.
      object.onBeforeShadow(
        host as never,
        object as never,
        camera,
        shadow.camera,
        geometry,
        depthMaterial,
        group as never,
      );
      host.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
      object.onAfterShadow(
        host as never,
        object as never,
        camera,
        shadow.camera,
        geometry,
        depthMaterial,
        group as never,
      );
    };
  }
}
