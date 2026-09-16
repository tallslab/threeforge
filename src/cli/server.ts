import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { EnvironmentError } from './errors.js';

export interface StaticRoot {
  /** URL prefix, e.g. `/` or `/asset/`. Longest match wins. */
  prefix: string;
  dir: string;
}

interface ResolvedRoot extends StaticRoot {
  /** `resolve(dir)`, cached once at server start. */
  base: string;
  /** `realpathSync(base)`, cached once at server start; symlinks can't move after the server is listening. */
  baseReal: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

type Resolution = { status: 200; file: string; size: number } | { status: 403 | 404 };

/**
 * Resolves `rel` under `root`, refusing anything the path lexically leaves (`..` segments, even to a
 * target that doesn't exist) as well as anything whose *real* path — after following symlinks — leaves,
 * so a symlink that sits inside the root but points outside it is refused too.
 */
function resolveInRoot(root: ResolvedRoot, rel: string): Resolution {
  const file = resolve(join(root.base, rel));
  if (file !== root.base && !file.startsWith(root.base + sep)) return { status: 403 };
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return { status: 404 };
  }
  if (!stats.isFile()) return { status: 404 };
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return { status: 404 };
  }
  if (real !== root.baseReal && !real.startsWith(root.baseReal + sep)) return { status: 403 };
  return { status: 200, file, size: stats.size };
}

/** A tiny static file server on 127.0.0.1 (a secure context, so WebGPU is available) serving one or more roots. */
export async function serveStatic(roots: StaticRoot[]): Promise<{ url: string; close(): Promise<void> }> {
  const sorted: ResolvedRoot[] = [...roots]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .map((r) => {
      const base = resolve(r.dir);
      return { ...r, base, baseReal: realpathSync(base) };
    });
  const server = createServer((req, res) => {
    try {
      const rawPathname = new URL(req.url ?? '/', 'http://x').pathname;
      let pathname = rawPathname;
      let malformed = false;
      try {
        pathname = decodeURIComponent(rawPathname);
      } catch {
        // Not a valid %-escape (e.g. a raw `%` from a filename like `100%.jpg`, or a truncated multi-byte
        // sequence). Fall back to the undecoded path: it still resolves when it names a real file verbatim
        // (the case that matters for assets with a literal `%` in their name), and a 400 otherwise.
        malformed = true;
      }
      const root = sorted.find((r) => pathname.startsWith(r.prefix));
      if (!root) {
        res.writeHead(malformed ? 400 : 404).end();
        return;
      }
      const rel = pathname.slice(root.prefix.length) || 'index.html';
      const resolved = resolveInRoot(root, rel);
      if (resolved.status !== 200) {
        res.writeHead(malformed ? 400 : resolved.status).end();
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(resolved.file).toLowerCase()] ?? 'application/octet-stream', 'content-length': resolved.size, 'cache-control': 'no-store' });
      const stream = createReadStream(resolved.file);
      // Both directions: a read failure (disk error) destroys the response, and a write failure (the
      // client — Chromium/Playwright during analyze/inspect/optimize — aborting mid-download) destroys
      // the read stream. `pipe()` only forwards source errors to the destination, never the reverse.
      stream.on('error', () => res.destroy());
      res.on('error', () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  // `listen` reports a failure through `'error'`, not by throwing. With no listener that is an uncaught exception
  // (an `EMFILE` is reachable in a long-lived MCP session, which opens one server per `analyze`), which would take
  // the process down and bypass `Resources.run`'s teardown entirely. The handler stays attached after the server is
  // listening, so a later `'error'` cannot crash the process either — per-connection failures are already handled on
  // the streams above, and there is nothing useful left to do with one here.
  let listening = false;
  await new Promise<void>((ok, fail) => {
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (listening) return;
      fail(new EnvironmentError(`the static server could not listen on 127.0.0.1 (${error.code ?? 'error'}: ${error.message}); close other programs or raise the open-file limit`));
    });
    server.listen(0, '127.0.0.1', () => {
      listening = true;
      ok();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
