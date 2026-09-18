import type { Camera, Scene } from 'three';
import type { CompileReport, World } from '../compiler/World.js';
import type { DrawCallLedger, LedgerRenderer } from '../ledger/DrawCallLedger.js';
import { type FrameSnapshot, type Hint, type MemorySnapshot, SNAPSHOT_SCHEMA_VERSION } from '../ledger/snapshot.js';
import { VERSION } from '../version.js';

/**
 * What `window.__threeforge` offers to a CLI or an AI agent driving the page. Everything reads the ledger; nothing
 * renders unless the app handed over renderer, scene and camera (then `frameAsync` renders one frame).
 */
export interface AgentHook {
  version: string;
  /** Frame snapshot schema version (`ledger.frame().schemaVersion`); `threeforge inspect` requires this one. */
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  /** The last frame's snapshot; does not render. */
  frame(): FrameSnapshot;
  /** Waits one animation frame (shadow maps update once per tick), renders if it can, returns the snapshot. Rejects when the render throws. */
  frameAsync(): Promise<FrameSnapshot>;
  /** Present while a World was given and is not compiled, whoever compiled it: batch the scene. */
  compile?(): CompileReport;
  /** Present while that World is compiled: restore the original graph. */
  decompile?(): void;
  /** Present when renderer, scene and camera were given: fragments per pixel, opaque and transparent. */
  measureOverdraw?(): Promise<{ opaque: number; transparent: number }>;
  measureMemory(): MemorySnapshot;
  hints(): Hint[];
  report(): string;
}

export interface ExposeOptions {
  ledger: DrawCallLedger;
  world?: World;
  renderer?: LedgerRenderer;
  scene?: Scene;
  camera?: Camera;
  /** Object to publish on (default `globalThis`, i.e. `window`). */
  target?: object;
  /** Animation-frame scheduler (default `requestAnimationFrame`, a microtask where it does not exist). */
  requestFrame?: (callback: () => void) => void;
}

export const AGENT_HOOK_KEY = '__threeforge';

/**
 * Publish `window.__threeforge` so `npx threeforge inspect <url>` (or any agent) can measure the frame, compile
 * the scene and read hints. One line in the app: `exposeToAgents({ ledger, world, renderer, scene, camera })`.
 * Returns a disposer that removes the hook.
 */
export function exposeToAgents(options: ExposeOptions): () => void {
  const { ledger, world, renderer, scene, camera } = options;
  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const requestFrame =
    options.requestFrame ??
    ((callback: () => void) =>
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => callback()) : queueMicrotask(callback));
  const canRender = Boolean(renderer && scene && camera);
  const hook: AgentHook = {
    version: VERSION,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    frame: () => ledger.frame(),
    frameAsync: () =>
      new Promise((resolve, reject) => {
        requestFrame(() => {
          // The callback runs outside the executor: without the catch a throwing render leaves the promise pending.
          try {
            if (canRender) renderer!.render(scene!, camera!);
            resolve(ledger.frame());
          } catch (error) {
            reject(error);
          }
        });
      }),
    measureMemory: () => ledger.measureMemory(),
    hints: () => ledger.frame().hints,
    report: () => ledger.report(),
  };
  if (canRender) hook.measureOverdraw = () => ledger.measureOverdraw(scene!, camera!);
  let stopFollowing = (): void => {};
  if (world) {
    const coordinateSystem = (renderer as { coordinateSystem?: number } | undefined)?.coordinateSystem;
    const compile = (): CompileReport =>
      world.compile(coordinateSystem !== undefined ? { coordinateSystem: coordinateSystem as never } : {});
    const decompile = (): void => world.decompile();
    // The World decides which of the two is offered, not this hook's own calls: the app may have compiled before
    // exposing, or compile and decompile on its own later.
    const follow = (): void => {
      delete hook.compile;
      delete hook.decompile;
      if (world.isCompiled) hook.decompile = decompile;
      else hook.compile = compile;
    };
    follow();
    stopFollowing = world.onDirty((event) => {
      if (event.kind === 'compile' || event.kind === 'decompile') follow();
    });
  }
  target[AGENT_HOOK_KEY] = hook;
  return () => {
    stopFollowing();
    if (target[AGENT_HOOK_KEY] === hook) delete target[AGENT_HOOK_KEY];
  };
}
