import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { UsageError } from './errors.js';
import { cleanText } from './untrusted.js';

/**
 * glTF-Transform's `NodeIO` (4.5) resolves every `images[].uri` and `buffers[].uri` against the input's directory
 * with `path.resolve(dir, decodeURIComponent(uri))` and no confinement, and writes a `.gltf` output's resources to
 * `path.join(dirname(out), decodeURIComponent(uri))` after `mkdir -p`. An audit got `../../.ssh/id_ed25519` embedded
 * into `<name>.forge.glb`. There is no pre-read hook, so `optimize` reads the JSON itself (`readGltfJson`) and checks
 * the URIs (`assertConfinedUris`) before `io.read`, and checks the URIs the writer will use before `io.write` of a
 * `.gltf` (`src/cli/optimize.ts`).
 *
 * `analyze` needs it too, and said the opposite until the independent review (C1). The static server
 * (`src/cli/server.ts`) does confine every request to its roots by real path, but three's `LoaderUtils.resolveURL`
 * (r186, `node_modules/three/src/loaders/LoaderUtils.js`) returns an absolute `http(s)://` or protocol-relative
 * `//host/` URI *unchanged*, so `GLTFLoader` fetches it from the page and never reaches that server at all. So
 * `analyze` (and the MCP `analyze_asset`) runs the same `assertConfinedUris` before it opens a browser, and confines
 * the page to the served origin with a catch-all route as well (`routeGuard`, `src/cli/analyze.ts`).
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
/** How much of a URI an error message quotes. */
const URI_QUOTE_MAX = 200;
/** `file:`, `http:`, `data:` (checked separately), and a Windows drive letter (`C:`). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function messageOf(error: unknown): string {
  return cleanText(error instanceof Error ? error.message : String(error), 300);
}

function readExactly(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = readSync(fd, buffer, offset, length - offset, position + offset);
    if (n === 0) break;
    offset += n;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

/**
 * The JSON of a glTF file, read the way glTF-Transform reads it: a file that starts with the GLB header (magic `glTF`,
 * version 2, its `isGLB`) is binary whatever its extension, and its first chunk must be JSON; anything else is parsed
 * as JSON text. Of a GLB only the header and the JSON chunk are read. Unreadable or malformed input is a `UsageError`.
 */
