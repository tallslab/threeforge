/**
 * Confines a local path built from a remote-derived name (a glTF `buffers[]`/`images[]` URI, a Poly Haven API
 * filename, a zip entry) to a root directory, the way `src/cli/gltf-uris.ts`'s `assertConfinedUri` confines
 * `optimize`'s glTF resource URIs. `fetch-assets.mjs` and `fetch-kits.mjs` join such names into local download paths
 * without rejecting `..` or absolute paths; a compromised upstream (a sample repo, the Poly Haven API, or a hostile
 * zip entry) could otherwise write a file outside `test/assets/files/`, e.g. `../../../scripts/copy-decoders.mjs`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

/** `file:`, `http:`, `data:` (never reached here; call sites skip `data:` URIs before calling), a Windows drive
 * letter (`C:`). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function fail(uri, problem) {
  throw new Error(`safeLocalPath: ${JSON.stringify(uri)} ${problem}`);
}

function checkPathText(uri, text) {
  if (text.includes('\0')) fail(uri, 'contains a NUL character');
  if (text.includes('\\')) fail(uri, 'contains a backslash');
  if (SCHEME.test(text)) fail(uri, 'has a URI scheme');
  if (posix.isAbsolute(text) || win32.isAbsolute(text)) fail(uri, 'is an absolute path');
}

/** `target` is `base` or nested inside it. */
function isInside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The nearest ancestor of `path` (possibly `path` itself) that exists on disk. */
function nearestExistingAncestor(path) {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * The local path to write `uri` (a remote-derived, possibly percent-encoded relative name) into, confined to `root`.
 * Throws for: a non-string or empty `uri`; a NUL byte or backslash, raw or decoded; a URI scheme (`http:`, `file:`,
 * a Windows drive letter); an absolute path (POSIX or Windows), raw or decoded; text that is not valid
 * percent-encoding; a decoded path that resolves outside `root` (`../x`, `a/../../x`). Otherwise returns
 * `join(root, decodeURIComponent(uri))`.
 *
 * A full defense against a symlink escape for a path that does not exist yet needs walking every ancestor as it is
 * created (`assertConfinedUri` in `src/cli/gltf-uris.ts` does this for `optimize`'s writes, which land in an
 * arbitrary caller-given directory). A fresh download doesn't need that: every call site here downloads into a
 * directory it just created itself, so only an *existing* symlinked ancestor of `root` could redirect the write.
 * This checks that cheaply — one `realpathSync(root)` plus one `realpathSync` of the nearest existing ancestor of
 * the target — and skips it when `root` itself doesn't exist yet (nothing to redirect through).
 */
export function safeLocalPath(root, uri) {
  if (typeof uri !== 'string' || uri === '')
    fail(uri, `is ${typeof uri === 'string' ? 'empty' : `a ${typeof uri}`}, not a non-empty string`);
  checkPathText(uri, uri);
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return fail(uri, 'is not valid percent-encoding');
  }
  checkPathText(uri, decoded);
  const base = resolve(root);
  const target = resolve(base, decoded);
  if (!isInside(base, target)) fail(uri, `resolves outside ${root}`);
  if (existsSync(base)) {
    const realBase = realpathSync(base);
    const realAncestor = realpathSync(nearestExistingAncestor(target));
    if (!isInside(realBase, realAncestor)) fail(uri, `resolves outside ${root} through a symlink`);
  }
  return join(root, decoded);
}
