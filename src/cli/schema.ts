/** JSON Schemas (draft 2020-12) for the data an agent sees: the snapshot and the analyze/inspect documents. */
type Schema = Record<string, unknown>;
const number: Schema = { type: 'number' };
const integer: Schema = { type: 'integer' };
const string: Schema = { type: 'string' };
const boolean: Schema = { type: 'boolean' };
const obj = (properties: Record<string, Schema>, extra: Schema = {}): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...extra });
const map = (values: Schema): Schema => ({ type: 'object', additionalProperties: values });
const arr = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });

const hint = obj({ category: { enum: ['drawCalls', 'overdraw', 'skinning', 'lighting', 'js', 'memory'] }, severity: { enum: ['info', 'warn', 'error'] }, code: string, message: string, objects: arr(string) });

export const SNAPSHOT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://threeforge.dev/schema/frame-snapshot-v2.json',
  title: 'threeforge FrameSnapshot v2',
  type: 'object',
  properties: {
    schemaVersion: { const: 2 },
    env: obj({ three: string, backend: { enum: ['webgl2', 'webgpu', 'unknown'] }, multiDraw: boolean, tier: { enum: ['desktop', 'phone-mid', 'phone-low'] }, gpu: string, dpr: number, viewport: { type: 'array', items: number, minItems: 2, maxItems: 2 } }),
    totals: obj({ submissions: integer, sceneSubmissions: integer, gpuDraws: integer, reportedDrawCalls: integer, unattributed: integer, programSwitches: integer, programs: integer, triangles: integer, instances: integer, instancesDrawn: integer, drawCommands: integer }),
    passes: arr(obj({ id: string, submissions: integer, gpuDraws: integer })),
    byReason: map(obj({ submissions: integer, gpuDraws: integer, top: arr(string) })),
    programs: map(obj({ type: string, description: string, submissions: integer })),
    overdraw: obj({ opaque: number, transparent: number, transparentSubmissions: integer, measured: boolean }),
    skinning: obj({ submissions: integer, vertices: integer, bones: integer, skeletons: integer, maxBones: integer, morphTargets: integer }),
    lighting: obj({ lights: obj({ directional: integer, point: integer, spot: integer, hemisphere: integer, ambient: integer, other: integer }), shadowLights: integer, shadowPasses: integer, shadowCasters: integer, shadowTexels: integer, shadowSubmissions: integer }),
    js: obj({ renderMs: number, frameMs: number, objects: integer, autoUpdatedMatrices: integer }),
    memory: obj({ textures: obj({ count: integer, bytes: integer }), geometries: obj({ count: integer, bytes: integer }), renderTargets: obj({ count: integer, bytes: integer }), estimated: { const: true } }),
    hints: arr(hint),
    items: arr(obj({ name: string, kind: string, materialType: string, programHash: string, variantHash: string, transparent: boolean, pass: string, reason: string, flags: arr(string), expectedGpuDraws: integer, instances: integer, instancesDrawn: integer, vertices: integer, bones: integer, skeleton: nullable(integer), morphTargets: integer })),
  } as Record<string, Schema>,
  required: ['byReason', 'env', 'hints', 'js', 'lighting', 'memory', 'overdraw', 'passes', 'programs', 'schemaVersion', 'skinning', 'totals'],
  additionalProperties: false,
};

const runInput = (first: Record<string, Schema>): Schema => obj({ ...first, backend: { enum: ['webgl2', 'webgpu'] }, tier: { enum: ['auto', 'desktop', 'phone-mid', 'phone-low'] }, budget: nullable(number), frames: integer, compile: boolean, timeout: number, headed: boolean });
const verdict = obj({ pass: boolean, budget: nullable(obj({ maxSubmissions: number, actual: integer, pass: boolean })), errors: arr(string), reasons: arr(string) });
const asset = obj({ meshes: integer, materials: integer, vertices: integer, triangles: integer, animations: integer, skinned: integer, morph: integer, loadMs: number });
const parity = obj({ diffPct: number, threshold: number, pass: boolean, views: arr(obj({ view: string, diffPct: number })) });
const compileReport: Schema = { type: 'object', description: 'threeforge CompileReport: before/after counts, groups, skipped meshes with their rule', additionalProperties: true };

