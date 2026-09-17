// Renders docs/devices.md and bench/devices/index.json from bench/devices/*.json (device results from issues).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_IDS, validateDeviceResult } from './bench-schema.mjs';

const TIER_ORDER = { 'phone-low': 0, 'phone-mid': 1, desktop: 2 };
const short = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
/** Escapes a value for a Markdown table cell: `|` would end the cell early and a newline would end the row. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/**
 * A free-form submitted string (GPU, platform) as a code span inside a table cell. The schema's safe charset admits
 * `[ ] ( ) ! < >`, so as plain text `[Apple M2](https://phish.example)` or `<img src=…>` would render as a live link,
 * image or element on GitHub; inside a code span nothing renders, bare URLs included. The schema bans backticks, and
 * any that reach here anyway become `'`, so a value cannot close its own span.
 */
const code = (s) => `\`${cell(s).replace(/`/g, "'")}\``;

/** Low tier first, then by GPU name, newest first for the same device. */
export function sortResults(results) {
  return [...results].sort((a, b) => TIER_ORDER[a.env.tier] - TIER_ORDER[b.env.tier] || a.env.gpu.localeCompare(b.env.gpu) || b.createdAt.localeCompare(a.createdAt));
}

/** Markdown: one row per result: device, backend, tier, fill rate, per scene naive → optimized submissions / frame ms. */
export function renderDevices(results) {
  const head = `| device | backend | tier | fill GPix/s | ${SCENE_IDS.map((id) => `${id} subs / ms`).join(' | ')} | date |`;
  const sep = `|---|---|---|---|${SCENE_IDS.map(() => '---').join('|')}|---|`;
  const rows = sortResults(results).map((r) => {
    const cells = SCENE_IDS.map((id) => {
      const s = r.scenes[id];
      return `${s.naive.sceneSubmissions} → ${s.optimized.sceneSubmissions} / ${s.naive.frameMs.toFixed(1)} → ${s.optimized.frameMs.toFixed(1)}`;
    });
    const gpu = code(short(r.env.gpu));
    const platform = code(short(r.env.platform));
    const backend = cell(r.env.backend);
    const tier = cell(r.env.tier);
    const date = cell(r.createdAt.slice(0, 10));
    return `| ${gpu} (${platform}) | ${backend} | ${tier} | ${r.env.fillRateGPix === null ? '–' : r.env.fillRateGPix.toFixed(1)} | ${cells.join(' | ')} | ${date} |`;
  });
  return [head, sep, ...rows].join('\n');
}

/** Reads and validates every result file in `dir`; throws, naming the file, if one fails validation. */
export function readResults(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch (e) {
        throw new Error(`${JSON.stringify(f)}: invalid JSON (${e.message})`);
      }
      const v = validateDeviceResult(parsed);
      if (!v.ok) throw new Error(`${JSON.stringify(f)}: ${v.errors.join('; ')}`);
      return v.result;
    });
}

/** Writes `<dir>/index.json` (what the page fetches as devices.json) and the markdown table; returns the count. */
export function writeDevices(dir, docsPath) {
  const results = sortResults(readResults(dir));
  writeFileSync(join(dir, 'index.json'), JSON.stringify(results) + '\n');
  const body = results.length ? renderDevices(results) : '_No device results yet. Run the bench page on your phone and submit the result._';
  writeFileSync(docsPath, `# Device results\n\nSubmitted from the bench page (see \`docs/design.md\`) as GitHub issues and ingested by the \`bench-results\` workflow. Each cell is naive → optimized: scene submissions / median frame ms over 60 frames. Fill rate is a two-second probe (transparent fullscreen layers), informational.\n\n${body}\n`);
  return results.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`${writeDevices('bench/devices', 'docs/devices.md')} device results`);
}
