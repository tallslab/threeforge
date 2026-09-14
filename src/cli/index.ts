#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { analyzeAsset } from './analyze.js';
import { parseArgs, UsageError, COMMANDS, type Command } from './args.js';
import { EnvironmentError } from './browser.js';
import { explain, REMEDIES } from './explain.js';
import { summarize, summarizeOptimize } from './format.js';
import { inspectApp } from './inspect.js';
import { PageError } from './measure.js';
import { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
import { exitCodeOf } from './verdict.js';

const FALLBACK_HELP = `threeforge ${VERSION} — frame-budget compiler and diagnostics for three.js games

  threeforge analyze <file.glb|.gltf> [--backend webgl2|webgpu] [--tier auto|desktop|phone-mid|phone-low] [--budget N] [--frames 30] [--no-compile] [--json]
  threeforge inspect <url> [--frames 30] [--compile] [--budget N] [--json]     drives a page that called exposeToAgents()
  threeforge optimize <file.glb|.gltf> [--out out.glb] [--preset safe|balanced|aggressive] [--no-<step>|--<step>] [--simplify 0.5] [--compress meshopt] [--textures webp|avif] [--texture-size N] [--no-verify] [--parity 0.5] [--views 2] [--json]
  threeforge explain <hint-code> | --all [--json]                             what a hint means and how to fix it
  threeforge schema [snapshot|analyze|inspect|optimize|all] [--json]           JSON Schemas of what the commands print
  threeforge mcp                                                              stdio MCP server (analyze_asset, inspect_app, optimize_asset, explain_hint)
  threeforge decoders <dir>                                                  copies three's Draco and Basis decoders for createLoader()

Exit codes: 0 pass · 1 verdict failed · 2 usage · 3 environment (install: npm i -D playwright && npx playwright install chromium) · 4 page error
Commands: ${COMMANDS.join(', ')}`;

function helpText(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8');
  } catch {
    return FALLBACK_HELP;
  }
}

function printDocument(doc: unknown, summary: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    process.stderr.write(summary + '\n');
  } else process.stdout.write(summary + '\n');
}

async function run(command: Command): Promise<number> {
  const log = (line: string): void => {
    process.stderr.write(`· ${line}\n`);
  };
  switch (command.name) {
    case 'help':
      process.stdout.write(helpText() + '\n');
      return 0;
    case 'analyze': {
      const doc = await analyzeAsset(command.input, log);
      printDocument(doc, summarize(doc), command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'inspect': {
      const doc = await inspectApp(command.input, log);
      printDocument(doc, summarize(doc), command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'optimize': {
      const { optimizeAsset } = await import('./optimize.js');
      const doc = await optimizeAsset(command.input, log);
      printDocument(doc, summarizeOptimize(doc), command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'explain': {
      if (command.all) {
        process.stdout.write(command.json ? JSON.stringify(REMEDIES, null, 2) + '\n' : Object.values(REMEDIES).map((r) => `${r.code} [${r.category}, ${r.severity}]\n  ${r.meaning}\n  fix: ${r.fix}\n  api: ${r.api}`).join('\n\n') + '\n');
        return 0;
      }
      const remedy = explain(command.code!);
      if (!remedy) throw new UsageError(`unknown hint code "${command.code}"; known: ${Object.keys(REMEDIES).join(', ')}`);
      process.stdout.write(command.json ? JSON.stringify(remedy, null, 2) + '\n' : `${remedy.code} [${remedy.category}, ${remedy.severity}]\n${remedy.meaning}\nfix: ${remedy.fix}\napi: ${remedy.api}\ndocs: ${remedy.docs}\n`);
      return 0;
    }
    case 'schema': {
      const all = { snapshot: SNAPSHOT_SCHEMA, analyze: ANALYZE_SCHEMA, inspect: INSPECT_SCHEMA, optimize: OPTIMIZE_SCHEMA };
      const out = command.which === 'all' ? all : all[command.which];
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    case 'mcp': {
      const { serveMcp } = await import('./mcp.js');
      await serveMcp();
      return 0;
    }
    case 'decoders': {
      const { copyDecoders } = await import('./decoders.js');
      const out = copyDecoders(command.dir);
      process.stdout.write(`decoders copied to ${out.draco} and ${out.basis}\nconst loader = await createLoader(renderer, { decoders: '/<served path of ${command.dir}>/' });\n`);
      return 0;
    }
  }
}

async function main(): Promise<void> {
  let command: Command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${FALLBACK_HELP}\n`);
    process.exit(2);
  }
  try {
    process.exitCode = await run(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
    } else if (error instanceof EnvironmentError) {
      process.stderr.write(`environment: ${message}\n`);
      process.exitCode = 3;
    } else if (error instanceof PageError) {
      process.stderr.write(`page: ${message}\n`);
      process.exitCode = 4;
    } else {
      process.stderr.write(`error: ${error instanceof Error ? (error.stack ?? message) : message}\n`);
      process.exitCode = 4;
    }
  }
}

await main();