function document(command: 'analyze' | 'inspect', input: Schema, assetSchema: Schema, paritySchema: Schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://threeforge.dev/schema/${command}-v1.json`,
    title: `threeforge ${command} document v1`,
    type: 'object',
    properties: {
      schemaVersion: { const: 1 },
      tool: { const: 'threeforge' },
      version: string,
      command: { const: command },
      input,
      env: SNAPSHOT_SCHEMA.properties.env!,
      asset: assetSchema,
      before: { $ref: SNAPSHOT_SCHEMA.$id },
      after: nullable({ $ref: SNAPSHOT_SCHEMA.$id }),
      compile: nullable(compileReport),
      parity: paritySchema,
      hints: arr(hint),
      verdict,
      timings: obj({ totalMs: number }),
    } as Record<string, Schema>,
    required: ['schemaVersion', 'tool', 'version', 'command', 'input', 'env', 'asset', 'before', 'after', 'compile', 'parity', 'hints', 'verdict', 'timings'],
    additionalProperties: false,
  };
}

export const ANALYZE_SCHEMA = document('analyze', obj({ file: string, backend: { enum: ['webgl2', 'webgpu'] }, tier: { enum: ['auto', 'desktop', 'phone-mid', 'phone-low'] }, budget: nullable(number), frames: integer, compile: boolean, bake: { enum: ['off', 'on', 'buried'] }, views: integer, timeout: number, headed: boolean }), asset, nullable(parity));
export const INSPECT_SCHEMA = document('inspect', runInput({ url: string }), { type: 'null' }, { type: 'null' });

const counts = obj({ nodes: integer, meshes: integer, primitives: integer, materials: integer, textures: integer, accessors: integer, vertices: integer, triangles: integer });
const assetStats = obj({ nodes: integer, meshes: integer, primitives: integer, materials: integer, textures: integer, accessors: integer, vertices: integer, triangles: integer, bytes: integer, textureBytes: integer, animations: integer, skins: integer, morphTargets: integer, extensions: arr(string) });
const stepName = { enum: ['dedup', 'instance', 'palette', 'flatten', 'join', 'weld', 'simplify', 'resample', 'prune', 'textures', 'quantize', 'meshopt'] };
const optimizeInput = obj({
  file: string,
  out: nullable(string),
  preset: { enum: ['safe', 'balanced', 'aggressive'] },
  steps: map(boolean),
  simplify: nullable(number),
  simplifyError: number,
  compress: { enum: ['none', 'meshopt'] },
  textures: nullable({ enum: ['none', 'webp', 'avif'] }),
  textureSize: nullable(integer),
  textureQuality: number,
  verify: boolean,
  parity: number,
  views: integer,
  backend: { enum: ['webgl2', 'webgpu'] },
  tier: { enum: ['auto', 'desktop', 'phone-mid', 'phone-low'] },
  budget: nullable(number),
  frames: integer,
  compile: boolean,
  timeout: number,
  headed: boolean,
});
const optimizeProperties: Record<string, Schema> = {
  schemaVersion: { const: 1 },
  tool: { const: 'threeforge' },
  version: string,
  command: { const: 'optimize' },
  input: optimizeInput,
  output: obj({ file: string, bytes: integer }),
  stats: obj({ before: assetStats, after: assetStats }),
  steps: arr(obj({ name: stepName, applied: boolean, ms: number, note: nullable(string), before: counts, after: counts })),
  requires: arr(obj({ extension: string, needs: string, code: nullable(string) })),
  verify: nullable(obj({ backend: { enum: ['webgl2', 'webgpu'] }, parity, original: { $ref: ANALYZE_SCHEMA.$id }, optimized: { $ref: ANALYZE_SCHEMA.$id }, delta: obj({ bytes: integer, materials: integer, vertices: integer, triangles: integer, sceneSubmissions: obj({ naive: integer, compiled: nullable(integer) }), loadMs: number, memoryBytes: integer }) })),
  verdict,
  timings: obj({ transformMs: number, verifyMs: number, totalMs: number }),
};
/** `threeforge schema optimize`: the document `optimize` prints. */
export const OPTIMIZE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://threeforge.dev/schema/optimize-v1.json',
  title: 'threeforge optimize document v1',
  type: 'object',
  properties: optimizeProperties,
  required: Object.keys(optimizeProperties).sort(),
  additionalProperties: false,
};
