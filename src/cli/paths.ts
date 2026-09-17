import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, sep, win32 } from 'node:path';
import { UsageError } from './errors.js';

/**
 * Path confinement shared by `gltf-uris.ts` (glTF resource URIs), `mcp.ts` (`optimize_asset.out`) and `server.ts`
 * (the static server's roots). `scripts/fetch-safe.mjs` mirrors these rules for the download scripts, which node runs
 * without a build.
 */

/** `file:`, `http:`, `data:` (checked separately by callers), and a Windows drive letter (`C:`). */
export const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `target` is `base` or nested inside it. A child whose name merely starts with `..` (`..cache`) is inside. */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path of `target`, every symlink followed. A path that does not exist yet (a file a write will create)
 * resolves through its nearest existing ancestor with the missing segments appended; nothing exists at them, so
 * none is a symlink. `null` when an entry exists but cannot be resolved (a dangling or looping symlink), which a
 * write would follow.
 */
export function realPathOf(target: string): string | null {
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

/** Refuses, through `refuse`, text that is not a plain relative path: a NUL, a backslash, a URI scheme, an absolute path (POSIX or Windows). */
export function checkPathText(text: string, refuse: (problem: string) => never): void {
  if (text.includes('\0')) refuse('contains a NUL character');
  if (text.includes('\\')) refuse('contains a backslash');
  if (SCHEME.test(text)) refuse('has a URI scheme (only data: URIs are allowed)');
  if (posix.isAbsolute(text) || win32.isAbsolute(text)) refuse('is an absolute path');
}

/**
 * The output-path rule the CLI's `--out` and MCP's `optimize_asset.out` share: `UsageError` unless `target` is a
 * glTF path. `field` names the caller's option in the message; `shown` is the text the caller gave (default `target`).
 */
export function assertGltfOutPath(target: string, field: string, shown: string = target): void {
  if (!/\.(glb|gltf)$/i.test(target)) throw new UsageError(`${field} must end in .glb or .gltf (got ${shown})`);
}
