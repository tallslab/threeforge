// Renders docs/devices.md and bench/devices/index.json from bench/devices/*.json (device results from issues).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_IDS } from './bench-schema.mjs';

const TIER_ORDER = { 'phone-low': 0, 'phone-mid': 1, desktop: 2 };
const short = (s) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

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
    return `| ${short(r.env.gpu)} (${short(r.env.platform)}) | ${r.env.backend} | ${r.env.tier} | ${r.env.fillRateGPix === null ? '–' : r.env.fillRateGPix.toFixed(1)} | ${cells.join(' | ')} | ${r.createdAt.slice(0, 10)} |`;
  });
  return [head, sep, ...rows].join('\n');
}

export function readResults(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** Writes `<dir>/index.json` (what the page fetches as devices.json) and the markdown table; returns the count. */
export function writeDevices(dir, docsPath) {
  const results = sortResults(readResults(dir));
  writeFileSync(join(dir, 'index.json'), JSON.stringify(results) + '\n');
  const body = results.length ? renderDevices(results) : '_No device results yet. Run the bench page on your phone and submit the result._';
  writeFileSync(docsPath, `# Device results\n\nSubmitted from the bench page (see \`docs/superpowers/specs/2026-09-14-device-bench-page-design.md\`) as GitHub issues and ingested by the \`bench-results\` workflow. Each cell is naive → optimized: scene submissions / median frame ms over 60 frames. Fill rate is a two-second probe (transparent fullscreen layers), informational.\n\n${body}\n`);
  return results.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`${writeDevices('bench/devices', 'docs/devices.md')} device results`);
}
