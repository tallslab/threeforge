// Validates a device bench result submitted through a GitHub issue. Hand-written: exact key sets, finite
// non-negative numbers, capped strings, known scenes. Issue text is data; nothing here evaluates it.
export const SCENE_IDS = ['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'];
export const METRIC_KEYS = ['sceneSubmissions', 'gpuDraws', 'triangles', 'programs', 'overdrawOpaque', 'overdrawTransparent', 'skinnedVertices', 'shadowCasters', 'shadowTexels', 'textureBytes', 'geometryBytes', 'renderTargetBytes', 'particles', 'fillMegapixels', 'objects', 'autoUpdatedMatrices', 'shadowPassesPerFrame', 'renderMs', 'frameMs', 'unattributed'];
export const ENV_KEYS = ['three', 'backend', 'multiDraw', 'tier', 'gpu', 'dpr', 'viewport', 'ua', 'platform', 'cores', 'deviceMemory', 'fillRateGPix'];
const MAX_STRING = 200;
const ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{8}$/;

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function keysExactly(obj, keys, path, errors) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${path}.${k}: unknown key`);
  for (const k of keys) if (!(k in obj)) errors.push(`${path}.${k}: missing`);
}
function num(v, path, errors, { max = 1e12 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) errors.push(`${path}: expected a finite number in [0, ${max}]`);
}
function str(v, path, errors) {
  if (typeof v !== 'string' || v.length > MAX_STRING) errors.push(`${path}: expected a string of at most ${MAX_STRING} characters`);
}

/**
 * The issue body carries metrics as arrays in `metricKeys` order (shorter URLs). Returns the object form, or an
 * error string when the key list is not exactly METRIC_KEYS or an array has the wrong length.
 */
export function expandWire(value) {
  if (!isObject(value) || !('metricKeys' in value)) return { value };
  const keys = value.metricKeys;
  if (!Array.isArray(keys) || keys.length !== METRIC_KEYS.length || keys.some((k, i) => k !== METRIC_KEYS[i])) return { error: 'metricKeys: expected exactly the 20 metric keys in order' };
  const scenes = {};
  if (isObject(value.scenes)) {
    for (const [id, block] of Object.entries(value.scenes)) {
      if (!isObject(block)) {
        scenes[id] = block;
        continue;
      }
      const expanded = {};
      for (const [variant, arr] of Object.entries(block)) {
        if (!Array.isArray(arr)) {
          expanded[variant] = arr;
          continue;
        }
        if (arr.length !== keys.length) return { error: `scenes.${id}.${variant}: expected ${keys.length} values` };
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
  if (typeof value.id !== 'string' || !ID.test(value.id)) errors.push('result.id: expected YYYY-MM-DD-xxxxxxxx');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)) || value.createdAt.length > 40) errors.push('result.createdAt: expected an ISO date');
  if (isObject(value.env)) {
    const e = value.env;
    keysExactly(e, ENV_KEYS, 'env', errors);
    str(e.three, 'env.three', errors);
    if (e.backend !== 'webgl2' && e.backend !== 'webgpu') errors.push('env.backend: expected webgl2 or webgpu');
    if (typeof e.multiDraw !== 'boolean') errors.push('env.multiDraw: expected a boolean');
    if (!['desktop', 'phone-mid', 'phone-low'].includes(e.tier)) errors.push('env.tier: unknown tier');
    str(e.gpu, 'env.gpu', errors);
    num(e.dpr, 'env.dpr', errors, { max: 10 });
    if (!Array.isArray(e.viewport) || e.viewport.length !== 2) errors.push('env.viewport: expected [width, height]');
    else e.viewport.forEach((v, i) => num(v, `env.viewport[${i}]`, errors, { max: 20000 }));
    str(e.ua, 'env.ua', errors);
    str(e.platform, 'env.platform', errors);
    if (e.cores !== null) num(e.cores, 'env.cores', errors, { max: 1024 });
    if (e.deviceMemory !== null) num(e.deviceMemory, 'env.deviceMemory', errors, { max: 1024 });
    if (e.fillRateGPix !== null) num(e.fillRateGPix, 'env.fillRateGPix', errors, { max: 1e6 });
  } else errors.push('env: expected an object');
  if (isObject(value.scenes)) {
    keysExactly(value.scenes, SCENE_IDS, 'scenes', errors);
    for (const [id, block] of Object.entries(value.scenes)) {
      if (!SCENE_IDS.includes(id)) continue;
      if (!isObject(block)) {
        errors.push(`scenes.${id}: expected an object`);
        continue;
      }
      keysExactly(block, ['naive', 'optimized'], `scenes.${id}`, errors);
      for (const variant of ['naive', 'optimized']) {
        const m = block[variant];
        if (!isObject(m)) {
          errors.push(`scenes.${id}.${variant}: expected an object`);
          continue;
        }
        keysExactly(m, METRIC_KEYS, `scenes.${id}.${variant}`, errors);
        for (const k of METRIC_KEYS) if (k in m) num(m[k], `scenes.${id}.${variant}.${k}`, errors);
        if (m.unattributed !== 0) errors.push(`scenes.${id}.${variant}.unattributed: must be 0`);
      }
    }
  } else errors.push('scenes: expected an object');
  return errors.length ? { ok: false, errors } : { ok: true, result: value };
}
