import type { DrawCallLedger } from '../ledger/DrawCallLedger.js';
import type { FrameSnapshot } from '../ledger/snapshot.js';

const fmt = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** The six cost rows of a v2 snapshot, one line each, aligned for a monospace panel. */
export function formatCostRows(frame: FrameSnapshot): string[] {
  const t = frame.totals;
  const o = frame.overdraw;
  const s = frame.skinning;
  const l = frame.lighting;
  const j = frame.js;
  const m = frame.memory;
  const lights = Object.values(l.lights).reduce((a, b) => a + b, 0);
  return [
    `draw calls   ${t.sceneSubmissions} submissions · ${t.gpuDraws} gpu draws · ${fmt(t.triangles)} tris`,
    `overdraw     ${o.measured ? `${o.opaque.toFixed(2)} opaque · ${o.transparent.toFixed(2)} transparent fragments/px` : 'not measured'} · ${o.transparentSubmissions} transparent · ${o.particles} particles`,
    `skinning     ${s.submissions} meshes · ${fmt(s.vertices)} verts · ${s.bones} bones · ${s.skeletons} skeletons`,
    `lighting     ${lights} lights · ${l.shadowLights} shadow · ${l.shadowCasters} casters · ${fmt(l.shadowTexels)} texels`,
    `js           ${j.renderMs.toFixed(1)} ms render · ${j.frameMs.toFixed(1)} ms frame · ${j.objects} objects · ${j.autoUpdatedMatrices} auto-matrices · ${j.hiddenOriginals} hidden · ${j.skipped} skipped`,
    `memory       ~${mb(m.textures.bytes + m.geometries.bytes + m.renderTargets.bytes)} MB (tex ${mb(m.textures.bytes)} · geo ${mb(m.geometries.bytes)} · rt ${mb(m.renderTargets.bytes)})`,
  ];
}

/** Hints as lines: `!` for warnings and errors, `·` for information. */
export function formatHints(frame: FrameSnapshot): string[] {
  return frame.hints.map((h) => `${h.severity === 'info' ? '·' : '!'} ${h.code}: ${h.message}`);
}

/** Lines for the dev overlay: budget line, six cost rows, a diagnostics line, reasons by count (renderer-internal omitted), hints. */
export function formatOverlay(frame: FrameSnapshot, budget?: number): string[] {
  const t = frame.totals;
  const backend = `${frame.env.backend}${frame.env.multiDraw ? '+multidraw' : ''} ${frame.env.tier}`;
  const head =
    budget === undefined
      ? `threeforge ${backend}  ${t.sceneSubmissions} submissions`
      : `threeforge ${backend}  ${t.sceneSubmissions} / ${budget} submissions  ${t.sceneSubmissions <= budget ? 'PASS' : 'FAIL'}`;
  const reasons = Object.entries(frame.byReason)
    .filter(([reason]) => reason !== 'renderer-internal')
    .sort(([ra, a], [rb, b]) => b.submissions - a.submissions || ra.localeCompare(rb))
    .map(([reason, r]) => `${reason.padEnd(22)} ${String(r.submissions).padStart(5)}`);
  const diagnostics = `unattributed ${t.unattributed} · switches ${t.programSwitches} · programs ${t.programs}`;
  return [head, ...formatCostRows(frame), diagnostics, ...reasons, ...formatHints(frame)];
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
