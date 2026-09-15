/**
 * Second asset source: Kenney CC0 kits (zips of many low-poly GLBs sharing palette textures), Poly Haven CC0
 * models (heavy realistic props via their API, 1k textures), and a few single files (three.js car, water normals).
 * Writes test/assets/files/kits-index.json. Usage: node scripts/fetch-kits.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLocalPath } from './fetch-safe.mjs';

const root = 'test/assets/files';
const kits = [
  { name: 'kenney-nature-kit', url: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip' },
  { name: 'kenney-car-kit', url: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip' },
  { name: 'kenney-city-kit-suburban', url: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip' },
  { name: 'kenney-city-kit-roads', url: 'https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1787042796/kenney_city-kit-roads.zip' },
  { name: 'kenney-survival-kit', url: 'https://kenney.nl/media/pages/assets/survival-kit/4065a8185b-1712149243/kenney_survival-kit.zip' },
  // Game content: arena, dungeon, weapons, animated characters, particle textures.
  { name: 'kenney-mini-arena', url: 'https://kenney.nl/media/pages/assets/mini-arena/88f977a0cb-1709220730/kenney_mini-arena.zip' },
  { name: 'kenney-mini-dungeon', url: 'https://kenney.nl/media/pages/assets/mini-dungeon/6cd72dc849-1785314274/kenney_mini-dungeon.zip' },
  { name: 'kenney-blaster-kit', url: 'https://kenney.nl/media/pages/assets/blaster-kit/261d80a716-1753959510/kenney_blaster-kit_2.1.zip' },
  { name: 'kenney-mini-characters', url: 'https://kenney.nl/media/pages/assets/mini-characters/bfc7e272b4-1774770718/kenney_mini-characters.zip' },
  { name: 'kenney-modular-characters', url: 'https://kenney.nl/media/pages/assets/modular-characters/d84577feef-1677670340/kenney_modular-characters.zip' },
  { name: 'kenney-blocky-characters', url: 'https://kenney.nl/media/pages/assets/blocky-characters/8369c0cf30-1749547469/kenney_blocky-characters_20.zip' },
  { name: 'kenney-particle-pack', url: 'https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip', textures: true },
];
const polyhavenExplicit = ['boulder_01', 'coast_rocks_01', 'coast_rocks_02', 'dead_tree_trunk_02', 'dead_quiver_trunk', 'covered_car', 'anthurium_botany_01', 'dandelion_01', 'dry_branches_medium_01', 'barrel_03', 'ammo_box', 'CoffeeCart_01'];
const T = 'https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/';
const singles = [
  { name: 'ferrari', url: T + 'models/gltf/ferrari.glb', tags: ['car', 'many-materials', 'transparent'] },
  { name: 'waternormals', url: T + 'textures/waternormals.jpg', tags: ['texture'] },
  // VFX / lighting textures from the three.js examples.
  ...['textures/sprites/spark1.png', 'textures/sprites/disc.png', 'textures/sprites/circle.png', 'textures/sprites/ball.png', 'textures/sprites/snowflake1.png', 'textures/lensflare/lensflare0.png', 'textures/lensflare/lensflare3.png', 'textures/sprite0.png', 'textures/disturb.jpg', 'textures/decal/decal-diffuse.png', 'textures/decal/decal-normal.jpg', 'textures/brick_diffuse.jpg', 'textures/brick_bump.jpg', 'textures/hardwood2_diffuse.jpg'].map((f) => ({ name: 'three-textures', url: T + f, tags: ['texture'] })),
];

async function size(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
async function download(url, dest) {
  if ((await size(dest)) > 0) return await size(dest);
  const res = await fetch(url, { headers: { 'user-agent': 'threeforge-asset-fetch' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);
  return buffer.length;
}
async function walk(dir, out = []) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Lists `zip`'s entries with `unzip -Z1` and runs each through `safeLocalPath(dir, entry)` before extraction, so a
 * hostile entry (zip-slip: `../../x`, an absolute path) is refused by this script rather than relying on `unzip`'s
 * own `-o` behaviour. Directory entries (trailing `/`) are skipped; `safeLocalPath` throws, naming the entry, on
 * anything that would land outside `dir`. */
function checkZipEntries(zip, dir) {
  const listing = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  for (const rawEntry of listing.split('\n')) {
    const entry = rawEntry.trim();
    if (!entry || entry.endsWith('/')) continue;
    safeLocalPath(dir, entry);
  }
}

/** Downloads every kit, Poly Haven model and single file into `root`. The only top-level side effect is the entry
 * guard below, so importing this module (e.g. from a test) does no network or filesystem writes. */
