// Fills bench-app/public (gitignored) with what the device bench page needs: three's Draco and Basis decoders,
// the eight Kenney mini characters the crowd scene loads, the lake's water normal map, a trimmed kits-index.json
// and devices.json (the ingested device results). Needs the kits: FORGE_KITS_ONLY=1 pnpm assets:kits
//
// FORGE_BENCH_APP_OPTIONAL=1 turns a missing kit from an exit-1 into a warning, writing an empty kits-index.json
// instead. Playwright's port-5180 `webServer` sets it: a `webServer` command that exits non-zero
// fails the entire Playwright run rather than one spec, so without this a kit-less runner loses all 91 non-corpus
// tests per project, not just `bench-app.spec.ts`. The degraded page still serves `village` and `rpg` — the only
// two scenes `bench-app.spec.ts` runs, both fully procedural — while `crowd` (`kenney-mini-characters kit not
// found`) and `lake` (the water map 404s) fail closed, so nothing can be measured against absent assets.
// `pnpm build:bench-app` and `pnpm bench:app` do not set it: a published page always needs the real kits.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = 'test/assets/files';
const out = 'bench-app/public';
const CHARACTERS = /\/character-(?:male|female)-[a-d]\.glb$/i;
const optional = process.env.FORGE_BENCH_APP_OPTIONAL === '1';

/** Exits 1, or — under FORGE_BENCH_APP_OPTIONAL=1 — warns and returns `null` so the caller can skip that asset. */
function fail(message) {
  if (optional) {
    console.error(`bench-app assets: ${message}; continuing without it (FORGE_BENCH_APP_OPTIONAL=1). Scenes that need the kits fail closed.`);
    return null;
  }
  console.error(`bench-app assets: ${message}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const libs = 'node_modules/three/examples/jsm/libs';
cpSync(`${libs}/draco/gltf`, join(out, '_decoders/draco'), { recursive: true });
cpSync(`${libs}/basis`, join(out, '_decoders/basis'), { recursive: true });

/** The mini-characters entry trimmed to its eight character GLBs, or `null` when the kit is not usable. */
function characterKit() {
  const kitsIndexPath = join(root, 'kits-index.json');
  if (!existsSync(kitsIndexPath)) return fail(`${kitsIndexPath} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
  const kits = JSON.parse(readFileSync(kitsIndexPath, 'utf8'));
  const characters = kits.find((k) => k.name === 'kenney-mini-characters' && !k.error);
  if (!characters?.glbs) return fail('kenney-mini-characters kit is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits');
  const glbs = characters.glbs.filter((g) => CHARACTERS.test(g));
  if (glbs.length !== 8) return fail(`expected 8 character GLBs in the mini-characters kit, found ${glbs.length}`);
  return { ...characters, glbs, textures: [] };
}

const kit = characterKit();
for (const g of kit?.glbs ?? []) {
  mkdirSync(dirname(join(out, g)), { recursive: true });
  cpSync(join(root, g), join(out, g));
}
// An empty index rather than no file at all: `crowd.ts` then throws its own named error instead of reading a 404.
writeFileSync(join(out, 'kits-index.json'), JSON.stringify(kit ? [kit] : []) + '\n');

const water = 'waternormals/waternormals.jpg';
const hasWater = existsSync(join(root, water)) || fail(`${join(root, water)} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
if (hasWater) {
  mkdirSync(join(out, 'waternormals'), { recursive: true });
  cpSync(join(root, water), join(out, water));
}

const devices = existsSync('bench/devices/index.json') ? readFileSync('bench/devices/index.json', 'utf8') : '[]\n';
writeFileSync(join(out, 'devices.json'), devices);
console.log(`bench-app assets: decoders, ${kit?.glbs.length ?? 0} characters, ${hasWater ? 1 : 0} water normals, ${JSON.parse(devices).length} device results → ${out}`);
