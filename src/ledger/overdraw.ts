import { AddEquation, Color, CustomBlending, DataUtils, HalfFloatType, OneFactor, RenderTarget, Vector2, type Camera, type Material, type Object3D, type Scene, type Side, type Texture } from 'three';
import { vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial, SpriteNodeMaterial, type Node } from 'three/webgpu';

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
  /** The scene's override material during the count renders. */
  material: MeshBasicNodeMaterial;
  /** Swapped in for each draw of a sprite material, whose quad SpriteNodeMaterial.setupPositionView places. */
  sprite: SpriteNodeMaterial;
  renderObject: RenderObjectFunction;
  /** The measurement whose count renders are running on this renderer right now, else null: a nested call returns it. */
  measuring: Promise<OverdrawResult> | null;
  /** disposeOverdraw() was called while the count renders ran: release as they end. */
  disposeRequested: boolean;
}

/** The count material slots a count draw writes, or three's override copy writes, and puts back. */
interface CountMaterialSlots {
  map: Texture | null;
  opacity: number;
  alphaHash: boolean;
  side: Side;
  opacityNode: Node | null;
  alphaTestNode: Node | null;
  maskNode: Node | null;
  positionNode: Node | null;
  displacementMap?: Texture | null;
  alphaMap: Texture | null;
  alphaTest: number;
}

/** The fields of a drawn material the count reads; a field a material does not have counts as unset. */
type SourceMaterial = Material & {
  map?: Texture | null;
  opacityNode?: Node | null;
  alphaTestNode?: Node | null;
  maskNode?: Node | null;
  isSpriteMaterial?: boolean;
  isSpriteNodeMaterial?: boolean;
  isPointsMaterial?: boolean;
  isPointsNodeMaterial?: boolean;
  rotation?: number;
  sizeAttenuation?: boolean;
  scaleNode?: Node | null;
  rotationNode?: Node | null;
};

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
 * - **Which fragments:** each object is drawn with its own material's `side`, `map`, `opacity`, `alphaHash`,
 *   `opacityNode`, `alphaTestNode` and `maskNode`, and three's override copies `alphaTest`, `alphaMap` and `positionNode`.
 *   Closed meshes count their front faces, cutouts count their kept texels, and a position node (AnimatedInstances)
 *   counts the animated pose. Sprite materials (a `Sprite`, a World sprite batch) are drawn with a `SpriteNodeMaterial`
 *   count material carrying their `rotation`, `sizeAttenuation`, `scaleNode` and `rotationNode`: they count their billboards.
 * - **Not carried:** `colorNode` alpha, vertex-colour alpha, and vertices a material builds in its class or `vertexNode`
 *   (a `PointsNodeMaterial` on a non-`Points` object, Line2-style materials): those count what the count material
 *   rasterises from the geometry and `positionNode`.
 * - **Not counted:** the background (colour, texture or node: the target clears to 0), materials with
 *   `allowOverride = false` (they would draw themselves), and materials that write no colour (`colorWrite = false`,
 *   World's occlusion proxies).
 * - **State:** both counts render and every scene and renderer setting is restored synchronously, before the returned
 *   promise first awaits (the read-backs). An app render during the wait sees the app's own state.
 * - **Re-entrancy:** a call made while this renderer's count renders are running (an `onBeforeRender` or another hook
 *   the count render calls again, as a measuring hook is) returns the measurement in progress and renders nothing: it
 *   ignores its own `scene`, `camera` and `options.scale`, and resolves with the outer measurement's result even for
 *   another scene. A call made once the counts have rendered, while the read-backs are pending, is a measurement of its
 *   own. `disposeOverdraw(renderer)` called while the count renders run releases once they end.
 * - **Nested renders:** a scene rendered inside a count draw with its own override material, or none (a render-to-texture
 *   hook), passes straight through. A same-scene render inside a count draw (a reflector's `updateBefore`) is counted,
 *   and every slot its draws change on the count material is put back for the draw around it.
 * - **Lifetime:** the target and the count materials are kept per renderer; `disposeOverdraw(renderer)` releases them.
 *
 * Costs two low-resolution renders: call it on demand, not every frame.
 */
export function measureOverdraw(renderer: OverdrawRenderer, scene: Scene, camera: Camera, options: OverdrawOptions = {}): Promise<OverdrawResult> {
  let state: CountState;
  try {
    state = stateOf(renderer);
  } catch (error) {
    return Promise.reject(error);
  }
  // A hook the count render runs may measure again: it joins this measurement instead of rendering the counts inside the
  // counts (which recursed until the stack overflowed). The promise exists before the renders start, so it can.
  if (state.measuring !== null) return state.measuring;
  let resolve!: (result: OverdrawResult | PromiseLike<OverdrawResult>) => void;
  let reject!: (error: unknown) => void;
  const measurement = new Promise<OverdrawResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  state.measuring = measurement;
  try {
    resolve(countOverdraw(renderer, scene, camera, options, state));
  } catch (error) {
    reject(error);
  } finally {
    state.measuring = null;
    if (state.disposeRequested) release(renderer, state);
  }
  return measurement;
}

/** The two count renders, run and restored synchronously; the returned promise settles with the read-backs. */
function countOverdraw(renderer: OverdrawRenderer, scene: Scene, camera: Camera, options: OverdrawOptions, state: CountState): Promise<OverdrawResult> {
  const scale = options.scale ?? 1 / 8;
  renderer.getDrawingBufferSize(_size);
  // Width in multiples of 32 texels: 8 bytes per half-float texel makes each row a multiple of 256 bytes, so the
  // WebGPU read-back has no row padding (three returns the padded buffer as-is).
  const width = Math.max(32, Math.ceil((_size.x * scale) / 32) * 32);
  const height = Math.max(1, Math.round((width * _size.y) / Math.max(1, _size.x)));
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
    // No texture stays referenced between measurements: `map` is set per draw, and three's override copies `alphaMap` without restoring it.
    for (const count of [state.material, state.sprite]) {
      count.map = null;
      count.alphaMap = null;
    }
  }
  return Promise.all(reads).then(([opaque, transparent]) => ({ opaque: averageRed(opaque!, width, height), transparent: averageRed(transparent!, width, height) }));
}

