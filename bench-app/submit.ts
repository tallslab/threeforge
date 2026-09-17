import { computeResultId } from '../scripts/bench-id.mjs';
import { type BenchMetrics, METRIC_KEYS, type SceneId } from '../test/app/benchMetrics.js';

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

/** `YYYY-MM-DD-<hash of gpu, ua, backend>`: the file name under bench/devices. `scripts/bench-schema.mjs`
 * recomputes this same id from a submitted result's `createdAt` and `env` to confirm it wasn't forged. */
export function resultId(env: DeviceEnv, now: Date): string {
  return computeResultId(env, now.toISOString().slice(0, 10));
}

const round = (n: number, digits: number): number => Number(n.toFixed(digits));
const cap = (s: string): string => (s.length > 200 ? s.slice(0, 200) : s);

/** Maps one character outside `scripts/bench-schema.mjs`'s printable-ASCII-minus-`|`-and-backtick charset to
 * something that survives: a control character (including newline) becomes a space, anything else becomes `?`. */
function sanitizeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return ' ';
  if (code === 0x60 || code === 0x7c || code > 0x7e) return '?';
  return ch;
}

// The Unicode "Combining Diacritical Marks" block (U+0300-U+036F): what NFKD decomposes an accented Latin letter
// into (base letter + combining mark), e.g. 'é' -> 'e' + U+0301. Written as \u escapes, never as literal combining
// characters, so the range is legible in source instead of rendering as an invisible accent on the char before it.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Normalizes a raw driver/browser string (`env.gpu`/`platform`/`ua`/`three`) to what
 * `scripts/bench-schema.mjs`'s charset accepts, so a real device is never rejected at ingest for a string it had
 * no part in choosing: `NVIDIA® GeForce RTX™ 4080` (WebGPU `adapter.info`/`UNMASKED_RENDERER_WEBGL` routinely
 * carry `®`/`™`) becomes `NVIDIA(R) GeForce RTX(TM) 4080` and validates. `®`/`™`/`©` become their ASCII spellings
 * first (NFKD alone only decomposes `™`, and not to the parenthesised form), then NFKD normalization plus
 * stripping combining marks turns an accented Latin letter into its unaccented base (`é` → `e`) where one exists,
 * then anything still outside the allowed set is replaced (see `sanitizeChar`), and the 200-character cap applies
 * last. Called wherever `env` is built (`bench-app/runner.ts`), before the id is hashed (`resultId`) and before
 * the issue body is built, so the id, the validated result and the displayed string always agree.
 */
export function normalizeEnvString(raw: string): string {
  const symbols = raw.replace(/®/g, '(R)').replace(/™/g, '(TM)').replace(/©/g, '(C)');
  const unaccented = symbols.normalize('NFKD').replace(COMBINING_MARKS, '');
  return cap(Array.from(unaccented, sanitizeChar).join(''));
}

/** Rounded numbers and capped strings: smaller issue bodies, same information. */
export function compact(r: DeviceResult): DeviceResult {
  const scenes = {} as DeviceResult['scenes'];
  for (const [id, block] of Object.entries(r.scenes) as Array<
    [SceneId, { naive: BenchMetrics; optimized: BenchMetrics }]
  >) {
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
      objects: Math.round(m.objects),
      autoUpdatedMatrices: Math.round(m.autoUpdatedMatrices),
      shadowPassesPerFrame: round(m.shadowPassesPerFrame, 2),
    });
    scenes[id] = { naive: c(block.naive), optimized: c(block.optimized) };
  }
  return {
    ...r,
    env: {
      ...r.env,
      gpu: cap(r.env.gpu),
      ua: cap(r.env.ua),
      platform: cap(r.env.platform),
      dpr: round(r.env.dpr, 2),
      fillRateGPix: r.env.fillRateGPix === null ? null : round(r.env.fillRateGPix, 2),
    },
    scenes,
  };
}

/** The issue-body form: metrics as arrays in `metricKeys` order (about a third of the size, so the prefilled URL fits). */
export interface WireResult extends Omit<DeviceResult, 'scenes'> {
  metricKeys: ReadonlyArray<keyof BenchMetrics>;
  scenes: Record<SceneId, { naive: number[]; optimized: number[] }>;
}

export { METRIC_KEYS };

export function toWire(r: DeviceResult): WireResult {
  const c = compact(r);
  const scenes = {} as WireResult['scenes'];
  for (const [id, block] of Object.entries(c.scenes) as Array<
    [SceneId, { naive: BenchMetrics; optimized: BenchMetrics }]
  >) {
    scenes[id] = {
      naive: METRIC_KEYS.map((k) => block.naive[k]),
      optimized: METRIC_KEYS.map((k) => block.optimized[k]),
    };
  }
  return {
    schemaVersion: c.schemaVersion,
    kind: c.kind,
    id: c.id,
    createdAt: c.createdAt,
    env: c.env,
    metricKeys: METRIC_KEYS,
    scenes,
  };
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
