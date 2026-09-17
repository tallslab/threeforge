import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../../src/cli/mcp.js';

/**
 * Shutdown closed only the `Resources` `serveMcp` owns itself (the MCP
 * connection) — not a `Resources` an in-flight `analyze_asset`/`inspect_app`/`optimize_asset` call had opened
 * internally (`src/cli/analyze.ts`/`inspect.ts`/`optimize.ts`), so a call still running when the client
 * disconnected kept its browser and static server open and ran to completion instead of being cancelled promptly.
 *
 * `serveMcp` now creates one `AbortController` per session and passes its `signal` (via `CliDeps`, `src/cli/
 * lifecycle.ts`) into every run tool; each of those calls arms its own `Resources` with that signal
 * (`Resources.armAbort`), so aborting closes whatever that call has opened so far. `serveMcp` aborts on stdin end.
 *
 * This drives a real `analyze_asset` call through the real MCP server (no mocking of the SDK or zod) using
 * `McpDeps.launch`/`serve` fakes that block forever in `newPage()`, so the call is stuck exactly where a real one
 * would be mid-render. The client and server here are hand-rolled newline-delimited JSON-RPC writers/readers over
 * `PassThrough` pipes standing in for stdin/stdout — the SDK's own `StdioClientTransport` always spawns a child
 * process, so it cannot address an in-process server like `StdioServerTransport(stdin, stdout)` can.
 */
describe('serveMcp aborts an in-flight tool call and closes its resources on stdin end', () => {
  function writeMessage(stream: PassThrough, message: unknown): void {
    stream.write(`${JSON.stringify(message)}\n`);
  }

  /** Buffers newline-delimited JSON-RPC messages written to `stream` and hands them out as they arrive. */
  function reader(stream: PassThrough): { next(): Promise<Record<string, unknown>> } {
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      // eslint-disable-next-line no-cond-assign
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        const waiting = waiters.shift();
        if (waiting) waiting(message);
        else queue.push(message);
      }
    });
    return {
      next(): Promise<Record<string, unknown>> {
        const queued = queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
  }

  it('closes the fake browser and static server opened by a stuck analyze_asset call, and serveMcp still resolves', async () => {
    const stdin = new PassThrough(); // the server's stdin: the hand-rolled client writes requests here
    const stdout = new PassThrough(); // the server's stdout: the hand-rolled client reads responses here
    const incoming = reader(stdout);

    const closeServer = vi.fn().mockResolvedValue(undefined);
    const closeBrowser = vi.fn().mockResolvedValue(undefined);
    let newPageCalled = false;

    // A real, existing file — analyzeAssetWithShots only needs it to exist; the fake launch/serve below mean it
    // is never actually read by a browser.
    const realFile = fileURLToPath(new URL('../../package.json', import.meta.url));

    const served = serveMcp({
      stdin,
      stdout,
      // Ignored by the fake `serve` below, but analyzeAssetWithShots (src/cli/analyze.ts) computes it eagerly
      // (cliAppDir()) before calling deps.serve — and that throws when running against source (not dist),
      // where the shipped harness page does not exist next to src/cli/. Any real directory does.
      appDir: fileURLToPath(new URL('.', import.meta.url)),
      serve: async () => ({ url: 'http://127.0.0.1:1', close: closeServer }),
      launch: async () => ({
        newPage: () => {
          newPageCalled = true;
          return new Promise(() => {}); // never resolves: the call is stuck exactly like a real hung render
        },
        close: closeBrowser,
      }),
    });
    let servedResolved = false;
    void served.then(() => {
      servedResolved = true;
    });

    await vi.waitFor(() => {
      if (stdin.listenerCount('end') === 0) throw new Error('serveMcp has not attached its end listener yet');
    });

    writeMessage(stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'threeforge-abort-test', version: '0' },
      },
    });
    const initResponse = await incoming.next();
    expect(initResponse.result).toBeDefined();
    writeMessage(stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });

    // Fire the call and deliberately do not await its response: it is designed to hang.
    writeMessage(stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'analyze_asset', arguments: { file: realFile, frames: 5 } },
    });

    // Wait until the call has actually reached the blocking point: by the time newPage() is invoked, the real
    // code (src/cli/analyze.ts) has already run both `resources.add('the static server', ...)` and
    // `resources.add('the browser', ...)`, so both fakes are guaranteed to be on the stack to close.
    await vi.waitFor(
      () => {
        if (!newPageCalled) throw new Error('the call has not reached newPage() yet');
      },
      { timeout: 3000, interval: 10 },
    );
    expect(closeServer).not.toHaveBeenCalled();
    expect(closeBrowser).not.toHaveBeenCalled();
    expect(servedResolved).toBe(false);

    stdin.end();
    await served;

    expect(servedResolved).toBe(true);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
  }, 15_000);
});
