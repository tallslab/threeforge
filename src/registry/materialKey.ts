import type { Material, Texture } from 'three';

/**
 * Three keys describe a material:
 * - programKey: everything that changes the generated shader or pipeline state (mirrors what
 *   three's RenderObject.getMaterialCacheKey() looks at). Same programKey = same GPU program.
 * - variantKey: programKey + uniform values + texture identity/transform/sampler. Same variantKey
 *   = drawable in one BatchedMesh (colour excluded, it is per-instance in BatchedMesh).
 * - colorKey: the `color` property alone.
 */
export interface MaterialKeys {
  programKey: string;
  variantKey: string;
  colorKey: string;
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

function textureKind(texture: Texture): string {
  const t = texture as Texture & { isCubeTexture?: boolean; isDataArrayTexture?: boolean; isData3DTexture?: boolean; isVideoTexture?: boolean };
  if (t.isCubeTexture) return 'cube';
  if (t.isDataArrayTexture) return 'array';
  if (t.isData3DTexture) return '3d';
  if (t.isVideoTexture) return 'video';
  return '2d';
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toPrecision(7);
}

export function computeMaterialKeys(material: Material): MaterialKeys {
  const m = material as Material & Record<string, unknown>;
  const forgeKey: unknown = material.userData?.forgeKey;
  if (typeof forgeKey === 'string') {
    const key = `forgeKey:${forgeKey}`;
    return { programKey: key, variantKey: key, colorKey: '', unsupported: false, description: `${material.type} forgeKey=${forgeKey}` };
  }
  if ((m.isShaderMaterial as boolean | undefined) || (m.isRawShaderMaterial as boolean | undefined)) {
    const key = `unsupported:${material.uuid}`;
    return { programKey: key, variantKey: key, colorKey: '', unsupported: true, description: `${material.type} (unsupported in WebGPURenderer)` };
  }

  const program: string[] = [`type=${material.type}`];
  const variant: string[] = [];
  const maps: string[] = [];
  const flags: string[] = [];
  let colorKey = '';

  const custom = typeof material.customProgramCacheKey === 'function' ? material.customProgramCacheKey() : '';
  if (custom) program.push(`custom=${fnv1a(String(custom))}`);

  const alphaTest = typeof m.alphaTest === 'number' ? (m.alphaTest as number) : 0;
  program.push(`alphaTest=${alphaTest > 0 ? 1 : 0}`);
  variant.push(`alphaTest=${num(alphaTest)}`);
  if (alphaTest > 0) flags.push('alphaTest');

  for (const rawKey of Object.keys(m).sort()) {
    // Feature gates such as transmission/clearcoat/sheen are accessors backed by `_name` fields; read the accessor.
    const key = rawKey.startsWith('_') ? rawKey.slice(1) : rawKey;
    if (SKIP.has(key) || key === 'alphaTest' || key.startsWith('is')) continue;
    const value = key in m ? m[key] : m[rawKey];
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
      const hex = (value as { getHexString(): string }).getHexString();
      if (key === 'color') colorKey = hex;
      else variant.push(`${key}=${hex}`);
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
    // Plain objects such as `defines`.
    program.push(`${key}=${stableJson(value)}`);
  }

  const programKey = program.join('|');
  const variantKey = `${programKey}||${variant.join('|')}`;
  const description = [material.type, ...maps, ...flags].join(' ');
  return { programKey, variantKey, colorKey, unsupported: false, description };
}
