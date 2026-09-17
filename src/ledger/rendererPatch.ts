import type { Camera, Material, Object3D, Scene, Vector2 } from 'three';
import type { MaterialHashes } from '../registry/MaterialRegistry.js';
import { type BackendInfo, type DrawGroup, sideFactor } from './expectedDraws.js';
import type { PooledRecord } from './frameState.js';

/** The slice of three's common Renderer the ledger patches and reads. Structural so tests can fake it. */
export interface LedgerRenderer {
  render(scene: Scene, camera: Camera): unknown;
  renderObject(...args: unknown[]): unknown;
  info: {
    render: { drawCalls: number; triangles: number };
    memory: {
      programs: number;
      textures?: number;
      geometries?: number;
      texturesSize?: number;
      attributesSize?: number;
      indexAttributesSize?: number;
      renderTargets?: number;
      total?: number;
    };
    /** Info.createTexture and destroyTexture: wrapped while attached to count three's DFG_LUT (see `attach`). */
    createTexture?(texture: unknown): void;
    destroyTexture?(texture: unknown): void;
  };
  /**
   * `renderer.shadowMap`: its type tells the memory section whether built maps hold VSM blur targets, and `enabled: false`
   * that no shadow map renders (the `point-light-shadow` hint).
   */
  shadowMap?: { type?: number; enabled?: boolean };
  backend?: unknown;
  getRenderTarget?(): DrawnTarget | null;
  /** Drawing-buffer size in pixels; `overdraw.pixels` stays 0 without it. */
  getDrawingBufferSize?(target: Vector2): Vector2;
}

