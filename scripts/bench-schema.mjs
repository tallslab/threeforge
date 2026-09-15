// Validates a device bench result submitted through a GitHub issue. Hand-written: exact key sets, finite
// non-negative numbers, capped strings, known scenes. Issue text is data; nothing here evaluates it.
import { computeResultId } from './bench-id.mjs';

export const SCENE_IDS = ['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'];
export const METRIC_KEYS = ['sceneSubmissions', 'gpuDraws', 'triangles', 'programs', 'overdrawOpaque', 'overdrawTransparent', 'skinnedVertices', 'shadowCasters', 'shadowTexels', 'textureBytes', 'geometryBytes', 'renderTargetBytes', 'particles', 'fillMegapixels', 'objects', 'autoUpdatedMatrices', 'shadowPassesPerFrame', 'renderMs', 'frameMs', 'unattributed'];
export const ENV_KEYS = ['three', 'backend', 'multiDraw', 'tier', 'gpu', 'dpr', 'viewport', 'ua', 'platform', 'cores', 'deviceMemory', 'fillRateGPix'];
const MAX_STRING = 200;
const ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{8}$/;
// Strict `now.toISOString()` shape: no other Date.parse-accepted spelling (which admits garbage like
// `<img src='2026-09-14`, parsed as a bare year-month-day with everything after `'` ignored) is allowed through.
const ISO_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Printable ASCII (0x20-0x7E) minus backtick (0x60, closes a Markdown code span) and `|` (0x7C, a Markdown table
// cell separator); control characters — including newline — are already outside 0x20-0x7E. Verified against
// realistic values: `ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)` and a Chrome UA with
// parentheses/semicolons/slashes both pass; a GPU or platform string containing a `®`/`™` glyph would be rejected
// (rare, but real on some Windows driver strings) since those are outside 7-bit ASCII entirely.
const SAFE_STRING = /^[\x20-\x5F\x61-\x7B\x7D-\x7E]*$/;

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function keysExactly(obj, keys, path, errors) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${path}.${JSON.stringify(k)}: unknown key`);
  for (const k of keys) if (!Object.hasOwn(obj, k)) errors.push(`${path}.${JSON.stringify(k)}: missing`);
}
function num(v, path, errors, { max = 1e12 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${path}: expected a finite number in [0, ${max}]`);
}
/** A safe string: at most MAX_STRING printable ASCII characters, no `|`, backtick or newline. Returns whether it's valid. */
function str(v, path, errors) {
  const ok = typeof v === 'string' && v.length <= MAX_STRING && SAFE_STRING.test(v);
  if (!ok) errors.push(`${path}: expected a string of at most ${MAX_STRING} printable ASCII characters, without | or a backtick`);
  return ok;
}

/**
 * The issue body carries metrics as arrays in `metricKeys` order (shorter URLs). Returns the object form, or an
 * error string when the key list is not exactly METRIC_KEYS or an array has the wrong length.
 *
 * `scenes`/each scene's expanded block are built with `Object.create(null)`: `JSON.parse` admits `__proto__` as an
 * ordinary own key (it does not itself touch the object's prototype), but bracket-assigning that key onto a plain
 * `{}` — `scenes[id] = expanded` — invokes the inherited `__proto__` setter and replaces the *built* object's own
 * prototype with attacker data. An object with no prototype has no such setter, so the same assignment just
 * creates a real, ordinary `"__proto__"` property, which the caller's own-key checks (`Object.hasOwn`) then see
 * and reject like any other unrecognised scene id.
 */
export function expandWire(value) {
  if (!isObject(value) || !Object.hasOwn(value, 'metricKeys')) return { value };
  const keys = value.metricKeys;
  if (!Array.isArray(keys) || keys.length !== METRIC_KEYS.length || keys.some((k, i) => k !== METRIC_KEYS[i])) return { error: 'metricKeys: expected exactly the 20 metric keys in order' };
  const scenes = Object.create(null);
  if (isObject(value.scenes)) {
    for (const [id, block] of Object.entries(value.scenes)) {
      if (!isObject(block)) {
        scenes[id] = block;
        continue;
      }
      const expanded = Object.create(null);
      for (const [variant, arr] of Object.entries(block)) {
        if (!Array.isArray(arr)) {
          expanded[variant] = arr;
          continue;
        }
        if (arr.length !== keys.length) return { error: `scenes.${JSON.stringify(id)}.${JSON.stringify(variant)}: expected ${keys.length} values` };
        expanded[variant] = Object.fromEntries(keys.map((k, i) => [k, arr[i]]));
      }
      scenes[id] = expanded;
    }
  }
  const { metricKeys: _keys, ...rest } = value;
  return { value: { ...rest, scenes: isObject(value.scenes) ? scenes : value.scenes } };
}

