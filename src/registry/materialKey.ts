import { Material, type Color, type Texture } from 'three';
import { NodeMaterial } from 'three/webgpu';

/**
 * Three keys describe a material:
 * - programKey: everything that changes the generated shader or pipeline state (mirrors what
 *   three's RenderObject.getMaterialCacheKey() looks at). Same programKey = same GPU program. Material code joins it
 *   by identity, never by source text: every own function-valued property (an instance `setup*`, `onBeforeRender`,
 *   `onBeforeCompile`, `customProgramCacheKey` …) and an `onBeforeCompile` or `customProgramCacheKey` that is not
 *   three's default (one a subclass declares), so two closures with the same text but different captured state
 *   never share a key.
 * - variantKey: programKey + uniform values + texture identity/transform/sampler + (`visible=0` when
 *   `material.visible` is false). Same variantKey = drawable in one BatchedMesh (colour excluded, it is
 *   per-instance in BatchedMesh).
 * - colorKey: the `color` property alone, as an exact linear-float encoding (not 8-bit sRGB hex): two colours
 *   less than 1/255 apart stay distinct, and an HDR value (a channel > 1) stays distinct from another HDR value
 *   that would otherwise clamp to the same hex. Used for registry/canonical identity and for grouping (e.g.
 *   sprite batching) — never for display.
 * - colorHex: `color.getHexString()`, the 8-bit sRGB hex. Display only; never used for identity or grouping.
 *
 * A user-added own property holding plain data (object literals, arrays, primitives) is keyed by value; a function
 * or any other object inside it (a Texture, an Object3D, a class instance) is keyed by identity and never walked.
 */
export interface MaterialKeys {
  programKey: string;
  variantKey: string;
  colorKey: string;
  colorHex: string;
  unsupported: boolean;
  /** Human readable summary, e.g. "MeshStandardMaterial map normalMap transparent side=Double". */
  description: string;
}

/** Numbers that are plain uniforms: they never change the program. */
const UNIFORM_NUMBERS = new Set([
  'opacity', 'roughness', 'metalness', 'emissiveIntensity', 'envMapIntensity', 'lightMapIntensity', 'aoMapIntensity',
  'bumpScale', 'displacementScale', 'displacementBias', 'shininess', 'reflectivity', 'refractionRatio', 'ior',
  'thickness', 'attenuationDistance', 'clearcoatRoughness', 'sheenRoughness', 'iridescenceIOR', 'specularIntensity',
  'anisotropyRotation', 'wireframeLinewidth', 'linewidth', 'size', 'rotation', 'blendAlpha', 'polygonOffsetFactor',
  'polygonOffsetUnits', 'alphaHashScale', 'dashSize', 'gapSize', 'scale', 'dashOffset',
]);

/** Numbers that are state enums: their exact value selects pipeline state or a code path. */
const ENUM_NUMBERS = new Set([
  'side', 'blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha',
  'depthFunc', 'stencilWriteMask', 'stencilFunc', 'stencilRef', 'stencilFuncMask', 'stencilFail', 'stencilZFail',
  'stencilZPass', 'shadowSide', 'normalMapType', 'combine', 'depthPacking',
]);

/** Properties that never affect rendering identity. */
const SKIP = new Set(['id', 'uuid', 'name', 'type', 'visible', 'version', 'userData', 'needsUpdate', 'allowOverride']);

const SIDE_NAMES: Record<number, string> = { 0: 'Front', 1: 'Back', 2: 'Double' };

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashKey(key: string): string {
  return fnv1a(key);
}

/**
 * One number per function or non-plain object, written `#n` in a key. Held weakly, so keying never keeps a material's
 * code or data alive, and never reused while the process runs: the same object always gets the same number, a
 * different object never does. The numbers follow the order objects are first keyed, so a hash that includes one
 * is stable within a run, not across runs.
 */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identityOf(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(value, id);
  }
  return id;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function textureKind(texture: Texture): string {
  const t = texture as Texture & { isCubeTexture?: boolean; isDataArrayTexture?: boolean; isData3DTexture?: boolean; isVideoTexture?: boolean };
  if (t.isCubeTexture) return 'cube';
  if (t.isDataArrayTexture) return 'array';
  if (t.isData3DTexture) return '3d';
  if (t.isVideoTexture) return 'video';
  return '2d';
}

