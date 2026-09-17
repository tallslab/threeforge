import { formatBytes, formatCount } from 'threeforge';
import { type BenchMetrics, SCENE_IDS, type SceneId } from '../test/app/benchMetrics.js';
import type { DeviceResult } from './submit.js';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pair = (n: BenchMetrics | undefined, o: BenchMetrics | undefined, f: (m: BenchMetrics) => string): string =>
  `${n ? f(n) : '…'} → ${o ? f(o) : '…'}`;
const mb = (m: BenchMetrics): string => formatBytes(m.textureBytes + m.geometryBytes + m.renderTargetBytes);

/** `<tr>`s for the live table: one per scene, cells fill in as variants finish. */
export function liveRows(scenes: Partial<Record<SceneId, { naive?: BenchMetrics; optimized?: BenchMetrics }>>): string {
  return SCENE_IDS.map((id) => {
    const n = scenes[id]?.naive;
    const o = scenes[id]?.optimized;
    return `<tr><td>${esc(id)}</td><td>${pair(n, o, (m) => String(m.sceneSubmissions))}</td><td>${pair(n, o, (m) => formatCount(m.triangles))}</td><td>${pair(n, o, (m) => `${m.overdrawOpaque.toFixed(2)} / ${m.overdrawTransparent.toFixed(2)}`)}</td><td>${pair(n, o, (m) => formatCount(m.skinnedVertices))}</td><td>${pair(n, o, mb)}</td><td>${pair(n, o, (m) => m.renderMs.toFixed(1))}</td><td>${pair(n, o, (m) => m.frameMs.toFixed(1))}</td></tr>`;
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
        return `<td>${esc(String(s.naive.sceneSubmissions))} → ${esc(String(s.optimized.sceneSubmissions))}<br><small>${esc(s.naive.frameMs.toFixed(1))} → ${esc(s.optimized.frameMs.toFixed(1))} ms</small></td>`;
      }).join('');
      const fillRate = r.env.fillRateGPix === null ? '–' : esc(r.env.fillRateGPix.toFixed(1));
      return `<tr><td>${esc(r.env.gpu)}<br><small>${esc(r.env.platform)}</small></td><td>${esc(r.env.backend)}</td><td>${esc(r.env.tier)}</td><td>${fillRate}</td>${cells}<td>${esc(r.createdAt.slice(0, 10))}</td></tr>`;
    })
    .join('');
}
