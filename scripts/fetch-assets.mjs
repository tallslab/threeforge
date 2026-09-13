/**
 * Downloads the public glTF test assets listed in test/assets/manifest.json into test/assets/files/ (gitignored),
 * including the buffers and images a .gltf references, plus the Draco and Basis decoders from node_modules.
 * Usage: node scripts/fetch-assets.mjs [name ...]
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = 'test/assets/files';
const manifest = JSON.parse(await readFile('test/assets/manifest.json', 'utf8'));
const only = new Set(process.argv.slice(2));
const assets = only.size ? manifest.assets.filter((a) => only.has(a.name)) : manifest.assets;

async function exists(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function download(url, dest) {
  const have = await exists(dest);
  if (have > 0) return { bytes: have, cached: true };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buffer);
  return { bytes: buffer.length, cached: false };
}

const index = [];
let total = 0;
for (const asset of assets) {
  const dir = join(root, asset.name);
  const entry = decodeURIComponent(asset.url.split('/').pop());
  const entryPath = join(dir, entry);
  const files = [];
  try {
    const first = await download(asset.url, entryPath);
    files.push({ file: entry, bytes: first.bytes });
    if (entry.endsWith('.gltf')) {
      const json = JSON.parse(await readFile(entryPath, 'utf8'));
      const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x.uri).filter((u) => u && !u.startsWith('data:'));
      for (const uri of uris) {
        const url = new URL(uri, asset.url).href;
        const local = join(dir, decodeURIComponent(uri));
        const r = await download(url, local);
        files.push({ file: decodeURIComponent(uri), bytes: r.bytes });
      }
    }
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    total += bytes;
    index.push({ name: asset.name, entry: `${asset.name}/${entry}`, tags: asset.tags, source: asset.source, bytes, files: files.length });
    console.log(`${asset.name.padEnd(34)} ${(bytes / 1e6).toFixed(2).padStart(7)} MB  ${files.length} file(s)`);
  } catch (error) {
    console.log(`${asset.name.padEnd(34)} FAILED ${error.message}`);
    index.push({ name: asset.name, entry: `${asset.name}/${entry}`, tags: asset.tags, source: asset.source, error: error.message });
  }
}

// Decoders served next to the assets: /_decoders/draco/ and /_decoders/basis/
for (const [from, to] of [
  ['node_modules/three/examples/jsm/libs/draco/gltf', join(root, '_decoders/draco')],
  ['node_modules/three/examples/jsm/libs/basis', join(root, '_decoders/basis')],
]) {
  await mkdir(to, { recursive: true });
  for (const f of await readdir(from)) if (!f.endsWith('.md')) await copyFile(join(from, f), join(to, f));
}
await writeFile(join(root, 'index.json'), JSON.stringify(index, null, 2));
console.log(`\n${index.filter((a) => !a.error).length}/${index.length} assets ready, ${(total / 1e6).toFixed(1)} MB in ${root}`);
