import { AddEquation, Color, CustomBlending, DataUtils, HalfFloatType, OneFactor, RenderTarget, Vector2, type Camera, type Material, type Object3D, type Scene, type Texture } from 'three';
import { vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

/** Renderer.setRenderObjectFunction's callback: the arguments of Renderer.renderObject. */
type RenderObjectFunction = (
  object: Object3D,
  scene: Scene,
  camera: Camera,
  geometry: unknown,
  material: Material,
  group: unknown,
  lightsNode: unknown,
  clippingContext?: unknown,
  passId?: string | null,
) => unknown;

/** The slice of three's common Renderer the measurement drives and restores. Structural so tests can fake it. */
export interface OverdrawRenderer {
  render(scene: Scene, camera: Camera): unknown;
  /** What the count's render-object function calls for every object it counts (three's override path runs there). */
  renderObject: RenderObjectFunction;
  getRenderObjectFunction(): RenderObjectFunction | null;
  setRenderObjectFunction(renderObjectFunction: RenderObjectFunction | null): void;
  getRenderTarget(): RenderTarget | null;
  setRenderTarget(target: RenderTarget | null, activeCubeFace?: number, activeMipmapLevel?: number): void;
  getActiveCubeFace(): number;
  getActiveMipmapLevel(): number;
  getMRT(): unknown;
  setMRT(mrt: unknown): unknown;
  getClearColor(target: Color): Color;
  getClearAlpha(): number;
  setClearColor(color: Color, alpha?: number): void;
  readRenderTargetPixelsAsync(target: RenderTarget, x: number, y: number, width: number, height: number): Promise<ArrayLike<number>>;
  getDrawingBufferSize(target: Vector2): Vector2;
  autoClear: boolean;
  autoClearColor: boolean;
  /** Common Renderer flags gating the opaque and transparent render lists. */
  opaque: boolean;
  transparent: boolean;
}

export interface OverdrawOptions {
  /** Resolution of the count target relative to the drawing buffer (default 1/8). */
  scale?: number;
}

export interface OverdrawResult {
  /** Opaque fragments rasterised per pixel, whatever their colour; the background is not counted. */
  opaque: number;
  /** Transparent fragments rasterised per pixel, whatever their colour. */
  transparent: number;
}

/** What one renderer measures with. */
interface CountState {
  target: RenderTarget | null;
  material: MeshBasicNodeMaterial;
  renderObject: RenderObjectFunction;
}

const states = new WeakMap<object, CountState>();
const _size = new Vector2();
const _black = new Color(0, 0, 0);

/**
 * Fragments per pixel, measured rather than estimated: the scene is rendered twice into a small half-float target, once
 * for the opaque render list and once for the transparent lists, then each render is read back and averaged.
 *
 * - **What a fragment adds:** exactly 1. The count material's `outputNode` is a constant, which replaces the diffuse
 *   result (NodeMaterial.setup), so material, map, vertex, instance and batch colours cannot scale the count; blending
 *   is One/One with no depth test or write, in one pass.
 * - **Which fragments:** each object is drawn with its own material's `side`, `map`, `opacity` and `alphaHash`, and
 *   three's override copies `alphaTest`, `alphaMap` and `positionNode`. Closed meshes count their front faces, cutouts
 *   count their kept texels, and a position node (AnimatedInstances) counts the animated pose.
 * - **Not counted:** the background (colour, texture or node: the target clears to 0), materials with
 *   `allowOverride = false` (they would draw themselves), and materials that write no colour (`colorWrite = false`,
 *   World's occlusion proxies).
 * - **State:** both counts render and every scene and renderer setting is restored synchronously, before the returned
 *   promise first awaits (the read-backs). An app render during the wait sees the app's own state.
 * - **Lifetime:** the target and the count material are kept per renderer; `disposeOverdraw(renderer)` releases them.
 *
 * Costs two low-resolution renders: call it on demand, not every frame.
 */
export async function measureOverdraw(renderer: OverdrawRenderer, scene: Scene, camera: Camera, options: OverdrawOptions = {}): Promise<OverdrawResult> {
  const scale = options.scale ?? 1 / 8;
  renderer.getDrawingBufferSize(_size);
  // Width in multiples of 32 texels: 8 bytes per half-float texel makes each row a multiple of 256 bytes, so the
  // WebGPU read-back has no row padding (three returns the padded buffer as-is).
  const width = Math.max(32, Math.ceil((_size.x * scale) / 32) * 32);
  const height = Math.max(1, Math.round((width * _size.y) / Math.max(1, _size.x)));
  const state = stateOf(renderer);
  if (!state.target || state.target.width !== width || state.target.height !== height) {
    state.target?.dispose();
    state.target = new RenderTarget(width, height, { type: HalfFloatType, depthBuffer: false, stencilBuffer: false });
  }
  const target = state.target;
  const saved = {
    override: scene.overrideMaterial,
    background: scene.background,
    backgroundNode: scene.backgroundNode,
    target: renderer.getRenderTarget(),
    cubeFace: renderer.getActiveCubeFace(),
    mipmapLevel: renderer.getActiveMipmapLevel(),
    mrt: renderer.getMRT(),
    renderObject: renderer.getRenderObjectFunction(),
    clearColor: renderer.getClearColor(new Color()),
    clearAlpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear,
    autoClearColor: renderer.autoClearColor,
    opaque: renderer.opaque,
    transparent: renderer.transparent,
  };
  const reads: Array<Promise<ArrayLike<number>>> = [];
  try {
    scene.overrideMaterial = state.material;
    scene.background = null;
    scene.backgroundNode = null;
    renderer.setRenderTarget(target);
    renderer.setMRT(null);
    renderer.setRenderObjectFunction(state.renderObject);
    renderer.setClearColor(_black, 0);
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.opaque = true;
    renderer.transparent = false;
    renderer.render(scene, camera);
    // Both backends queue the copy before their first await (a PBO readPixels on WebGL, a submitted copy on WebGPU):
    // it reads this render, ahead of the next one into the same target.
    reads.push(renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height));
    renderer.opaque = false;
    renderer.transparent = true;
    renderer.render(scene, camera);
    reads.push(renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height));
  } catch (error) {
    for (const read of reads) read.catch(() => {});
    throw error;
  } finally {
    scene.overrideMaterial = saved.override;
    scene.background = saved.background;
    scene.backgroundNode = saved.backgroundNode;
    renderer.setRenderTarget(saved.target, saved.cubeFace, saved.mipmapLevel);
    renderer.setMRT(saved.mrt);
    renderer.setRenderObjectFunction(saved.renderObject);
    renderer.setClearColor(saved.clearColor, saved.clearAlpha);
    renderer.autoClear = saved.autoClear;
    renderer.autoClearColor = saved.autoClearColor;
    renderer.opaque = saved.opaque;
    renderer.transparent = saved.transparent;
    // No texture stays referenced between measurements: `map` is set here, and three's override copies `alphaMap` without restoring it.
    state.material.map = null;
    state.material.alphaMap = null;
  }
  const [opaque, transparent] = await Promise.all(reads);
  return { opaque: averageRed(opaque!, width, height), transparent: averageRed(transparent!, width, height) };
}

