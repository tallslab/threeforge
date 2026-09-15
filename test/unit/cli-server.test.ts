import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStatic, type StaticRoot } from '../../src/cli/server.js';

/**
 * A raw HTTP GET using the exact `path` bytes as given, unlike `fetch` (or a `URL`), which would
 * normalise or re-encode a malformed `%`-sequence before the request ever reaches the server.
 */
function rawGet(url: string, path: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((ok, fail) => {
    const req = request({ host: target.hostname, port: target.port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

describe('serveStatic hardening', () => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-server-'));
  const root = join(parent, 'root');
  const literalPercentFile = join(root, '100%.jpg');
  const normalFile = join(root, 'normal.txt');
  const outsideFile = join(parent, 'secret.txt');
  const symlinkFile = join(root, 'escape.jpg');
  let server: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(literalPercentFile, 'literal-percent-jpg-bytes');
    writeFileSync(normalFile, 'hello world');
    writeFileSync(outsideFile, 'top secret, outside the root');
    symlinkSync(outsideFile, symlinkFile);
    const roots: StaticRoot[] = [{ prefix: '/', dir: root }];
    server = await serveStatic(roots);
  });

  afterAll(async () => {
    await server.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it('serves a normal file (regression)', async () => {
    const res = await rawGet(server.url, '/normal.txt');
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello world');
  });

  it('answers 404 for a missing file inside the root (regression)', async () => {
    const res = await rawGet(server.url, '/nope.txt');
    expect(res.status).toBe(404);
  });

  it('falls back to the literal path when decoding fails and that literal file exists in the root (100%.jpg)', async () => {
    const res = await rawGet(server.url, '/100%.jpg');
    expect(res.status).toBe(200);
    expect(res.body).toBe('literal-percent-jpg-bytes');
  });

  it('still serves the same asset through its properly percent-encoded name (100%25.jpg decodes to 100%.jpg)', async () => {
    const res = await rawGet(server.url, '/100%25.jpg');
    expect(res.status).toBe(200);
    expect(res.body).toBe('literal-percent-jpg-bytes');
  });

  it('answers 400 for a malformed URI with no matching literal file, and the server survives to serve the next request', async () => {
    const bad = await rawGet(server.url, '/%E0%A4%A');
    expect(bad.status).toBe(400);
    const after = await rawGet(server.url, '/normal.txt');
    expect(after.status).toBe(200);
    expect(after.body).toBe('hello world');
  });

  it('answers 403 for a symlink inside the root whose real path resolves outside it', async () => {
    const res = await rawGet(server.url, '/escape.jpg');
    expect(res.status).toBe(403);
  });

  it('answers 403 for an encoded path traversal', async () => {
    const res = await rawGet(server.url, '/..%2f..%2foutside.txt');
    expect(res.status).toBe(403);
  });
});