/**
 * Plain data by value: primitives as JSON, arrays in order, object literals (and `Object.create(null)` objects) with
 * sorted keys. Everything else by identity, `#n`, without walking it: a function, or an object whose prototype is not
 * `Object.prototype`, `Array.prototype` or null (a Texture, an Object3D and its scene graph, a class instance, a typed
 * array). Cycle-safe: an object or array already on the path from the root is written `^d`, a reference to its
 * ancestor at depth d, so a value that contains itself keys by its shape. A shared (non-cyclic) reference is walked
 * each time it is reached, so two values with the same data match however they share it. `#` and `^` cannot start a
 * JSON value, so neither marker collides with plain data.
 */
function stableJson(value: unknown, path: object[] = []): string {
  if (typeof value === 'function') return `#${identityOf(value)}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return `#${identityOf(value)}`;
  const depth = path.indexOf(value);
  if (depth !== -1) return `^${depth}`;
  path.push(value);
  try {
    if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, path)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k], path)}`).join(',')}}`;
  } finally {
    path.pop();
  }
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(7);
}

export function computeMaterialKeys(material: Material): MaterialKeys {
  const m = material as Material & Record<string, unknown>;
  const forgeKey: unknown = material.userData?.forgeKey;
  if (typeof forgeKey === 'string') {
    const key = `forgeKey:${forgeKey}`;
    return { programKey: key, variantKey: key, colorKey: '', colorHex: '', unsupported: false, description: `${material.type} forgeKey=${forgeKey}` };
  }
  if ((m.isShaderMaterial as boolean | undefined) || (m.isRawShaderMaterial as boolean | undefined)) {
    const key = `unsupported:${material.uuid}`;
    return { programKey: key, variantKey: key, colorKey: '', colorHex: '', unsupported: true, description: `${material.type} (unsupported in WebGPURenderer)` };
  }

  const program: string[] = [`type=${material.type}`];
  const variant: string[] = [];
  const maps: string[] = [];
  const flags: string[] = [];
  let colorKey = '';
  let colorHex = '';

  const custom = typeof material.customProgramCacheKey === 'function' ? material.customProgramCacheKey() : '';
  if (custom) program.push(`custom=${fnv1a(String(custom))}`);

  // Material code, by identity (`identityOf`), never by `toString()`: closures with the same source text can capture
  // different state, and three's classic default `customProgramCacheKey()` above is `onBeforeCompile.toString()`.
  // Code joins the program key because three builds the program from it: WebGLPrograms keys `customProgramCacheKey()`
  // and WebGLRenderer runs `onBeforeCompile` on the shader source, NodeMaterial.setup calls the `setup*` functions to
  // build the node graph, and RenderObject.getMaterialCacheKey reads every own property, functions included (as
  // `String(value)`).
  // So every own function-valued property counts (an instance `setup*`, `onBeforeRender`, `onBeforeCompile`,
  // `customProgramCacheKey` …), and so does an `onBeforeCompile` or `customProgramCacheKey` that is not three's default
  // (`Material`'s, or `NodeMaterial`'s cache key): one a subclass declares. Other prototype functions, the class code
  // (`setup*` on a node material class), add nothing; the `type` above already names the class.
  for (const name of Object.getOwnPropertyNames(m).sort()) {
    const value = m[name];
    if (typeof value === 'function') program.push(`${name}=#${identityOf(value)}`);
  }
  if (!hasOwn(m, 'onBeforeCompile') && typeof material.onBeforeCompile === 'function' && material.onBeforeCompile !== Material.prototype.onBeforeCompile) {
    program.push(`onBeforeCompile=#${identityOf(material.onBeforeCompile)}`);
  }
  const cacheKeyFunction = material.customProgramCacheKey;
  if (
    !hasOwn(m, 'customProgramCacheKey') && typeof cacheKeyFunction === 'function'
    && cacheKeyFunction !== Material.prototype.customProgramCacheKey && cacheKeyFunction !== NodeMaterial.prototype.customProgramCacheKey
  ) {
    program.push(`customProgramCacheKey=#${identityOf(cacheKeyFunction)}`);
  }

  const alphaTest = typeof m.alphaTest === 'number' ? (m.alphaTest as number) : 0;
  program.push(`alphaTest=${alphaTest > 0 ? 1 : 0}`);
  variant.push(`alphaTest=${num(alphaTest)}`);
  if (alphaTest > 0) flags.push('alphaTest');
  // `visible` never affects the program (it is not skipped there, it is simply never read for it); it joins the
  // variant key only when false, so the registry never merges a hidden material with an otherwise-identical
  // visible one. `SKIP` still excludes it from the generic property loop below.
  if (material.visible === false) variant.push('visible=0');

  for (const rawKey of Object.keys(m).sort()) {
    // EventDispatcher's listener map, created by the first `addEventListener`. Renderers add a `dispose` listener to
    // every material they draw (WebGLRenderer.js:2216; a closure per render object, RenderObject.js:359), so it
    // records whether and where a material was drawn, not how it draws. three's getMaterialCacheKey skips every `_`
    // property.
    if (rawKey === '_listeners') continue;
    // Feature gates such as transmission/clearcoat/sheen are accessors backed by `_name` fields; read the accessor.
    const key = rawKey.startsWith('_') ? rawKey.slice(1) : rawKey;
    if (SKIP.has(key) || key === 'alphaTest' || key.startsWith('is')) continue;
    const value = key in m ? m[key] : m[rawKey];
    // Functions were keyed by identity above.
    if (value === null || value === undefined || typeof value === 'function') continue;

    if (typeof value === 'boolean') {
      program.push(`${key}=${value ? 1 : 0}`);
      if (value && (key === 'transparent' || key === 'vertexColors' || key === 'wireframe' || key === 'flatShading' || key === 'alphaHash')) flags.push(key);
      continue;
    }
    if (typeof value === 'number') {
      if (UNIFORM_NUMBERS.has(key)) {
        variant.push(`${key}=${num(value)}`);
      } else if (ENUM_NUMBERS.has(key)) {
        program.push(`${key}=${value}`);
        if (key === 'side' && value !== 0) flags.push(`side=${SIDE_NAMES[value] ?? value}`);
      } else {
        // Feature gates such as transmission/clearcoat/sheen: presence changes code, magnitude is a uniform.
        program.push(`${key}=${value !== 0 ? 1 : 0}`);
        variant.push(`${key}=${num(value)}`);
        if (value !== 0) flags.push(key);
      }
      continue;
    }
    if (typeof value === 'string') {
      program.push(`${key}=${value}`);
      continue;
    }
    if (typeof value !== 'object') continue;

    const obj = value as Record<string, unknown>;
    if (obj.isTexture) {
      const t = value as Texture;
      program.push(`${key}=tex:${textureKind(t)}:${t.mapping}:${t.channel}:${t.colorSpace}`);
      variant.push(
        `${key}=${t.uuid}:${t.offset.x},${t.offset.y}:${t.repeat.x},${t.repeat.y}:${num(t.rotation)}:${t.center.x},${t.center.y}:${t.wrapS}:${t.wrapT}:${t.minFilter}:${t.magFilter}:${t.anisotropy}`,
      );
      maps.push(key);
      continue;
    }
    if (obj.isColor) {
      // Exact linear floats, not 8-bit sRGB hex: two colours under 1/255 apart, or two HDR values (a channel > 1)
      // that would both clamp to the same hex, must stay distinct. `color.r/g/b` are already linear (three's
      // working colour space), so no conversion is needed here.
      const color = value as Color;
      const exact = `${num(color.r)},${num(color.g)},${num(color.b)}`;
      if (key === 'color') {
        colorKey = exact;
        colorHex = color.getHexString();
      } else {
        variant.push(`${key}=${exact}`);
      }
      continue;
    }
    if (obj.isNode) {
      const node = value as { getCacheKey?: () => number | string; id?: number };
      program.push(`${key}=node:${typeof node.getCacheKey === 'function' ? node.getCacheKey() : `id${node.id}`}`);
      continue;
    }
    if (typeof (obj as { toArray?: unknown }).toArray === 'function') {
      // Vector2/3/4, Euler, Matrix3/4, Quaternion: uniform data.
      const array = (value as { toArray(): unknown[] }).toArray().map((v) => (typeof v === 'number' ? num(v) : String(v)));
      variant.push(`${key}=${array.join(',')}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'number')) variant.push(`${key}=${value.map(num).join(',')}`);
      else program.push(`${key}=len${value.length}`);
      continue;
    }
    // Plain objects such as `defines` by value; a user-added property holding a class instance (an Object3D, a Map)
    // by identity (`stableJson`).
    program.push(`${key}=${stableJson(value)}`);
  }

  const programKey = program.join('|');
  const variantKey = `${programKey}||${variant.join('|')}`;
  const description = [material.type, ...maps, ...flags].join(' ');
  return { programKey, variantKey, colorKey, colorHex, unsupported: false, description };
}