/** Releases the count target and material `measureOverdraw` keeps for this renderer. `DrawCallLedger.detach()` calls it. */
export function disposeOverdraw(renderer: object): void {
  const state = states.get(renderer);
  if (!state) return;
  states.delete(renderer);
  state.target?.dispose();
  state.material.dispose();
}

function stateOf(renderer: OverdrawRenderer): CountState {
  let state = states.get(renderer);
  if (!state) {
    const material = countMaterial();
    state = { target: null, material, renderObject: countObject(renderer, material) };
    states.set(renderer, state);
  }
  return state;
}

function countMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.name = 'forge:overdraw-count';
  // setupDiffuseColor still runs (and discards on alphaTest and alphaHash); this constant replaces what it computed.
  material.outputNode = vec4(1, 0, 0, 1);
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendEquation = AddEquation;
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  material.forceSinglePass = true;
  material.lights = false;
  material.fog = false;
  material.toneMapped = false;
  return material;
}

/** The render-object function of the count renders: skip what adds no colour to a real frame, then draw with the count material. */
function countObject(renderer: OverdrawRenderer, material: MeshBasicNodeMaterial): RenderObjectFunction {
  return (object, scene, camera, geometry, source, group, lightsNode, clippingContext = null, passId = null) => {
    if (source.allowOverride !== true || source.colorWrite === false) return;
    if ((object.userData.forge as { kind?: string } | undefined)?.kind === 'occlusion-proxy') return;
    // Read off the material three hands over, which may differ from a canonical one (a sprite batch's swapped side).
    material.map = (source as Material & { map?: Texture | null }).map ?? null;
    material.opacity = source.opacity;
    material.alphaHash = source.alphaHash;
    material.side = source.side;
    return renderer.renderObject(object, scene, camera, geometry, source, group, lightsNode, clippingContext, passId);
  };
}

/** Mean of the red channel. Half-float targets read back as raw 16-bit halves on both backends; bytes for RGBA8 targets. */
function averageRed(px: ArrayLike<number>, width: number, height: number): number {
  const decode = px instanceof Uint16Array ? (v: number) => DataUtils.fromHalfFloat(v) : px instanceof Uint8Array ? (v: number) => v / 255 : (v: number) => v;
  let sum = 0;
  for (let i = 0; i < width * height; i++) sum += decode(px[i * 4]!);
  return sum / (width * height);
}
