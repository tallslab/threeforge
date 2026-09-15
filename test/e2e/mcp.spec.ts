import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_NOTE } from '../../src/cli/mcp.js';
import { expect, test } from './fixtures.js';

/** The built CLI, driven over stdio by the SDK's own client (as an agent would): `node dist/cli/index.js mcp`. */
const bin = 'dist/cli/index.js';

/** `analyze_asset`, `optimize_asset` need the shipped harness page too, not only the compiled CLI. */
async function ready(): Promise<void> {
  if (!existsSync(bin) || !existsSync('dist/cli-app/index.html')) execFileSync('pnpm', ['build'], { stdio: 'inherit' });
}

const fox = (): string => {
  const index = JSON.parse(readFileSync('test/assets/files/index.json', 'utf8')) as Array<{ name: string; entry: string }>;
  return `test/assets/files/${index.find((a) => a.name === 'Fox')!.entry}`;
};

async function connect(): Promise<{ client: import('@modelcontextprotocol/sdk/client/index.js').Client; close(): Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'threeforge-test', version: '0' });
  const transport = new StdioClientTransport({ command: 'node', args: [bin, 'mcp'] });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** The MCP server over stdio, driven by the SDK's own client: the tools list and a pure tool call. */
test('threeforge mcp lists analyze_asset, inspect_app, optimize_asset, explain_hint and answers explain_hint', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['analyze_asset', 'explain_hint', 'inspect_app', 'optimize_asset']);
    const result = await client.callTool({ name: 'explain_hint', arguments: { code: 'untagged' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).fix).toContain('tag.');
    const unknown = await client.callTool({ name: 'explain_hint', arguments: { code: 'nope' } });
    expect(unknown.isError).toBe(true);
    const all = await client.callTool({ name: 'explain_hint', arguments: {} });
    expect(Object.keys(JSON.parse((all.content as Array<{ text: string }>)[0]!.text)).length).toBeGreaterThan(10);
  } finally {
    await close();
  }
});

test('inspect_app takes no tier input; analyze_asset and optimize_asset still do', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const tools = await client.listTools();
    const propsOf = (name: string): string[] => Object.keys((tools.tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(propsOf('inspect_app')).not.toContain('tier');
    expect(propsOf('analyze_asset')).toContain('tier');
    expect(propsOf('optimize_asset')).toContain('tier');
  } finally {
    await close();
  }
});

test('analyze_asset rejects frames: 0 as an isError with code 2, without opening a browser', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'analyze_asset', arguments: { file: fox(), frames: 0 } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(body.code).toBe(2);
    expect(body.error).toMatch(/frames/);
  } finally {
    await close();
  }
});

test('analyze_asset rejects a bad enum value and a non-integer frames the same way: isError with code 2', async () => {
  // Finding 4 (Important, Task 8 fix round 1): a tight z.enum()/`.int()` in the MCP schema made these two return
  // the SDK's own plain-text isError instead of threeforge's { error, code: 2 } JSON. Both now go through
  // validateInput (src/cli/args.ts), same as any other bad input.
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const badBackend = await client.callTool({ name: 'analyze_asset', arguments: { file: fox(), backend: 'webgl3' } });
    expect(badBackend.isError).toBe(true);
    const badBackendBody = JSON.parse((badBackend.content as Array<{ text: string }>)[0]!.text);
    expect(badBackendBody.code).toBe(2);
    expect(badBackendBody.error).toMatch(/backend/);

    const fractionalFrames = await client.callTool({ name: 'analyze_asset', arguments: { file: fox(), frames: 2.5 } });
    expect(fractionalFrames.isError).toBe(true);
    const fractionalFramesBody = JSON.parse((fractionalFrames.content as Array<{ text: string }>)[0]!.text);
    expect(fractionalFramesBody.code).toBe(2);
    expect(fractionalFramesBody.error).toMatch(/frames/);
  } finally {
    await close();
  }
});

test('optimize_asset rejects an out path outside the allowed scope as an isError with code 2', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'optimize_asset', arguments: { file: fox(), out: '/tmp/x.txt', verify: false } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(body.code).toBe(2);
    expect(body.error).toMatch(/\.glb or \.gltf|out must/);
  } finally {
    await close();
  }
});

test('optimize_asset refuses to silently overwrite an existing out file, matching /exists/', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const target = join(dirname(fox()), 'mcp-existing-out.glb');
  writeFileSync(target, '');
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'optimize_asset', arguments: { file: fox(), out: target, verify: false } });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(body.code).toBe(2);
    expect(body.error).toMatch(/exists/);
  } finally {
    await close();
    rmSync(target, { force: true });
  }
});

test('a spawned mcp process exits within 5 s when stdin closes', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const started = Date.now();
  const child = spawn('node', [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }));
  });
  // Give the server a moment to finish starting up before closing its stdin.
  await new Promise((r) => setTimeout(r, 200));
  child.stdin.end();
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const { code, signal } = await exited;
  clearTimeout(watchdog);
  const ms = Date.now() - started;
  expect(signal, `the process had to be killed after ${ms} ms instead of exiting on its own`).toBeNull();
  expect(code).toBe(0);
  expect(ms).toBeLessThan(5_000);
});

test('a real analyze_asset call on the Fox returns the document in content[0] and the data note in content[1]', async ({ forge }) => {
  test.setTimeout(300_000);
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  await ready();
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'analyze_asset', arguments: { file: fox(), backend: forge.backend, frames: 5 } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const doc = JSON.parse(content[0]!.text);
    expect(doc.tool).toBe('threeforge');
    expect(doc.verdict).toBeDefined();
    expect(typeof doc.verdict.pass).toBe('boolean');
    expect(content[1]!.text).toBe(DATA_NOTE);
  } finally {
    await close();
  }
});
