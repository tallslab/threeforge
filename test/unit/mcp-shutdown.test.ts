import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../../src/cli/mcp.js';

/**
 * SDK 1.30's stdio transport (node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js) listens for 'data'
 * and 'error' on stdin, never 'end', so a disconnected client left `serveMcp()` pending forever and its resources
 * open. `serveMcp` now attaches its own 'end' listener (before any await, so it cannot miss an instant end) and
 * closes its `Resources` (the MCP connection) once stdin ends. A real `PassThrough` in place of stdin/stdout lets
 * this exercise the real SDK without spawning a process.
 */
describe('serveMcp shutdown on stdin end', () => {
  it('resolves and closes the mcp connection once stdin ends', async () => {
    const sdkModule = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const closeSpy = vi.spyOn(sdkModule.McpServer.prototype, 'close');
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume(); // drain so a handshake write, if any, never blocks

    const served = serveMcp({ stdin, stdout });
    let resolved = false;
    void served.then(() => {
      resolved = true;
    });

    // Wait until serveMcp has actually attached its 'end' listener (past the dynamic sdk/zod imports and
    // server.connect()) before ending stdin, so the test cannot race the very thing it is testing.
    await vi.waitFor(() => {
      if (stdin.listenerCount('end') === 0) throw new Error('serveMcp has not attached its end listener yet');
    });
    expect(resolved).toBe(false); // still serving: the client has not disconnected yet

    stdin.end();
    await served;

    expect(resolved).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });
});
