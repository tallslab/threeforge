import type { Object3D } from 'three';
import { FORGE_HOOK_KEY } from './materialCode.js';

/** Functions threeforge installs as own-property hooks carry this marker so the ledger does not flag them. */
export const FORGE_HOOK: unique symbol = Symbol.for(FORGE_HOOK_KEY);

/** Marks `fn` as a threeforge hook (see `FORGE_HOOK`) and returns it. */
export function markForgeHook<T>(fn: T): T {
  (fn as unknown as Record<symbol, boolean>)[FORGE_HOOK] = true;
  return fn;
}

const OWN = Object.prototype.hasOwnProperty;

/**
 * Runs `fn` before whatever `onBeforeRender` the object currently has (three's prototype method or a
 * threeforge hook), as a marked own-property hook. Returns a function that restores the previous state.
 */
export function prependRenderHook(
  object: Object3D,
  fn: (...args: Parameters<Object3D['onBeforeRender']>) => void,
): () => void {
  return prependHook(object, 'onBeforeRender', fn);
}

/** Same as `prependRenderHook` for `onAfterRender`; `fn` receives the renderer, scene and camera. */
export function prependAfterRenderHook(
  object: Object3D,
  fn: (...args: Parameters<Object3D['onAfterRender']>) => void,
): () => void {
  return prependHook(object, 'onAfterRender', fn);
}

function prependHook<K extends 'onBeforeRender' | 'onAfterRender'>(
  object: Object3D,
  name: K,
  fn: (...args: Parameters<Object3D[K]>) => void,
): () => void {
  const hadOwn = OWN.call(object, name);
  const previous = object[name] as (...args: Parameters<Object3D[K]>) => void;
  const hook = markForgeHook(function (this: Object3D, ...args: Parameters<Object3D[K]>): void {
    fn(...args);
    previous.apply(this, args);
  });
  (object as unknown as Record<K, unknown>)[name] = hook;
  return () => {
    if ((object as unknown as Record<K, unknown>)[name] !== hook) return;
    if (hadOwn) (object as unknown as Record<K, unknown>)[name] = previous;
    else delete (object as unknown as Record<K, unknown>)[name];
  };
}
