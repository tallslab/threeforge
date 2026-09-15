import { SCENE_IDS, type BenchMetrics, type SceneId } from '../test/app/benchMetrics.js';
import type { DeviceResult } from './submit.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pair = (n: BenchMetrics | undefined, o: BenchMetrics | undefined, f: (m: BenchMetrics) => string): string => `${n ? f(n) : '…'} → ${o ? f(o) : '…'}`;
const mb = (m: BenchMetrics): string => ((m.textureBytes + m.geometryBytes + m.renderTargetBytes) / 1048576).toFixed(0);

/** `<tr>`s for the live table: one per scene, cells fill in as variants finish. */
export function liveRows(scenes: Partial<Record<SceneId, { naive?: BenchMetrics; optimized?: BenchMetrics }>>): string {
  return SCENE_IDS.map((id) => {
    const n = scenes[id]?.naive;
    const o = scenes[id]?.optimized;
    return `<tr><td>${esc(id)}</td><td>${pair(n, o, (m) => String(m.sceneSubmissions))}</td><td>${pair(n, o, (m) => k(m.triangles))}</td><td>${pair(n, o, (m) => `${m.overdrawOpaque.toFixed(2)} / ${m.overdrawTransparent.toFixed(2)}`)}</td><td>${pair(n, o, (m) => k(m.skinnedVertices))}</td><td>${pair(n, o, mb)}</td><td>${pair(n, o, (m) => m.renderMs.toFixed(1))}</td><td>${pair(n, o, (m) => m.frameMs.toFixed(1))}</td></tr>`;
  }).join('');
}

/** `<tr>`s for the public table: device, backend, tier, fill rate, per scene submissions and frame ms, date. Every
 * value that came from a submitted result (not a fixed constant computed here) is HTML-escaped, even fields that
 * validation already constrains (backend, tier, date), so this stays safe on its own if that ever changes. */
export function deviceRows(results: DeviceResult[]): string {
  return results
    .map((r) => {
      const cells = SCENE_IDS.map((id) => {
        const s = r.scenes[id];
        return `<td>${s.naive.sceneSubmissions} → ${s.optimized.sceneSubmissions}<br><small>${s.naive.frameMs.toFixed(1)} → ${s.optimized.frameMs.toFixed(1)} ms</small></td>`;
      }).join('');
      return `<tr><td>${esc(r.env.gpu)}<br><small>${esc(r.env.platform)}</small></td><td>${esc(r.env.backend)}</td><td>${esc(r.env.tier)}</td><td>${r.env.fillRateGPix === null ? '–' : r.env.fillRateGPix.toFixed(1)}</td>${cells}<td>${esc(r.createdAt.slice(0, 10))}</td></tr>`;
    })
    .join('');
}