export function readGltfJson(file: string): Record<string, unknown> {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${messageOf(error)}`);
  }
  try {
    const size = fstatSync(fd).size;
    const header = readExactly(fd, 0, Math.min(20, size));
    let bytes: Buffer;
    if (header.length >= 12 && header.readUInt32LE(0) === GLB_MAGIC && header.readUInt32LE(4) === GLB_VERSION) {
      if (header.length < 20 || header.readUInt32LE(16) !== CHUNK_JSON) throw new UsageError(`cannot read ${file}: the GLB does not start with a JSON chunk`);
      const length = header.readUInt32LE(12);
      if (20 + length > size) throw new UsageError(`cannot read ${file}: the GLB JSON chunk runs past the end of the file`);
      bytes = readExactly(fd, 20, length);
    } else {
      bytes = readExactly(fd, 0, size);
    }
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new UsageError(`cannot read ${file}: the glTF JSON is not an object`);
    return json as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`cannot read ${file}: ${messageOf(error)}`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks `images[].uri` and `buffers[].uri`, the only URIs glTF-Transform reads (`_readResourcesExternal`) or writes,
 * with `assertConfinedUri` against `baseDir`. Entries without a URI (GLB-embedded images, the GLB buffer) pass; an
 * `images` or `buffers` that is present but not an array is refused.
 */
export function assertConfinedUris(json: { images?: unknown; buffers?: unknown }, baseDir: string): void {
  for (const key of ['images', 'buffers'] as const) {
    const list = json[key];
    if (!list) continue; // glTF-Transform reads `json.images || []`.
    if (!Array.isArray(list)) throw new UsageError(`${key} must be an array`);
    list.forEach((entry: unknown, i) => {
      if (entry !== null && typeof entry === 'object') assertConfinedUri((entry as { uri?: unknown }).uri, `${key}[${i}].uri`, baseDir);
    });
  }
}

/** One external resource of a glTF document: where its URI sits in the JSON, the URI, and the file it names. */
export interface ResourcePath {
  where: string;
  uri: string;
  path: string;
}

/**
 * The files the external `images[].uri` and `buffers[].uri` of `json` name, resolved as glTF-Transform resolves them
 * (`path.resolve(baseDir, decodeURIComponent(uri))`). `data:` URIs and entries without a URI name no file. Call it after
 * `assertConfinedUris`; a URI that does not decode is skipped here because that check already refused it.
 */
export function resourcePathsOf(json: { images?: unknown; buffers?: unknown }, baseDir: string): ResourcePath[] {
  const paths: ResourcePath[] = [];
  for (const key of ['images', 'buffers'] as const) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    list.forEach((entry: unknown, i) => {
      const uri = entry !== null && typeof entry === 'object' ? (entry as { uri?: unknown }).uri : undefined;
      if (typeof uri !== 'string' || uri === '' || uri.startsWith('data:')) return;
      try {
        paths.push({ where: `${key}[${i}].uri`, uri, path: resolve(baseDir, decodeURIComponent(uri)) });
      } catch {
        // Undecodable: assertConfinedUri refuses it before this runs.
      }
    });
  }
  return paths;
}

/**
 * Refuses a resource URI that could make glTF-Transform read or write outside `baseDir` (`UsageError`, exit 2, naming
 * `where`). Allowed: no URI (`undefined`, `null`, `''`), a `data:` URI, a relative path. Refused, on the raw text and
 * again after the one `decodeURIComponent` glTF-Transform applies: a NUL; a backslash (a separator on Windows); any
 * other scheme (`file:`, `http:`, a drive letter like `C:`); an absolute path (`/x`, `//host/x`). Then: a non-string,
 * text that is not valid percent-encoding (glTF-Transform would throw on it), a path that resolves outside `baseDir`,
 * and a path whose real location is outside the real `baseDir` (every existing symlink followed; a path not written
 * yet through its nearest existing ancestor), including a dangling symlink, which a write would follow.
 */
export function assertConfinedUri(uri: unknown, where: string, baseDir: string): void {
  if (uri === undefined || uri === null || uri === '') return;
  if (typeof uri !== 'string') throw new UsageError(`${where} is not a string (got ${typeof uri})`);
  const refuse = (problem: string): never => {
    throw new UsageError(`${where} ${JSON.stringify(cleanText(uri, URI_QUOTE_MAX))} ${problem}`);
  };
  if (uri.startsWith('data:')) return;
  checkPathText(uri, refuse);
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return refuse('is not valid percent-encoding');
  }
  checkPathText(decoded, refuse);
  const base = resolve(baseDir);
  const target = resolve(base, decoded);
  if (!isInside(base, target)) refuse(`resolves outside ${baseDir}`);
  const realTarget = realPathOf(target);
  if (realTarget === null) refuse('is a symlink that cannot be resolved');
  const realBase = realPathOf(base);
  if (realBase === null || !isInside(realBase, realTarget as string)) refuse(`resolves outside ${baseDir} through a symlink`);
}

function checkPathText(text: string, refuse: (problem: string) => never): void {
  if (text.includes('\0')) refuse('contains a NUL character');
  if (text.includes('\\')) refuse('contains a backslash');
  if (SCHEME.test(text)) refuse('has a URI scheme (only data: URIs are allowed)');
  if (posix.isAbsolute(text) || win32.isAbsolute(text)) refuse('is an absolute path');
}

/** `target` is `base` or nested inside it. */
function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path of `target`, every symlink followed. A path that does not exist yet (a resource a `.gltf` write will
 * create) resolves through its nearest existing ancestor with the missing segments appended; nothing exists at them,
 * so none is a symlink. `null` when an entry exists but cannot be resolved (a dangling or looping symlink).
 */
function realPathOf(target: string): string | null {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      if (entryExists(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Something is at `path`, a symlink included (dangling or not): `lstat`, which, unlike `existsSync`, never follows the final link. */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
