import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import type { FrameSnapshot } from '../ledger/snapshot.js';

/** Lines for the dev overlay: budget line, cost line, then reasons by count (renderer-internal omitted). */
export function formatOverlay(frame: FrameSnapshot, budget?: number): string[] {
  const t = frame.totals;
  const backend = `${frame.env.backend}${frame.env.multiDraw ? '+multidraw' : ''}`;
  const head =
    budget === undefined
      ? `threeforge ${backend}  ${t.sceneSubmissions} submissions`
      : `threeforge ${backend}  ${t.sceneSubmissions} / ${budget} submissions  ${t.sceneSubmissions <= budget ? 'PASS' : 'FAIL'}`;
  const cost = `gpu draws ${t.gpuDraws} · unattributed ${t.unattributed} · switches ${t.programSwitches} · programs ${t.programs}`;
  const reasons = Object.entries(frame.byReason)
    .filter(([reason]) => reason !== 'renderer-internal')
    .sort(([ra, a], [rb, b]) => b.submissions - a.submissions || ra.localeCompare(rb))
    .map(([reason, r]) => `${reason.padEnd(22)} ${String(r.submissions).padStart(5)}`);
  return [head, cost, ...reasons];
}

export interface OverlayOptions {
  parent?: HTMLElement;
  budget?: number;
  /** Refresh period in milliseconds (default 500). */
  intervalMs?: number;
}

export interface OverlayHandle {
  element: HTMLElement;
  update(): void;
  dispose(): void;
}

/** A fixed-position text panel driven by `ledger.frame()`. Dev only; no dependencies. */
export function createOverlay(ledger: DrawCallLedger, options: OverlayOptions = {}): OverlayHandle {
  const parent = options.parent ?? document.body;
  const element = parent.ownerDocument.createElement('pre');
  element.id = 'threeforge-overlay';
  element.style.cssText =
    'position:fixed;top:8px;left:8px;margin:0;padding:8px 10px;background:rgba(0,0,0,.72);color:#e6edf3;' +
    'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;border-radius:6px;z-index:2147483647;pointer-events:none;white-space:pre;';
  const update = (): void => {
    element.textContent = formatOverlay(ledger.frame(), options.budget).join('\n');
  };
  update();
  parent.appendChild(element);
  const timer = setInterval(update, options.intervalMs ?? 500);
  return {
    element,
    update,
    dispose(): void {
      clearInterval(timer);
      element.remove();
    },
  };
}
