import type { Object3D, Texture } from 'three';
import { reflector } from 'three/tsl';
import type { TargetOwner } from '../memory/resources.js';
import type { AllowedRenderTarget } from './memory.js';
import type { LedgerRenderer } from './rendererPatch.js';

/** three's `ReflectorBaseNode` as far as the ledger reads it (nodes/utils/ReflectorNode.js). */
export interface ReflectorLike extends TargetOwner {
  target: Object3D;
  renderTargets: Map<unknown, unknown>;
}

/**
 * What one frame's draws bound, by the object drawn. It describes what the shaders sample, which is how a texture
 * created inside an `Fn` becomes visible at all; it is not an inventory of what three has allocated, and it ages: a
 * texture counts only while an object that sampled it is still in the scene (`sampledUnder`).
 */
export interface DrawnSamples {
  textures: Map<Object3D, Set<Texture>>;
  reflectors: Set<ReflectorLike>;
}

export function emptySamples(): DrawnSamples {
  return { textures: new Map(), reflectors: new Set() };
}

/**
 * The textures sampled by objects still under `scene`. An object removed since the collection no longer speaks for
 * what it sampled: left uploaded, that is a leak, and a stale sample must not hide it until the next collection.
 */
export function sampledUnder(samples: DrawnSamples, scene: Object3D): Set<Texture> {
  const sampled = new Set<Texture>();
  for (const [object, textures] of samples.textures) {
    let root: Object3D | null = object;
    while (root && root !== scene) root = root.parent;
    if (root) for (const texture of textures) sampled.add(texture);
  }
  return sampled;
}

function reflectorOf(textureNode: unknown): ReflectorLike | null {
  const base = (textureNode as { reflector?: Partial<ReflectorLike> } | null)?.reflector;
  const usable =
    base?.renderTargets instanceof Map && typeof base.dispose === 'function' && base.target?.isObject3D === true;
  return usable ? (base as ReflectorLike) : null;
}

/**
 * Adds what `renderObject` binds: three r186 `RenderObject.getBindings()` returns bind groups whose `bindings` hold,
 * among uniforms and samplers, `NodeSampledTexture`s (`isSampledTexture`, `texture`, `textureNode`). Anything of
 * another shape is not read. three's own full-screen quads are left out: they sample the frame they present.
 */
export function addSamples(renderObject: unknown, into: DrawnSamples): void {
  const drawn = renderObject as { object?: Object3D & { isQuadMesh?: boolean }; getBindings?(): unknown } | null;
  const object = drawn?.object;
  if (typeof drawn?.getBindings !== 'function' || !object?.isObject3D || object.isQuadMesh === true) return;
  const groups = drawn.getBindings();
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    const bindings = (group as { bindings?: unknown } | null)?.bindings;
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings as Array<{ isSampledTexture?: boolean; texture?: Texture; textureNode?: unknown }>) {
      if (binding?.isSampledTexture !== true || binding.texture?.isTexture !== true) continue;
      let sampled = into.textures.get(object);
      if (!sampled) into.textures.set(object, (sampled = new Set()));
      sampled.add(binding.texture);
      const owner = reflectorOf(binding.textureNode);
      if (owner) into.reflectors.add(owner);
    }
  }
}

/**
 * Collects into `into` from every draw until the returned function is called, by wrapping three r186's
 * `backend.draw(renderObject, info)`, the one call both backends draw through. Null when the backend has no such
 * method: nothing is collected and the estimate keeps to what the scene shows.
 */
export function collectSamples(renderer: LedgerRenderer, into: DrawnSamples): (() => void) | null {
  const backend = renderer.backend as { draw?: (...args: unknown[]) => unknown } | undefined;
  if (typeof backend?.draw !== 'function') return null;
  const own = Object.hasOwn(backend, 'draw');
  const draw = backend.draw;
  backend.draw = function (this: unknown, ...args: unknown[]) {
    addSamples(args[0], into);
    return draw.apply(this, args);
  };
  return () => {
    if (own) backend.draw = draw;
    else delete backend.draw;
  };
}

let placeholderTexture: Texture | null | undefined;

/**
 * three's reflector placeholder: `ReflectorNode.js` keeps one module-level `_defaultRT`, the value of every reflector
 * node until its own target has rendered, and resizes it to the reflection's resolution in `setup()`. Its colour
 * texture is uploaded once a reflector is built and never freed; nothing renders into it, so its depth never exists.
 * Null when a reflector node no longer starts out on a render target's texture.
 */
export function reflectorPlaceholder(): (AllowedRenderTarget & { width: number; height: number }) | null {
  if (placeholderTexture === undefined) {
    const value = reflector().value;
    placeholderTexture = value?.isTexture === true && value.renderTarget ? value : null;
  }
  const target = placeholderTexture?.renderTarget;
  if (!placeholderTexture || !target) return null;
  return { textures: [placeholderTexture], depthBuffer: false, width: target.width, height: target.height };
}