/** The render target current when a render starts: its name for the pass id, its textures for the memory section. */
export interface DrawnTarget {
  name?: string;
  texture?: { name?: string };
  textures?: readonly unknown[];
  depthTexture?: unknown;
  depthBuffer?: boolean;
  stencilBuffer?: boolean;
  /** Renderer.js ~1587 marks the frame-buffer target it draws a canvas frame into, which the allowance counts on its own. */
  isPostProcessingRenderTarget?: boolean;
  addEventListener?(type: string, listener: (event: { target: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { target: unknown }) => void): void;
}

interface BackendLike {
  isWebGPUBackend?: boolean;
  hasFeature?(name: string): boolean;
}

/** The renderer's own `render` and `renderObject`, put back by `unpatchRenderer`. */
export interface RendererOriginals {
  render: LedgerRenderer['render'];
  renderObject: LedgerRenderer['renderObject'];
}

/** What the patched `render` and `renderObject` call on the ledger. */
export interface LedgerHooks {
  /** Whether a `renderObject` call at this moment is attributed: inside an open frame that is not paused. */
  attributing(): boolean;
  hashesOf(material: Material): MaterialHashes;
  begin(
    object: Object3D,
    material: Material,
    group: unknown,
    hashes: MaterialHashes,
    sides: number,
    lightsNode: unknown,
  ): PooledRecord;
  file(
    record: PooledRecord,
    object: Object3D,
    material: Material,
    group: DrawGroup | null,
    sides: number,
    hashes: MaterialHashes,
    backSide: boolean,
  ): void;
  enter(scene: Object3D, camera: Camera): void;
  exit(): void;
}

/**
 * Patches `renderObject` and `render` on the renderer instance: every render-object function three installs (including
 * ShadowNode's) ends in `renderer.renderObject`, so this sees main, shadow and post-processing passes without composing
 * `setRenderObjectFunction`. Returns the originals for `unpatchRenderer`.
 */
export function patchRenderer(renderer: LedgerRenderer, ledger: LedgerHooks): RendererOriginals {
  const originals = { render: renderer.render, renderObject: renderer.renderObject };

  // `arguments` forwards exactly what three passed without copying it into a rest array on every call.
  renderer.renderObject = function (
    this: LedgerRenderer,
    object: Object3D,
    scene: Scene,
    _camera: Camera,
    _geometry: unknown,
    material: Material,
    group: unknown,
    lightsNode: unknown,
    _clippingContext: unknown,
    passId: unknown,
  ) {
    // Paused: an overdraw count render, possibly inside a draw of the open frame (a measurement from a render hook).
    if (!ledger.attributing()) return originals.renderObject.apply(this, arguments as unknown as unknown[]);
    const hashes = ledger.hashesOf(material);
    // Read before the call: three puts the override material's side back as renderObject returns.
    const sides = sideFactor(material, scene);
    const record = ledger.begin(object, material, group, hashes, sides, lightsNode);
    const result = originals.renderObject.apply(this, arguments as unknown as unknown[]);
    // Draw state is read after the call returns: BatchedMesh fills `_multiDrawCount` in its onBeforeRender (a sprite
    // batch its `instanceCount`), and a pass nested inside this draw (the shadow map a receiver triggers) restores the
    // counts it changed as it ends.
    ledger.file(record, object, material, group as DrawGroup | null, sides, hashes, passId === 'backSide');
    return result;
  };
  renderer.render = function (this: LedgerRenderer, scene: Scene, camera: Camera) {
    ledger.enter(scene, camera);
    try {
      return originals.render.call(this, scene, camera);
    } finally {
      ledger.exit();
    }
  };
  // `renderAsync` stays three's own: its frame enters the wrapper above once, so every enter() is paired with an
  // exit() inside one synchronous call (the mechanism is in docs/threeforge.md section 4, "How it hooks in"). A
  // wrapper of its own opened the frame before the await instead: the render inside became a nested pass, and any
  // render() made during the await merged into that frame.
  return originals;
}

export function unpatchRenderer(renderer: LedgerRenderer, originals: RendererOriginals): void {
  renderer.render = originals.render;
  renderer.renderObject = originals.renderObject;
}

/** `renderer.info`'s own `createTexture` and `destroyTexture` while wrapped, for `unwrapTextureInfo`. */
export interface TextureInfoWrap {
  info: LedgerRenderer['info'];
  create: (texture: unknown) => void;
  destroy: (texture: unknown) => void;
  own: { create: boolean; destroy: boolean };
}

/**
 * three r186 nodes/functions/BSDF/DFGLUT.js keeps its 16 x 16 RG half-float lookup texture in a module variable that
 * nothing exports (`three/tsl` exports the TSL function only), creates it on the first shader build that samples it and
 * never disposes it. Info.createTexture and destroyTexture see every texture three uploads and destroys, so the live
 * LUTs are counted by three's name for it, `DFG_LUT`, on a DataTexture, into `internal`; PMREM textures into `pmrem`.
 * Returns null, wrapping nothing, on a renderer whose info has no such methods.
 */
export function wrapTextureInfo(
  renderer: LedgerRenderer,
  internal: Set<object>,
  pmrem: Set<object>,
): TextureInfoWrap | null {
  const info = renderer.info;
  const create = info.createTexture;
  const destroy = info.destroyTexture;
  internal.clear();
  if (typeof create !== 'function' || typeof destroy !== 'function') return null;
  const own = { create: Object.hasOwn(info, 'createTexture'), destroy: Object.hasOwn(info, 'destroyTexture') };
  info.createTexture = function (this: unknown, texture: unknown) {
    const t = texture as { name?: string; isDataTexture?: boolean; isPMREMTexture?: boolean } | null;
    if (t && t.isDataTexture === true && t.name === 'DFG_LUT') internal.add(t);
    // three r186 PMREMGenerator's `_createRenderTarget` (renderers/common/extras/PMREMGenerator.js ~850-853) marks both
    // of its targets' textures, the ping-pong and the cube-UV output; PMREMNode keeps them for as long as it lives.
    else if (t && t.isPMREMTexture === true) pmrem.add(t);
    return create.apply(this, arguments as unknown as [unknown]);
  };
  info.destroyTexture = function (this: unknown, texture: unknown) {
    internal.delete(texture as object);
    pmrem.delete(texture as object);
    return destroy.apply(this, arguments as unknown as [unknown]);
  };
  return { info, create, destroy, own };
}

/** Puts back what `wrapTextureInfo` wrapped and empties both sets. */
export function unwrapTextureInfo(wrapped: TextureInfoWrap | null, internal: Set<object>, pmrem: Set<object>): void {
  internal.clear();
  pmrem.clear();
  if (!wrapped) return;
  // three's own are prototype methods: removing the wrappers exposes them again; a renderer's own methods are put back.
  if (wrapped.own.create) wrapped.info.createTexture = wrapped.create;
  else delete wrapped.info.createTexture;
  if (wrapped.own.destroy) wrapped.info.destroyTexture = wrapped.destroy;
  else delete wrapped.info.destroyTexture;
}

export function detectBackend(renderer: LedgerRenderer): BackendInfo {
  const backend = renderer.backend as BackendLike | undefined;
  if (!backend) return { backend: 'unknown', multiDraw: false };
  if (backend.isWebGPUBackend) return { backend: 'webgpu', multiDraw: false };
  return {
    backend: 'webgl2',
    multiDraw: typeof backend.hasFeature === 'function' ? backend.hasFeature('WEBGL_multi_draw') : false,
  };
}
