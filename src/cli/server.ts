import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

export interface StaticRoot {
  /** URL prefix, e.g. `/` or `/asset/`. Longest match wins. */
  prefix: string;
  dir: string;
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

/** A tiny static file server on 127.0.0.1 (a secure context, so WebGPU is available) serving one or more roots. */
export async function serveStatic(roots: StaticRoot[]): Promise<{ url: string; close(): Promise<void> }> {
  const sorted = [...roots].sort((a, b) => b.prefix.length - a.prefix.length);
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const root = sorted.find((r) => pathname.startsWith(r.prefix));
    if (!root) {
      res.writeHead(404).end();
      return;
    }
    const rel = pathname.slice(root.prefix.length) || 'index.html';
    const base = resolve(root.dir);
    const file = resolve(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end();
      return;
    }
    let stats;
    try {
      stats = statSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (!stats.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': stats.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
