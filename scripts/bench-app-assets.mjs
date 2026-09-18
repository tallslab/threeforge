// Fills bench-app/public (gitignored) with what the device bench page needs: three's Draco and Basis decoders,
// the kit models and textures the crowd and bossfight scenes load (`KIT_ASSETS`) with the files those GLBs point at,
// the lake's water normal map, a kits-index.json trimmed to the same files and devices.json (the ingested device
// results). Needs the kits: FORGE_KITS_ONLY=1 pnpm assets:kits
//
// FORGE_BENCH_APP_OPTIONAL=1 turns a missing kit from an exit-1 into a warning, writing an empty kits-index.json
// instead. Playwright's port-5180 `webServer` sets it: a `webServer` command that exits non-zero
// fails the entire Playwright run rather than one spec, so without this a kit-less runner loses all 91 non-corpus
// tests per project, not just `bench-app.spec.ts`. The degraded page still serves `village` and `rpg` — the only
// two scenes `bench-app.spec.ts` runs, both fully procedural — while `crowd` and `bossfight` (a named kit error)
// and `lake` (the water map 404s) fail closed, so nothing can be measured against absent assets.
// `pnpm build:bench-app` and `pnpm bench:app` do not set it: a published page always needs the real kits.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT_ASSETS } from './bench-app-kits.mjs';
import { copyDecoders } from './copy-decoders.mjs';

const root = 'test/assets/files';
const out = 'bench-app/public';
const optional = process.env.FORGE_BENCH_APP_OPTIONAL === '1';

/** Exits 1, or — under FORGE_BENCH_APP_OPTIONAL=1 — warns and returns `null` so the caller can skip that asset. */
function fail(message) {
  if (optional) {
    console.error(
      `bench-app assets: ${message}; continuing without it (FORGE_BENCH_APP_OPTIONAL=1). Scenes that need the kits fail closed.`,
    );
    return null;
  }
  console.error(`bench-app assets: ${message}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
copyDecoders(join(out, '_decoders'));

/** The files a GLB points at outside itself (Kenney's GLBs keep their colour map in `Textures/`), relative to `root`. */
function externalFiles(glb) {
  const file = readFileSync(join(root, glb));
  const json = JSON.parse(file.subarray(20, 20 + file.readUInt32LE(12)).toString('utf8'));
  return [...(json.images ?? []), ...(json.buffers ?? [])]
    .filter((ref) => ref.uri && !ref.uri.startsWith('data:'))
    .map((ref) => join(dirname(glb), decodeURIComponent(ref.uri)));
}

/** One kit's index entry trimmed to the listed files, found the way the scenes find them; `null` when not usable. */
function trimmedKit(kits, name, wanted) {
  const kit = kits.find((k) => k.name === name && !k.error);
  if (!kit) return fail(`${name} kit is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
  const pick = (paths, base, extensions) =>
    (paths ?? []).find((p) => extensions.some((ext) => p.toLowerCase().endsWith(`/${base}.${ext}`))) ??
    fail(`${base} is not in the ${name} kit`);
  const glbs = (wanted.glbs ?? []).map((base) => pick(kit.glbs, base, ['glb']));
  const textures = (wanted.textures ?? []).map((base) => pick(kit.textures, base, ['png', 'jpg']));
  if ([...glbs, ...textures].includes(null)) return null;
  return { ...kit, glbs, textures };
}

/** Every kit of `KIT_ASSETS`, trimmed; empty when the kits index itself is missing. */
function trimmedKits() {
  const kitsIndexPath = join(root, 'kits-index.json');
  if (!existsSync(kitsIndexPath)) {
    fail(`${kitsIndexPath} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
    return [];
  }
  const kits = JSON.parse(readFileSync(kitsIndexPath, 'utf8'));
  return Object.entries(KIT_ASSETS)
    .map(([name, wanted]) => trimmedKit(kits, name, wanted))
    .filter((kit) => kit !== null);
}

const kits = trimmedKits();
const files = new Set(kits.flatMap((kit) => [...kit.glbs, ...kit.glbs.flatMap(externalFiles), ...kit.textures]));
for (const file of files) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  cpSync(join(root, file), join(out, file));
}
// An empty index rather than no file at all: the scenes then throw their own named error instead of reading a 404.
writeFileSync(join(out, 'kits-index.json'), JSON.stringify(kits) + '\n');

const water = 'waternormals/waternormals.jpg';
const hasWater =
  existsSync(join(root, water)) || fail(`${join(root, water)} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
if (hasWater) {
  mkdirSync(join(out, 'waternormals'), { recursive: true });
  cpSync(join(root, water), join(out, water));
}

const devices = existsSync('bench/devices/index.json') ? readFileSync('bench/devices/index.json', 'utf8') : '[]\n';
writeFileSync(join(out, 'devices.json'), devices);
console.log(
  `bench-app assets: decoders, ${files.size} files of ${kits.length} kits, ${hasWater ? 1 : 0} water normals, ${JSON.parse(devices).length} device results → ${out}`,
);
