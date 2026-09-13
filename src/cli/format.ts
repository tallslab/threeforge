import { formatCostRows, formatHints } from '../overlay/index.js';
import type { AgentDocument } from './types.js';

/** The human summary (stderr in --json mode): one screen, the verdict first. */
export function summarize(doc: AgentDocument): string {
  const target = 'file' in doc.input ? doc.input.file : doc.input.url;
  const frame = doc.after ?? doc.before;
  const lines = [
    `threeforge ${doc.command} ${target} · ${doc.env.backend} · ${doc.env.gpu} · tier ${doc.env.tier}`,
    `${doc.verdict.pass ? 'PASS' : 'FAIL'}${doc.verdict.reasons.length ? ': ' + doc.verdict.reasons.join('; ') : ''}`,
  ];
  if (doc.asset) lines.push(`asset: ${doc.asset.meshes} meshes · ${doc.asset.materials} materials · ${doc.asset.triangles} tris · ${doc.asset.skinned} skinned · ${doc.asset.animations} clips · loaded in ${doc.asset.loadMs.toFixed(0)} ms`);
  if (doc.after) lines.push(`${doc.before.totals.sceneSubmissions} → ${doc.after.totals.sceneSubmissions} submissions after compile${doc.compile ? ` (${doc.compile.after.batches} batches, ${doc.compile.after.instanced} instanced, ${doc.compile.skipped.length} skipped)` : ''}`);
  else lines.push(`${doc.before.totals.sceneSubmissions} submissions`);
  if (doc.parity) lines.push(`parity ${doc.parity.diffPct.toFixed(2)}% pixels changed (threshold ${doc.parity.threshold}%)`);
  lines.push(...formatCostRows(frame));
  lines.push(...formatHints(frame));
  lines.push(`${doc.timings.totalMs} ms total`);
  return lines.join('\n');
}
