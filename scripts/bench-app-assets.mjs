// Fills bench-app/public (gitignored) with what the device bench page needs: three's Draco and Basis decoders,
// the eight Kenney mini characters the crowd scene loads, the lake's water normal map, a trimmed kits-index.json
// and devices.json (the ingested device results). Needs the kits: FORGE_KITS_ONLY=1 pnpm assets:kits
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = 'test/assets/files';
const out = 'bench-app/public';
const CHARACTERS = /\/character-(?:male|female)-[a-d]\.glb$/i;

function fail(message) {
  console.error(`bench-app assets: ${message}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const libs = 'node_modules/three/examples/jsm/libs';
cpSync(`${libs}/draco/gltf`, join(out, '_decoders/draco'), { recursive: true });
cpSync(`${libs}/basis`, join(out, '_decoders/basis'), { recursive: true });

const kitsIndexPath = join(root, 'kits-index.json');
if (!existsSync(kitsIndexPath)) fail(`${kitsIndexPath} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
const kits = JSON.parse(readFileSync(kitsIndexPath, 'utf8'));
const characters = kits.find((k) => k.name === 'kenney-mini-characters' && !k.error);
if (!characters?.glbs) fail('kenney-mini-characters kit is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits');
const glbs = characters.glbs.filter((g) => CHARACTERS.test(g));
if (glbs.length !== 8) fail(`expected 8 character GLBs in the mini-characters kit, found ${glbs.length}`);
for (const g of glbs) {
  mkdirSync(dirname(join(out, g)), { recursive: true });
  cpSync(join(root, g), join(out, g));
}
writeFileSync(join(out, 'kits-index.json'), JSON.stringify([{ ...characters, glbs, textures: [] }]) + '\n');

const water = 'waternormals/waternormals.jpg';
if (!existsSync(join(root, water))) fail(`${join(root, water)} is missing; run: FORGE_KITS_ONLY=1 pnpm assets:kits`);
mkdirSync(join(out, 'waternormals'), { recursive: true });
cpSync(join(root, water), join(out, water));

const devices = existsSync('bench/devices/index.json') ? readFileSync('bench/devices/index.json', 'utf8') : '[]\n';
writeFileSync(join(out, 'devices.json'), devices);
console.log(`bench-app assets: decoders, ${glbs.length} characters, water normals, ${JSON.parse(devices).length} device results → ${out}`);
