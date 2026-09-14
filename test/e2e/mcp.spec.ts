import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from './fixtures.js';

/** The MCP server over stdio, driven by the SDK's own client: the tools list and a pure tool call. */
test('threeforge mcp lists analyze_asset, inspect_app, optimize_asset, explain_hint and answers explain_hint', async () => {
  test.skip(process.env.FORGE_SKIP_MCP === '1', 'FORGE_SKIP_MCP');
  if (!existsSync('dist/cli/index.js')) execFileSync('pnpm', ['build:lib'], { stdio: 'inherit' });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'threeforge-test', version: '0' });
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/cli/index.js', 'mcp'] });
  await client.connect(transport);
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
    await client.close();
  }
});
