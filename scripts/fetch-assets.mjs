/**
 * Downloads the public glTF test assets listed in test/assets/manifest.json into test/assets/files/ (gitignored),
 * including the buffers and images a .gltf references, plus the Draco and Basis decoders from node_modules.
 * Usage: node scripts/fetch-assets.mjs [name ...]
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLocalPath } from './fetch-safe.mjs';
import { strictExitCode } from './fetch-strict.mjs';

const root = 'test/assets/files';

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

/**
 * The index after a run limited to some names: `existing` with each entry the run fetched replaced in place (matched
 * by `name`) and assets it did not list yet appended, so `fetch-assets Fox` never drops the other assets. A missing
 * or malformed `existing` counts as empty; rows without a string `name`, and repeats of a name, are dropped. Pure.
 */
export function mergeIndex(existing, entries) {
  const fresh = new Map(entries.map((e) => [e.name, e]));
  const seen = new Set();
  const merged = [];
  for (const row of Array.isArray(existing) ? existing : []) {
    if (!row || typeof row.name !== 'string' || seen.has(row.name)) continue;
    seen.add(row.name);
    merged.push(fresh.get(row.name) ?? row);
  }
  for (const row of entries) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    merged.push(row);
  }
  return merged;
}

async function readIndex(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Downloads `names` (every manifest asset when empty) into `root`. A run limited to `names` merges its entries into
 * the existing index.json; a full run rewrites it. Returns this run's entries, failed ones included. The only
 * top-level side effect is the entry guard below, so importing this module (e.g. from a test) does no network or
 * filesystem writes. The entry guard exits 1 under FORGE_FETCH_STRICT=1 if any download failed (fetch-strict.mjs). */
export async function main(names = []) {
  const manifest = JSON.parse(await readFile('test/assets/manifest.json', 'utf8'));
  const only = new Set(names);
  const assets = only.size ? manifest.assets.filter((a) => only.has(a.name)) : manifest.assets;

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
        const uris = [...(json.buffers ?? []), ...(json.images ?? [])]
          .map((x) => x.uri)
          .filter((u) => u && !u.startsWith('data:'));
        for (const uri of uris) {
          const url = new URL(uri, asset.url).href;
          const local = safeLocalPath(dir, uri);
          const r = await download(url, local);
          files.push({ file: decodeURIComponent(uri), bytes: r.bytes });
        }
      }
      const bytes = files.reduce((s, f) => s + f.bytes, 0);
      total += bytes;
      index.push({
        name: asset.name,
        entry: `${asset.name}/${entry}`,
        tags: asset.tags,
        source: asset.source,
        bytes,
        files: files.length,
      });
      console.log(`${asset.name.padEnd(34)} ${(bytes / 1e6).toFixed(2).padStart(7)} MB  ${files.length} file(s)`);
    } catch (error) {
      console.log(`${asset.name.padEnd(34)} FAILED ${error.message}`);
      index.push({
        name: asset.name,
        entry: `${asset.name}/${entry}`,
        tags: asset.tags,
        source: asset.source,
        error: error.message,
      });
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
  const indexPath = join(root, 'index.json');
  const written = only.size ? mergeIndex(await readIndex(indexPath), index) : index;
  await writeFile(indexPath, JSON.stringify(written, null, 2));
  console.log(
    `\n${index.filter((a) => !a.error).length}/${index.length} assets ready, ${(total / 1e6).toFixed(1)} MB in ${root}`,
  );
  if (only.size) console.log(`index.json: ${written.length} entries (merged)`);
  return index;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Judged on this run's entries only, not the merged index: a subset run is not failed by an older error it did not retry.
  process.exitCode = strictExitCode(await main(process.argv.slice(2)));
}
