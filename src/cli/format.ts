import { formatCostRows, formatHints } from '../overlay/index.js';
import { describeChange } from './transform.js';
import type { AgentDocument, OptimizeDocument } from './types.js';
import { cleanLines, cleanText } from './untrusted.js';

/** Where a command prints: `process` in the CLI, anything with the two `write` methods in tests. */
export interface OutputStreams {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

/**
 * Prints a command's document. With `json`, stdout gets the JSON before the summary is built, so a summarizer that
 * throws costs only the stderr summary (a note replaces it) and never the document an agent parses. Without `json`,
 * the summary is the output and its error propagates.
 *
 * The summary can embed a name from the asset or page (a hint's `objects`/`message`, `env.gpu`): `cleanLines`
 * strips ANSI/control/bidi characters from it, line by line, before either write, so the terminal that reads
 * this (stdout without `--json`, stderr with it) never sees raw escape sequences or an unbounded line.
 */
export function printDocument<T>(
  doc: T,
  summarizeDoc: (doc: T) => string,
  json: boolean,
  streams: OutputStreams = process,
): void {
  if (!json) {
    streams.stdout.write(cleanLines(summarizeDoc(doc)) + '\n');
    return;
  }
  streams.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  try {
    streams.stderr.write(cleanLines(summarizeDoc(doc)) + '\n');
  } catch (error) {
    streams.stderr.write(`summary unavailable: ${error instanceof Error ? cleanText(error.message) : String(error)}\n`);
  }
}

/** The human summary (stderr in --json mode): one screen, the verdict first. */
export function summarize(doc: AgentDocument): string {
  const target = 'file' in doc.input ? doc.input.file : doc.input.url;
  const frame = doc.after ?? doc.before;
  const lines = [
    `threeforge ${doc.command} ${target} · ${doc.env.backend} · ${doc.env.gpu} · tier ${doc.env.tier}`,
    `${doc.verdict.pass ? 'PASS' : 'FAIL'}${doc.verdict.reasons.length ? ': ' + doc.verdict.reasons.join('; ') : ''}`,
  ];
  if (doc.asset)
    lines.push(
      `asset: ${doc.asset.meshes} meshes · ${doc.asset.materials} materials · ${doc.asset.triangles} tris · ${doc.asset.skinned} skinned · ${doc.asset.animations} clips · loaded in ${doc.asset.loadMs.toFixed(0)} ms`,
    );
  if (doc.after)
    lines.push(
      `${doc.before.totals.sceneSubmissions} → ${doc.after.totals.sceneSubmissions} submissions after compile${doc.compile ? ` (${doc.compile.after.batches} batches, ${doc.compile.after.instanced} instanced, ${doc.compile.skippedCount ?? doc.compile.skipped.length} skipped)` : ''}`,
    );
  else lines.push(`${doc.before.totals.sceneSubmissions} submissions`);
  // The exact worst-view count rides beside the percent: the percent is rounded to three decimals, so it reads 0.00
  // for a view that really did move a few pixels.
  if (doc.parity)
    lines.push(
      `parity ${doc.parity.diffPct.toFixed(2)}% pixels changed over ${doc.parity.views.length} view${doc.parity.views.length === 1 ? '' : 's'} (threshold ${doc.parity.threshold}%) · ${doc.parity.views.reduce((most, v) => Math.max(most, v.changedPixels), 0)} changed pixels in the worst view`,
    );
  if (doc.compile?.bake)
    lines.push(
      `bake: ${doc.compile.bake.groups} groups · ${doc.compile.bake.inputTriangles} → ${doc.compile.bake.triangles} tris · seams ${doc.compile.bake.contactFaces} · kept coincident ${doc.compile.bake.keptCoincidentFaces ?? 0} · duplicates ${doc.compile.bake.duplicateFaces} · kept duplicate ${doc.compile.bake.keptDuplicateFaces ?? 0} · buried ${doc.compile.bake.buriedFaces} · welded ${doc.compile.bake.weldedVertices} · unbakeable ${doc.compile.bake.unbakeableEntries ?? 0}`,
    );
  lines.push(...formatCostRows(frame));
  lines.push(...formatHints(frame));
  lines.push(`${doc.timings.totalMs} ms total`);
  return lines.join('\n');
}

const bytes = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`;
const pct = (before: number, after: number): string =>
  before > 0 ? ` (${after >= before ? '+' : '−'}${Math.abs(((after - before) / before) * 100).toFixed(0)} %)` : '';

/** The human summary of an optimize run (stderr in --json mode). */
export function summarizeOptimize(doc: OptimizeDocument): string {
  const { before, after } = doc.stats;
  const lines = [
    `threeforge optimize ${doc.input.file} → ${doc.output.file} · preset ${doc.input.preset} · ${doc.steps.map((s) => s.name).join(', ') || 'no steps'}`,
    `${doc.verdict.pass ? 'PASS' : 'FAIL'}${doc.verdict.reasons.length ? ': ' + doc.verdict.reasons.join('; ') : ''}`,
    `${bytes(before.bytes)} → ${bytes(after.bytes)}${pct(before.bytes, after.bytes)} · ${describeChange(before, after)}`,
  ];
  for (const step of doc.steps)
    lines.push(
      `  ${step.name}: ${step.applied ? describeChange(step.before, step.after) : (step.note ?? 'skipped')} (${step.ms} ms)`,
    );
  if (doc.requires.length)
    lines.push(`requires: ${doc.requires.map((r) => `${r.extension} → ${r.code ?? r.needs}`).join(' · ')}`);
  if (doc.verify) {
    const v = doc.verify;
    const naive = `${v.original.before.totals.sceneSubmissions} → ${v.optimized.before.totals.sceneSubmissions}`;
    const compiled =
      v.original.after && v.optimized.after
        ? `, compiled ${v.original.after.totals.sceneSubmissions} → ${v.optimized.after.totals.sceneSubmissions}`
        : '';
    lines.push(
      `verify (${v.backend}): parity ${v.parity.diffPct.toFixed(2)} % over ${v.parity.views.length} view${v.parity.views.length === 1 ? '' : 's'} (threshold ${v.parity.threshold} %) · ${v.parity.views.reduce((most, view) => Math.max(most, view.changedPixels), 0)} changed pixels in the worst view · submissions naive ${naive}${compiled} · load ${v.original.asset?.loadMs.toFixed(0)} → ${v.optimized.asset?.loadMs.toFixed(0)} ms`,
    );
    if (v.optimized.parity)
      lines.push(`optimized file compiled with parity ${v.optimized.parity.diffPct.toFixed(2)} %`);
  } else lines.push('not verified (--no-verify)');
  lines.push(
    `${doc.timings.totalMs} ms total (${doc.timings.transformMs} ms transform, ${doc.timings.verifyMs} ms verify)`,
  );
  return lines.join('\n');
}