/** `{ ok: true, result }` or `{ ok: false, errors }` with one line per problem. Accepts the wire form too. */
export function validateDeviceResult(input) {
  const wire = expandWire(input);
  if (wire.error) return { ok: false, errors: [wire.error] };
  const value = wire.value;
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['result: expected an object'] };
  keysExactly(value, ['schemaVersion', 'kind', 'id', 'createdAt', 'env', 'scenes'], 'result', errors);
  if (value.schemaVersion !== 1) errors.push('result.schemaVersion: expected 1');
  if (value.kind !== 'device') errors.push("result.kind: expected 'device'");
  const idFormatOk = typeof value.id === 'string' && ID.test(value.id);
  if (!idFormatOk) errors.push('result.id: expected YYYY-MM-DD-xxxxxxxx');
  const createdAtOk = typeof value.createdAt === 'string' && ISO_CREATED_AT.test(value.createdAt) && !Number.isNaN(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt;
  if (!createdAtOk) errors.push('result.createdAt: expected a strict ISO 8601 date-time (YYYY-MM-DDTHH:mm:ss.sssZ)');
  let envIdFieldsOk = false;
  if (isObject(value.env)) {
    const e = value.env;
    keysExactly(e, ENV_KEYS, 'env', errors);
    str(e.three, 'env.three', errors);
    const backendOk = e.backend === 'webgl2' || e.backend === 'webgpu';
    if (!backendOk) errors.push('env.backend: expected webgl2 or webgpu');
    if (typeof e.multiDraw !== 'boolean') errors.push('env.multiDraw: expected a boolean');
    if (!['desktop', 'phone-mid', 'phone-low'].includes(e.tier)) errors.push('env.tier: unknown tier');
    const gpuOk = str(e.gpu, 'env.gpu', errors);
    num(e.dpr, 'env.dpr', errors, { max: 10 });
    if (!Array.isArray(e.viewport) || e.viewport.length !== 2) errors.push('env.viewport: expected [width, height]');
    else e.viewport.forEach((v, i) => num(v, `env.viewport[${i}]`, errors, { max: 20000 }));
    const uaOk = str(e.ua, 'env.ua', errors);
    str(e.platform, 'env.platform', errors);
    if (e.cores !== null) num(e.cores, 'env.cores', errors, { max: 1024 });
    if (e.deviceMemory !== null) num(e.deviceMemory, 'env.deviceMemory', errors, { max: 1024 });
    if (e.fillRateGPix !== null) num(e.fillRateGPix, 'env.fillRateGPix', errors, { max: 1e6 });
    envIdFieldsOk = gpuOk && uaOk && backendOk;
  } else errors.push('env: expected an object');
  // Only checked once the pieces that feed the hash are themselves well-formed, so a bad gpu/ua/backend/createdAt
  // reports as exactly that, not also as a confusing "id doesn't match" pile-on.
  if (idFormatOk && createdAtOk && envIdFieldsOk) {
    const expectedId = computeResultId(value.env, value.createdAt.slice(0, 10));
    if (value.id !== expectedId) errors.push(`result.id: expected ${JSON.stringify(expectedId)} from createdAt and env`);
  }
  if (isObject(value.scenes)) {
    keysExactly(value.scenes, SCENE_IDS, 'scenes', errors);
    for (const [id, block] of Object.entries(value.scenes)) {
      if (!SCENE_IDS.includes(id)) continue;
      if (!isObject(block)) {
        errors.push(`scenes.${JSON.stringify(id)}: expected an object`);
        continue;
      }
      keysExactly(block, ['naive', 'optimized'], `scenes.${JSON.stringify(id)}`, errors);
      for (const variant of ['naive', 'optimized']) {
        const m = block[variant];
        if (!isObject(m)) {
          errors.push(`scenes.${JSON.stringify(id)}.${JSON.stringify(variant)}: expected an object`);
          continue;
        }
        keysExactly(m, METRIC_KEYS, `scenes.${JSON.stringify(id)}.${JSON.stringify(variant)}`, errors);
        for (const k of METRIC_KEYS) if (Object.hasOwn(m, k)) num(m[k], `scenes.${JSON.stringify(id)}.${JSON.stringify(variant)}.${k}`, errors);
        if (m.unattributed !== 0) errors.push(`scenes.${JSON.stringify(id)}.${JSON.stringify(variant)}.unattributed: must be 0`);
      }
    }
  } else errors.push('scenes: expected an object');
  return errors.length ? { ok: false, errors } : { ok: true, result: value };
}
