#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeAsset } from './analyze.js';
import { formatUsage, parseArgs, type Command } from './args.js';
import { exitCodeFor, UsageError } from './errors.js';
import { explain, REMEDIES } from './explain.js';
import { printDocument, summarize, summarizeOptimize } from './format.js';
import { inspectApp } from './inspect.js';
import { armExitWatchdog } from './lifecycle.js';
import { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
import { cleanText, describeError } from './untrusted.js';
import { exitCodeOf } from './verdict.js';

function helpText(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../../AGENTS.md', import.meta.url)), 'utf8');
  } catch {
    return formatUsage();
  }
}

async function run(command: Command): Promise<number> {
  // A progress line can embed a name from the asset or page (an error message, a file name): clean it before it
  // reaches the terminal.
  const log = (line: string): void => {
    process.stderr.write(`· ${cleanText(line)}\n`);
  };
  switch (command.name) {
    case 'help':
      process.stdout.write(helpText() + '\n');
      return 0;
    case 'analyze': {
      const doc = await analyzeAsset(command.input, log);
      printDocument(doc, summarize, command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'inspect': {
      const doc = await inspectApp(command.input, log);
      printDocument(doc, summarize, command.json);
      return exitCodeOf(doc.verdict);
    }
    case 'optimize': {
      const { optimizeAsset } = await import('./optimize.js');
      const doc = await optimizeAsset(command.input, log);
      printDocument(doc, summarizeOptimize, command.json);
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
      // The one remaining raw write. It is the local user's own argument rather than
      // model-derived text, so this is consistency rather than a hole: every path out of this CLI is cleaned.
      process.stdout.write(cleanText(`decoders copied to ${out.draco} and ${out.basis}\nconst loader = await createLoader(renderer, { decoders: '/<served path of ${command.dir}>/' });`, 2000) + '\n');
      return 0;
    }
  }
}

async function main(): Promise<void> {
  let command: Command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${formatUsage()}\n`);
    process.exit(2);
  }
  try {
    process.exitCode = await run(command);
  } catch (error) {
    // describeError cleans the message: a page-originated PageError can reach here through a rejected
    // page.evaluate/waitForFunction (measure.ts), not only through a resolved value sanitizeDeep already covers.
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = exitCodeFor(error);
  }
  // mcp keeps serving on stdin after run() resolves; every other command is finished here and must not linger.
  if (command.name !== 'mcp') await armExitWatchdog();
}

await main();
