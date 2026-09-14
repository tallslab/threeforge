import type { BenchMetrics, SceneId } from '../test/app/benchMetrics.js';

export type Backend = 'webgl2' | 'webgpu';
export type Tier = 'desktop' | 'phone-mid' | 'phone-low';

export interface DeviceEnv {
  three: string;
  backend: Backend;
  multiDraw: boolean;
  tier: Tier;
  gpu: string;
  dpr: number;
  viewport: [number, number];
  ua: string;
  platform: string;
  cores: number | null;
  deviceMemory: number | null;
  /** Two-second fill-rate probe, GPix/s; informational. */
  fillRateGPix: number | null;
}

/** What the page submits and `scripts/bench-schema.mjs` validates; `scenes` matches a `pnpm bench` result. */
export interface DeviceResult {
  schemaVersion: 1;
  kind: 'device';
  id: string;
  createdAt: string;
  env: DeviceEnv;
  scenes: Record<SceneId, { naive: BenchMetrics; optimized: BenchMetrics }>;
}

/** GitHub accepts long new-issue URLs, but not unboundedly; above this the page falls back to copy and paste. */
export const URL_LIMIT = 7000;
export const ISSUE_LABEL = 'bench-result';

/** FNV-1a over the strings that identify a device, as 8 base-36 characters. */
function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h.toString(36) + 'zzzzzzzz').slice(0, 8);
}

/** `YYYY-MM-DD-<hash of gpu, ua, backend>`: the file name under bench/devices. */
export function resultId(env: DeviceEnv, now: Date): string {
  return `${now.toISOString().slice(0, 10)}-${hash8(`${env.gpu}|${env.ua}|${env.backend}`)}`;
}

const round = (n: number, digits: number): number => Number(n.toFixed(digits));
const cap = (s: string): string => (s.length > 200 ? s.slice(0, 200) : s);

/** Rounded numbers and capped strings: smaller issue bodies, same information. */
export function compact(r: DeviceResult): DeviceResult {
  const scenes = {} as DeviceResult['scenes'];
  for (const [id, block] of Object.entries(r.scenes) as Array<[SceneId, { naive: BenchMetrics; optimized: BenchMetrics }]>) {
    const c = (m: BenchMetrics): BenchMetrics => ({
      ...m,
      overdrawOpaque: round(m.overdrawOpaque, 2),
      overdrawTransparent: round(m.overdrawTransparent, 2),
      renderMs: round(m.renderMs, 1),
      frameMs: round(m.frameMs, 1),
      triangles: Math.round(m.triangles),
      textureBytes: Math.round(m.textureBytes),
      geometryBytes: Math.round(m.geometryBytes),
      renderTargetBytes: Math.round(m.renderTargetBytes),
      particles: Math.round(m.particles),
      fillMegapixels: round(m.fillMegapixels, 2),
    });
    scenes[id] = { naive: c(block.naive), optimized: c(block.optimized) };
  }
  return { ...r, env: { ...r.env, gpu: cap(r.env.gpu), ua: cap(r.env.ua), platform: cap(r.env.platform), dpr: round(r.env.dpr, 2), fillRateGPix: r.env.fillRateGPix === null ? null : round(r.env.fillRateGPix, 2) }, scenes };
}

/** The issue-body form: metrics as arrays in `metricKeys` order (about a third of the size, so the prefilled URL fits). */
export interface WireResult extends Omit<DeviceResult, 'scenes'> {
  metricKeys: Array<keyof BenchMetrics>;
  scenes: Record<SceneId, { naive: number[]; optimized: number[] }>;
}

export const METRIC_KEYS: Array<keyof BenchMetrics> = ['sceneSubmissions', 'gpuDraws', 'triangles', 'programs', 'overdrawOpaque', 'overdrawTransparent', 'skinnedVertices', 'shadowCasters', 'shadowTexels', 'textureBytes', 'geometryBytes', 'renderTargetBytes', 'particles', 'fillMegapixels', 'renderMs', 'frameMs', 'unattributed'];

export function toWire(r: DeviceResult): WireResult {
  const c = compact(r);
  const scenes = {} as WireResult['scenes'];
  for (const [id, block] of Object.entries(c.scenes) as Array<[SceneId, { naive: BenchMetrics; optimized: BenchMetrics }]>) {
    scenes[id] = { naive: METRIC_KEYS.map((k) => block.naive[k]), optimized: METRIC_KEYS.map((k) => block.optimized[k]) };
  }
  return { schemaVersion: c.schemaVersion, kind: c.kind, id: c.id, createdAt: c.createdAt, env: c.env, metricKeys: METRIC_KEYS, scenes };
}

export function issueTitle(r: DeviceResult): string {
  return `bench: ${cap(r.env.gpu)} · ${r.env.backend} · ${r.env.tier}`;
}

/** The issue body: one line of context and the compact JSON in a fence the ingest script reads. */
export function issueBody(r: DeviceResult): string {
  return `Device bench result from the threeforge bench page (${cap(r.env.gpu)}, ${r.env.backend}, tier ${r.env.tier}). The \`bench-results\` workflow validates it and adds it to docs/devices.md.\n\n\`\`\`json\n${JSON.stringify(toWire(r))}\n\`\`\`\n`;
}

/** A prefilled new-issue URL, or null when there is no repository or the URL would be too long for GitHub. */
export function issueUrl(repo: string, r: DeviceResult): string | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const q = new URLSearchParams({ title: issueTitle(r), labels: ISSUE_LABEL, body: issueBody(r) });
  const url = `https://github.com/${repo}/issues/new?${q.toString()}`;
  return url.length < URL_LIMIT ? url : null;
}