/** Releases the count target and materials `measureOverdraw` keeps for this renderer. `DrawCallLedger.detach()` calls it. */
export function disposeOverdraw(renderer: object): void {
  const state = states.get(renderer);
  if (!state) return;
  // From a hook the count renders run: releasing now would drop the guard a nested measureOverdraw joins through, and
  // that call would render the counts inside the counts again. measureOverdraw releases as the renders end.
  if (state.measuring !== null) {
    state.disposeRequested = true;
    return;
  }
  release(renderer, state);
}

function release(renderer: object, state: CountState): void {
  if (states.get(renderer) === state) states.delete(renderer);
  state.target?.dispose();
  state.material.dispose();
  state.sprite.dispose();
}

/**
 * The count target `measureOverdraw` keeps for this renderer: null before the first measurement and after
 * `disposeOverdraw(renderer)`. The renderer holds its texture while nothing in the scene reaches it, so the ledger's
 * memory estimate allows it.
 */
export function overdrawTargetOf(renderer: object): RenderTarget | null {
  return states.get(renderer)?.target ?? null;
}

function stateOf(renderer: OverdrawRenderer): CountState {
  let state = states.get(renderer);
  if (!state) {
    const material = countMaterial(new MeshBasicNodeMaterial(), 'forge:overdraw-count');
    const sprite = countMaterial(new SpriteNodeMaterial(), 'forge:overdraw-count-sprite');
    state = { target: null, material, sprite, renderObject: countObject(renderer, material, sprite), measuring: null, disposeRequested: false };
    states.set(renderer, state);
  }
  return state;
}

