#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import { analyzeAsset } from './analyze.js';
import { parseArgs, UsageError, COMMANDS, type Command } from './args.js';
import { EnvironmentError } from './browser.js';
import { explain, REMEDIES } from './explain.js';
import { summarize } from './format.js';
import { inspectApp } from './inspect.js';
import { PageError } from './measure.js';
import { ANALYZE_SCHEMA, INSPECT_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
import type { AgentDocument } from './types.js';
import { exitCodeOf } from './verdict.js';

const FALLBACK_HELP = `threeforge ${VERSION} — frame-budget compiler and diagnostics for three.js games

  threeforge analyze <file.glb|.gltf> [--backend webgl2|webgpu] [--tier auto|desktop|phone-mid|phone-low] [--budget N] [--frames 30] [--no-compile] [--json]
  threeforge inspect <url> [--frames 30] [--compile] [--budget N] [--json]     drives a page that called exposeToAgents()
  threeforge explain <hint-code> | --all [--json]                             what a hint means and how to fix it
  threeforge schema [snapshot|analyze|inspect|all] [--json]                    JSON Schemas of what the commands print
  threeforge mcp                                                              stdio MCP server (analyze_asset, inspect_app, explain_hint)

Exit codes: 0 pass · 1 verdict failed · 2 usage · 3 environment (install: npm i -D playwright && npx playwright install chromium) · 4 page error
Commands: ${COMMANDS.join(', ')}`;

function helpText(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8');
  } catch {
    return FALLBACK_HELP;
  }
}

function printDocument(doc: AgentDocument, json: boolean): void {
  const summary = summarize(doc);
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
      printDocument(doc, command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'inspect': {
      const doc = await inspectApp(command.input, log);
      printDocument(doc, command.json);
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
      const all = { snapshot: SNAPSHOT_SCHEMA, analyze: ANALYZE_SCHEMA, inspect: INSPECT_SCHEMA };
      const out = command.which === 'all' ? all : all[command.which];
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }
    case 'mcp': {
      const { serveMcp } = await import('./mcp.js');
      await serveMcp();
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
