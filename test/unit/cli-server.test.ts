import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type StaticRoot, serveStatic } from '../../src/cli/server.js';

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

/**
 * `serveStatic` registered no `'error'` handler on `listen`, so an `EMFILE` or `EACCES` — the
 * first reachable in a long-lived MCP session that opens one server per `analyze` — was an uncaught exception that
 * took the process down and bypassed `Resources.run`'s teardown entirely, instead of the exit-3 `EnvironmentError`
 * the rest of the CLI is careful to give. `createServer` is mocked because port 0 on 127.0.0.1 does not fail on
 * demand; the point is the handler, not the errno.
 */
describe('a listen failure is an EnvironmentError, not an uncaught exception', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-listen-'));
  let live: EventEmitter | null = null;

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A server double: `listen` either fails the way Node reports a failed bind (asynchronously, through `'error'`) or succeeds. */
  function serverDouble(failure: { code: string; message: string } | null) {
    const server = new EventEmitter() as EventEmitter & {
      listen(port: number, host: string, ok: () => void): void;
      address(): { port: number } | null;
      close(done: () => void): void;
    };
    server.listen = (_port: number, _host: string, ok: () => void) =>
      void setImmediate(() =>
        failure ? server.emit('error', Object.assign(new Error(failure.message), { code: failure.code })) : ok(),
      );
    server.address = () => (failure ? null : { port: 4321 });
    server.close = (done: () => void) => done();
    return server;
  }

  /**
   * `vi.resetModules()` hands the dynamically imported `server.js` a *fresh* `errors.js`, so its `EnvironmentError`
   * is a different class object from this file's static import: `instanceof` against the outer one is always false.
   * The exit code is resolved inside the same module graph, which is the behavioural claim anyway — exit 3.
   */
  async function serveWith(
    failure: { code: string; message: string } | null,
  ): Promise<{ value: unknown; environment: boolean; exitCode: number }> {
    vi.resetModules();
    vi.doMock('node:http', async () => ({
      ...(await vi.importActual<typeof import('node:http')>('node:http')),
      createServer: () => {
        live = serverDouble(failure);
        return live;
      },
    }));
    try {
      const { serveStatic: mocked } = await import('../../src/cli/server.js');
      const { EnvironmentError: Fresh, exitCodeFor } = await import('../../src/cli/errors.js');
      const value = await mocked([{ prefix: '/', dir }]).then(
        (server) => server,
        (error: unknown) => error,
      );
      return { value, environment: value instanceof Fresh, exitCode: value instanceof Error ? exitCodeFor(value) : 0 };
    } finally {
      vi.doUnmock('node:http');
      vi.resetModules();
    }
  }

  it.each([
    ['EMFILE', 'listen EMFILE: too many open files'],
    ['EACCES', 'listen EACCES: permission denied 127.0.0.1'],
  ])('rejects on %s rather than letting the process die', async (code, message) => {
    const { value, environment, exitCode } = await serveWith({ code, message });
    expect(value).toBeInstanceOf(Error);
    expect(environment, `got ${(value as Error).constructor.name}`).toBe(true);
    expect(exitCode).toBe(3);
    expect((value as Error).message).toContain(code);
    expect((value as Error).message).toContain('127.0.0.1');
  });

  it('keeps an error handler attached after it is listening', async () => {
    const { value: server } = await serveWith(null);
    expect(server).not.toBeInstanceOf(Error);
    expect((server as { url: string }).url).toBe('http://127.0.0.1:4321');
    // An EventEmitter that emits `'error'` with no listener throws it; this one has one, so the emit just returns false-ish.
    expect(() => live!.emit('error', Object.assign(new Error('a socket died'), { code: 'ECONNRESET' }))).not.toThrow();
    await (server as { close(): Promise<void> }).close();
  });
});

describe('serveStatic hardening', () => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-server-'));
  const root = join(parent, 'root');
  const literalPercentFile = join(root, '100%.jpg');
  const normalFile = join(root, 'normal.txt');
  const bigFile = join(root, 'big.bin');
  const outsideFile = join(parent, 'secret.txt');
  const symlinkFile = join(root, 'escape.jpg');
  let server: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(literalPercentFile, 'literal-percent-jpg-bytes');
    writeFileSync(normalFile, 'hello world');
    // Big enough that the socket-level reset below almost certainly lands mid-stream rather than
    // after the whole response has already been flushed to the OS.
    writeFileSync(bigFile, Buffer.alloc(20 * 1024 * 1024, 7));
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

  it.each([
    ['/100%.jpg', 'the literal path, when decoding fails and that literal file exists in the root'],
    ['/100%25.jpg', 'its properly percent-encoded name, which decodes to 100%.jpg'],
  ])('serves the percent-named asset at %s: %s', async (path) => {
    const res = await rawGet(server.url, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe('literal-percent-jpg-bytes');
  });

  it('answers 400 for a malformed URI with no literal file, then keeps serving', async () => {
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

  it('survives the client resetting its socket mid-download, and keeps serving the next request', async () => {
    const target = new URL(server.url);
    // A raw socket (not the http client) so we can force a real TCP RST with resetAndDestroy(),
    // the closest a test can get to Chromium/Playwright abruptly aborting an in-flight asset
    // request (page navigation, a --timeout abort, a crashed tab) while the server is still writing.
    await new Promise<void>((ok, fail) => {
      const socket = connect(Number(target.port), target.hostname, () => {
        socket.write('GET /big.bin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let received = 0;
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > 32 * 1024 && !socket.destroyed) {
          socket.resetAndDestroy();
        }
      });
      socket.on('close', () => ok());
      socket.on('error', () => ok()); // a local ECONNRESET on our own end is an expected side effect of the reset
      setTimeout(fail, 4000);
    });
    // Give the server a tick to finish reacting to the aborted write before probing it.
    await new Promise((wake) => setTimeout(wake, 100));
    const after = await rawGet(server.url, '/normal.txt');
    expect(after.status).toBe(200);
    expect(after.body).toBe('hello world');
  });
});