export async function main() {
  const index = [];
  for (const kit of kits) {
    try {
      const zip = join(root, '_zips', `${kit.name}.zip`);
      const bytes = await download(kit.url, zip);
      const dir = join(root, kit.name);
      if ((await size(join(dir, '.extracted'))) === 0) {
        await mkdir(dir, { recursive: true });
        checkZipEntries(zip, dir);
        execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
        await writeFile(join(dir, '.extracted'), 'ok');
      }
      const all = await walk(dir);
      const glbs = all.filter((p) => p.toLowerCase().endsWith('.glb')).map((p) => relative(root, p));
      const textures = kit.textures ? all.filter((p) => /\.(png|jpg)$/i.test(p)).map((p) => relative(root, p)) : [];
      index.push({ name: kit.name, kind: 'kit', source: 'kenney.nl (CC0)', bytes, glbs, textures, tags: ['kit', 'low-poly', 'shared-palette'] });
      console.log(`${kit.name.padEnd(30)} ${(bytes / 1e6).toFixed(1).padStart(6)} MB  ${glbs.length} glb  ${textures.length} textures`);
    } catch (e) {
      console.log(`${kit.name.padEnd(30)} FAILED ${e.message}`);
      index.push({ name: kit.name, kind: 'kit', error: e.message });
    }
  }

  // Poly Haven models are the hi-poly corpus for the asset report; the benchmark scenes only need the kits and
  // singles, so CI sets FORGE_KITS_ONLY=1 to skip this section.
  if (!process.env.FORGE_KITS_ONLY) {
    // Poly Haven: explicit picks plus a few from the trees and vehicles categories.
    let ids = [...polyhavenExplicit];
    try {
      const all = await (await fetch('https://api.polyhaven.com/assets?t=models')).json();
      const pick = (cat, n) => Object.entries(all).filter(([, v]) => (v.categories ?? []).includes(cat)).map(([k]) => k).slice(0, n);
      ids = [...new Set([...ids, ...pick('trees', 4), ...pick('vehicles', 4)])];
    } catch (e) {
      console.log(`polyhaven list FAILED ${e.message}`);
    }
    for (const id of ids) {
      try {
        const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
        const res = files.gltf?.['1k'] ?? files.gltf?.[Object.keys(files.gltf ?? {})[0]];
        if (!res?.gltf?.url) throw new Error('no gltf variant');
        const dir = join(root, `polyhaven-${id}`);
        const entryUrl = res.gltf.url;
        const rawEntryName = entryUrl.split('/').pop();
        const entryName = decodeURIComponent(rawEntryName);
        // safeLocalPath decodes internally; pass the raw (still-encoded) name so it isn't decoded twice.
        let bytes = await download(entryUrl, safeLocalPath(dir, rawEntryName));
        for (const [rel, info] of Object.entries(res.gltf.include ?? {})) bytes += await download(info.url, safeLocalPath(dir, rel));
        index.push({ name: `polyhaven-${id}`, entry: `polyhaven-${id}/${entryName}`, source: 'polyhaven.com (CC0)', bytes, tags: ['polyhaven', 'pbr', 'hi-poly'] });
        console.log(`${('polyhaven-' + id).padEnd(30)} ${(bytes / 1e6).toFixed(1).padStart(6)} MB`);
      } catch (e) {
        console.log(`${('polyhaven-' + id).padEnd(30)} FAILED ${e.message}`);
        index.push({ name: `polyhaven-${id}`, error: e.message });
      }
    }
  }

  for (const single of singles) {
    try {
      const name = single.url.split('/').pop();
      const bytes = await download(single.url, safeLocalPath(join(root, single.name), name));
      if (single.name === 'three-textures') {
        const existing = index.find((e) => e.name === 'three-textures') ?? (index.push({ name: 'three-textures', kind: 'kit', textures: [], glbs: [], source: 'mrdoob/three.js examples', bytes: 0, tags: ['texture'] }), index[index.length - 1]);
        existing.textures.push(`three-textures/${name}`);
        existing.bytes += bytes;
        continue;
      }
      index.push({ name: single.name, entry: `${single.name}/${name}`, source: single.url, bytes, tags: single.tags });
      console.log(`${single.name.padEnd(30)} ${(bytes / 1e6).toFixed(1).padStart(6)} MB`);
    } catch (e) {
      console.log(`${single.name.padEnd(30)} FAILED ${e.message}`);
      index.push({ name: single.name, error: e.message });
    }
  }
  await writeFile(join(root, 'kits-index.json'), JSON.stringify(index, null, 2));
  console.log(`\nkits-index.json: ${index.filter((a) => !a.error).length}/${index.length} ok`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
