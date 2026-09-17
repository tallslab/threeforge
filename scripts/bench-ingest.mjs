// Reads a bench issue body, validates the JSON fence and stores it under bench/devices/<id>.json.
// Usage (CI): ISSUE_BODY="$BODY" node scripts/bench-ingest.mjs   → prints the file path; exit 1 with the errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeviceResult } from './bench-schema.mjs';

// A regex fence scan (`/```json\s*\n([\s\S]*?)\n\s*```/`) can back-track catastrophically on a body that never
// closes the fence (a whitespace-only body took seconds); a linear `indexOf` scan can't. The cap keeps a huge body
// (an issue can hold far more than this) from costing more than a bounded scan either way.
const MAX_BODY = 65536;
const OPEN_FENCE = '```json';
const CLOSE_FENCE = '```';

/** The first ```json fence in an issue body, or null. Throws if the body exceeds MAX_BODY characters. */
export function extractJson(body) {
  const text = typeof body === 'string' ? body : '';
  if (text.length > MAX_BODY)
    throw new Error(`issue body: expected at most ${MAX_BODY} characters, got ${text.length}`);
  const start = text.indexOf(OPEN_FENCE);
  if (start === -1) return null;
  let i = start + OPEN_FENCE.length;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r')) i++;
  if (text[i] !== '\n') return null;
  const close = text.indexOf(CLOSE_FENCE, i + 1);
  if (close === -1) return null;
  return text.slice(i + 1, close).trim();
}

/** Validates the body's JSON and writes `<dir>/<id>.json`; throws with the reasons otherwise. Never overwrites an
 * existing result (`flag: 'wx'`): a second submission for the same id must be rejected, not silently replace it. */
export function ingest(body, dir) {
  const json = extractJson(body);
  if (json === null) throw new Error('no ```json fence in the issue body');
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  const v = validateDeviceResult(value);
  if (!v.ok) throw new Error(`invalid result:\n- ${v.errors.join('\n- ')}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${v.result.id}.json`);
  try {
    writeFileSync(path, JSON.stringify(v.result, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new Error(`result ${JSON.stringify(v.result.id)} already exists at ${JSON.stringify(path)}`);
    throw e;
  }
  return { path, result: v.result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { path } = ingest(process.env.ISSUE_BODY ?? '', 'bench/devices');
    console.log(path);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
