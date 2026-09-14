// Reads a bench issue body, validates the JSON fence and stores it under bench/devices/<id>.json.
// Usage (CI): ISSUE_BODY="$BODY" node scripts/bench-ingest.mjs   → prints the file path; exit 1 with the errors.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeviceResult } from './bench-schema.mjs';

/** The first ```json fence in an issue body, or null. */
export function extractJson(body) {
  const m = /```json\s*\n([\s\S]*?)\n\s*```/.exec(body ?? '');
  return m ? m[1].trim() : null;
}

/** Validates the body's JSON and writes `<dir>/<id>.json`; throws with the reasons otherwise. */
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
  writeFileSync(path, JSON.stringify(v.result, null, 2) + '\n');
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