function countMaterial<T extends MeshBasicNodeMaterial | SpriteNodeMaterial>(material: T, name: string): T {
  material.name = name;
  // setupDiffuseColor still runs (and discards on alphaTest, alphaHash and maskNode); this constant replaces what it computed.
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

/**
 * The render-object function of the count renders: skip what adds no colour to a real frame, then draw with a count
 * material. Draws of a scene rendered inside a count draw with another override, or none, pass straight through.
 */
function countObject(renderer: OverdrawRenderer, meshCount: MeshBasicNodeMaterial, spriteCount: SpriteNodeMaterial): RenderObjectFunction {
  return (object, scene, camera, geometry, material, group, lightsNode, clippingContext = null, passId = null) => {
    const override = scene.overrideMaterial;
    // Renderer._renderScene installs this function for nested renders too (Renderer.js ~1736). A scene a hook renders
    // during a count draw (a render-to-texture onBeforeRender, which three runs before its override copies, ~3721) keeps
    // its own override, or none: its draws are the app's, and must not touch the count material under the draw around them.
    if (override !== meshCount && override !== spriteCount) {
      return renderer.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
    }
    if (material.allowOverride !== true || material.colorWrite === false) return;
    if ((object.userData?.forge as { kind?: string } | undefined)?.kind === 'occlusion-proxy') return;
    const source = material as SourceMaterial;
    // A sprite material places its quad in SpriteNodeMaterial.setupPositionView: a camera-facing billboard scaled by
    // `scaleNode`. With the mesh count material a Sprite's quad lies unrotated in its own plane, and a sprite batch's
    // instances collapse onto their centres (its positionNode, which three copies). PointsNodeMaterial extends
    // SpriteNodeMaterial, but on a Points object it draws points (PointsNodeMaterial.setupVertex), as the mesh count does.
    // Points flags are read first: NodeMaterial.setDefaultValues copies the classic defaults' flags, so every
    // SpriteNodeMaterial, a PointsNodeMaterial included, also carries `isSpriteMaterial`.
    const points = source.isPointsNodeMaterial === true || source.isPointsMaterial === true;
    const sprite = !points && (source.isSpriteMaterial === true || source.isSpriteNodeMaterial === true);
    const count = sprite ? spriteCount : meshCount;
    // Everything this draw and three's override copy change on the count material is put back in the finally: a
    // same-scene render inside the draw (a reflector's updateBefore, Renderer.js ~3875, after three's copies at
    // ~3744-3752) draws with the count too and must leave the draw around it as it was, and three's own restore
    // (~3805-3809) sits outside a finally, so a throwing draw would leave its copies behind.
    const saved: CountMaterialSlots = {
      map: count.map,
      opacity: count.opacity,
      alphaHash: count.alphaHash,
      side: count.side,
      opacityNode: count.opacityNode,
      alphaTestNode: count.alphaTestNode,
      maskNode: count.maskNode,
      positionNode: count.positionNode,
      displacementMap: (count as { displacementMap?: Texture | null }).displacementMap,
      alphaMap: count.alphaMap,
      alphaTest: count.alphaTest,
    };
    const savedSprite = sprite ? { rotation: spriteCount.rotation, sizeAttenuation: spriteCount.sizeAttenuation, scaleNode: spriteCount.scaleNode, rotationNode: spriteCount.rotationNode } : null;
    // Read off the material three hands over, which may differ from a canonical one (a sprite batch's swapped side).
    count.map = source.map ?? null;
    count.opacity = source.opacity;
    count.alphaHash = source.alphaHash;
    count.side = source.side;
    // Node slots key the render object's program (NodeMaterial.customProgramCacheKey), as three's own positionNode copy does.
    count.opacityNode = source.opacityNode ?? null;
    count.alphaTestNode = source.alphaTestNode ?? null;
    count.maskNode = source.maskNode ?? null;
    if (sprite) {
      spriteCount.rotation = source.rotation ?? 0;
      spriteCount.sizeAttenuation = source.sizeAttenuation ?? true;
      spriteCount.scaleNode = source.scaleNode ?? null;
      spriteCount.rotationNode = source.rotationNode ?? null;
    }
    // Renderer.renderObject reads scene.overrideMaterial on each call, and writes its restores back to it.
    const swap = override !== count;
    if (swap) scene.overrideMaterial = count;
    try {
      return renderer.renderObject(object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId);
    } finally {
      if (swap) scene.overrideMaterial = override;
      Object.assign(count, saved);
      if (savedSprite) Object.assign(spriteCount, savedSprite);
    }
  };
}

/** Mean of the red channel. Half-float targets read back as raw 16-bit halves on both backends; bytes for RGBA8 targets. */
function averageRed(px: ArrayLike<number>, width: number, height: number): number {
  const decode = px instanceof Uint16Array ? (v: number) => DataUtils.fromHalfFloat(v) : px instanceof Uint8Array ? (v: number) => v / 255 : (v: number) => v;
  let sum = 0;
  for (let i = 0; i < width * height; i++) sum += decode(px[i * 4]!);
  return sum / (width * height);
}
