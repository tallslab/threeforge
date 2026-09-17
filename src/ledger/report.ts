import type { FrameSnapshot } from './snapshot.js';
import { formatCount as fmt, formatBytes as mb } from './text.js';

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
    `skinning     ${s.submissions} meshes · ${fmt(s.vertices)} verts · ${s.bones} bones · ${s.skeletons} skeletons · ${s.vatInstances} vat instances`,
    `lighting     ${lights} lights · ${l.shadowLights} shadow · ${l.shadowCasters} casters · ${fmt(l.shadowTexels)} texels`,
    `js           ${j.renderMs.toFixed(1)} ms render · ${j.ledgerMs.toFixed(1)} ms ledger · ${j.frameMs.toFixed(1)} ms frame · ${j.objects} objects · ${j.autoUpdatedMatrices} auto-matrices · ${j.hiddenOriginals} hidden · ${j.skipped} skipped`,
    `memory       ~${mb(m.textures.bytes + m.geometries.bytes + m.renderTargets.bytes)} MB (tex ${mb(m.textures.bytes)} · geo ${mb(m.geometries.bytes)} · rt ${mb(m.renderTargets.bytes)})${m.chunks.total > 0 ? ` · chunks ${m.chunks.resident}/${m.chunks.total}` : ''}`,
  ];
}

/** Hints as lines: `!` for warnings and errors, `·` for information. */
export function formatHints(frame: FrameSnapshot): string[] {
  return frame.hints.map((h) => `${h.severity === 'info' ? '·' : '!'} ${h.code}: ${h.message}`);
}
