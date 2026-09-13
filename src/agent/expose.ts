import type { Camera, Scene } from 'three';
import type { CompileReport, World } from '../compiler/World.js';
import type { DrawCallLedger, LedgerRenderer } from '../ledger/DrawCallLedger.js';
import type { FrameSnapshot, Hint, MemorySnapshot } from '../ledger/snapshot.js';
import { VERSION } from '../version.js';

/**
 * What `window.__threeforge` offers to a CLI or an AI agent driving the page. Everything reads the ledger; nothing
 * renders unless the app handed over renderer, scene and camera (then `frameAsync` renders one frame).
 */
export interface AgentHook {
  /** threeforge version. */
  version: string;
  /** Snapshot schema version (`ledger.frame()`). */
  schemaVersion: 2;
  /** The last frame's snapshot; does not render. */
  frame(): FrameSnapshot;
  /** Waits one animation frame (shadow maps update once per tick), renders if it can, returns the snapshot. */
  frameAsync(): Promise<FrameSnapshot>;
  /** Present while a World was given and is not compiled: batch the scene. */
  compile?(): CompileReport;
  /** Present after `compile()`: restore the original graph. */
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
    options.requestFrame ?? ((callback: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => callback()) : queueMicrotask(callback)));
  const canRender = Boolean(renderer && scene && camera);
  const hook: AgentHook = {
    version: VERSION,
    schemaVersion: 2,
    frame: () => ledger.frame(),
    frameAsync: () =>
      new Promise((resolve) => {
        requestFrame(() => {
          if (canRender) renderer!.render(scene!, camera!);
          resolve(ledger.frame());
        });
      }),
    measureMemory: () => ledger.measureMemory(),
    hints: () => ledger.frame().hints,
    report: () => ledger.report(),
  };
  if (canRender) hook.measureOverdraw = () => ledger.measureOverdraw(scene!, camera!);
  if (world) {
    const coordinateSystem = (renderer as { coordinateSystem?: number } | undefined)?.coordinateSystem;
    const compile = (): CompileReport => {
      const report = world.compile(coordinateSystem !== undefined ? { coordinateSystem: coordinateSystem as never } : {});
      delete hook.compile;
      hook.decompile = () => {
        world.decompile();
        delete hook.decompile;
        hook.compile = compile;
      };
      return report;
    };
    hook.compile = compile;
  }
  target[AGENT_HOOK_KEY] = hook;
  return () => {
    if (target[AGENT_HOOK_KEY] === hook) delete target[AGENT_HOOK_KEY];
  };
}
