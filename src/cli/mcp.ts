import { analyzeAsset } from './analyze.js';
import { EnvironmentError } from './browser.js';
import { explain, REMEDIES } from './explain.js';
import { inspectApp } from './inspect.js';
import { PageError } from './measure.js';
import { UsageError } from './args.js';
import type { AnalyzeInput, InspectInput } from './types.js';
import { VERSION } from '../version.js';

const INSTALL = 'npm i -D @modelcontextprotocol/sdk zod';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (error: unknown): ToolResult => {
  const code = error instanceof UsageError ? 2 : error instanceof EnvironmentError ? 3 : error instanceof PageError ? 4 : 4;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error), code }) }] };
};

/**
 * `threeforge mcp`: a stdio Model Context Protocol server with the same operations as the CLI. Agents that prefer
 * tool calls over shells register it once; every result is the same JSON document the CLI prints.
 */
export async function serveMcp(): Promise<void> {
  let sdk: { McpServer: new (info: { name: string; version: string }) => McpServerLike };
  let transport: { StdioServerTransport: new () => unknown };
  let z: ZodLike;
  try {
    sdk = (await import('@modelcontextprotocol/sdk/server/mcp.js')) as unknown as typeof sdk;
    transport = (await import('@modelcontextprotocol/sdk/server/stdio.js')) as unknown as typeof transport;
    z = ((await import('zod')) as unknown as { z: ZodLike }).z;
  } catch {
    throw new EnvironmentError(`the MCP server needs the SDK: ${INSTALL}`);
  }
  const server = new sdk.McpServer({ name: 'threeforge', version: VERSION });
  const backend = z.enum(['webgl2', 'webgpu']).default('webgl2');
  const tier = z.enum(['auto', 'desktop', 'phone-mid', 'phone-low']).default('auto');
  const runShape = {
    backend: backend.describe('Renderer backend to measure on'),
    tier: tier.describe('Device tier for budgets and hints (auto detects from the machine)'),
    budget: z.number().int().nonnegative().optional().describe('Fail the verdict above this many scene submissions'),
    frames: z.number().int().positive().default(30).describe('Frames to measure (medians)'),
    compile: z.boolean().default(true).describe('Compile (batch) the scene and measure again'),
    timeout: z.number().int().positive().default(60000).describe('Milliseconds to wait for the page'),
  };
  server.registerTool(
    'analyze_asset',
    {
      title: 'Analyze a glTF asset',
      description: 'Render a .glb/.gltf headlessly, measure every frame cost (draw calls, overdraw, skinning, lighting, js, memory), compile it with threeforge, measure again, compare pixels and return hints with a verdict.',
      inputSchema: { file: z.string().describe('Path to a .glb or .gltf file'), ...runShape, bake: z.enum(['off', 'on', 'buried']).default('off').describe('Bake finished groups into one mesh each (seams and duplicates removed); buried also removes faces solid geometry sits right in front of'), views: z.number().int().nonnegative().default(0).describe('Extra orbit views for pixel parity') },
    },
    async (args: Record<string, unknown>) => {
      try {
        const input: AnalyzeInput = { file: String(args.file), backend: args.backend as AnalyzeInput['backend'], tier: args.tier as AnalyzeInput['tier'], budget: typeof args.budget === 'number' ? args.budget : null, frames: Number(args.frames ?? 30), compile: args.compile !== false, bake: (args.bake as AnalyzeInput['bake']) ?? 'off', views: Number(args.views ?? 0), timeout: Number(args.timeout ?? 60000), headed: false };
        return ok(await analyzeAsset(input));
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    'inspect_app',
    {
      title: 'Inspect a running three.js app',
      description: 'Open a URL whose app called exposeToAgents({ ledger, world, renderer, scene, camera }), measure frames through window.__threeforge, optionally compile, and return the same document as analyze_asset.',
      inputSchema: { url: z.string().describe('URL of the running app (dev server)'), ...runShape },
    },
    async (args: Record<string, unknown>) => {
      try {
        const input: InspectInput = { url: String(args.url), backend: args.backend as InspectInput['backend'], tier: args.tier as InspectInput['tier'], budget: typeof args.budget === 'number' ? args.budget : null, frames: Number(args.frames ?? 30), compile: args.compile !== false, timeout: Number(args.timeout ?? 60000), headed: false };
        return ok(await inspectApp(input));
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    'explain_hint',
    {
      title: 'Explain a hint code',
      description: 'What a threeforge hint code means, what to change and which API to use. Omit the code to list every remedy.',
      inputSchema: { code: z.string().optional().describe('A hint code from a snapshot, e.g. untagged or point-light-shadow') },
    },
    async (args: Record<string, unknown>) => {
      if (typeof args.code !== 'string' || args.code === '') return ok(REMEDIES);
      const remedy = explain(args.code);
      return remedy ? ok(remedy) : fail(new UsageError(`unknown hint code "${args.code}"; known: ${Object.keys(REMEDIES).join(', ')}`));
    },
  );
  await server.connect(new transport.StdioServerTransport());
}

/** Structural view of the SDK pieces used, so the package compiles without the optional SDK installed. */
interface McpServerLike {
  registerTool(name: string, config: { title: string; description: string; inputSchema: Record<string, unknown> }, handler: (args: Record<string, unknown>) => Promise<ToolResult>): unknown;
  connect(transport: unknown): Promise<void>;
}
interface ZodLike {
  enum(values: [string, ...string[]]): { default(v: string): { describe(d: string): unknown } };
  number(): { int(): { nonnegative(): { optional(): { describe(d: string): unknown }; default(v: number): { describe(d: string): unknown } }; positive(): { default(v: number): { describe(d: string): unknown } } } };
  boolean(): { default(v: boolean): { describe(d: string): unknown } };
  string(): { describe(d: string): unknown; optional(): { describe(d: string): unknown } };
}
