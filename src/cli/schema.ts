/** JSON Schemas (draft 2020-12) for the data an agent sees: the snapshot and the analyze/inspect documents. */
import { SNAPSHOT_SCHEMA_VERSION } from '../ledger/snapshot.js';

type Schema = Record<string, unknown>;
/**
 * An object schema with named properties. `Schema` itself is `Record<string, unknown>`, and spreading that into
 * `SNAPSHOT_SCHEMA` erases the very keys its consumers read (`properties`, `required`), so the bodies below are
 * annotated with this narrowing of it instead.
 */
type ObjectSchema = {
  type: 'object';
  properties: Record<string, Schema>;
  required: string[];
  additionalProperties: boolean;
};
const number: Schema = { type: 'number' };
const integer: Schema = { type: 'integer' };
const string: Schema = { type: 'string' };
const boolean: Schema = { type: 'boolean' };
const obj = (properties: Record<string, Schema>, extra: Schema = {}): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...extra,
});
const map = (values: Schema): Schema => ({ type: 'object', additionalProperties: values });
const arr = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });

const hint = obj({
  category: { enum: ['drawCalls', 'overdraw', 'skinning', 'lighting', 'js', 'memory'] },
  severity: { enum: ['info', 'warn', 'error'] },
  code: string,
  message: string,
  objects: arr(string),
});

/** Groups submissions drawn with the same material program (three's own shader program cache key). */
const programHash: Schema = {
  type: 'string',
  description:
    'Groups submissions sharing one material program. Stable within a single run only, not across runs or processes, for materials with instance code, a non-built-in prototype, or identity-keyed own data (since v0.8.0).',
};
/** Groups submissions sharing one program *and* the same uniform values (colour, map, ...). */
const variantHash: Schema = {
  type: 'string',
  description:
    'Groups submissions sharing one program and the same uniform values (colour, map, etc). Same run-only stability caveat as programHash.',
};

/** The per-frame index of a submission's canonical material (`materialUses`). */
const materialIndex: Schema = {
  type: 'integer',
  minimum: 0,
  description:
    "Per-frame index of the submission's canonical material, in first-draw order: submissions drawing one material share it. Not stable across frames.",
};

const snapshotProperties: Record<string, Schema> = {
  schemaVersion: { const: SNAPSHOT_SCHEMA_VERSION },
  env: obj({
    three: string,
    backend: { enum: ['webgl2', 'webgpu', 'unknown'] },
    multiDraw: boolean,
    tier: { enum: ['desktop', 'phone-mid', 'phone-low'] },
    gpu: string,
    dpr: number,
    viewport: { type: 'array', items: number, minItems: 2, maxItems: 2 },
  }),
  totals: obj({
    submissions: integer,
    sceneSubmissions: integer,
    gpuDraws: integer,
    reportedDrawCalls: integer,
    unattributed: integer,
    programSwitches: integer,
    programs: integer,
    triangles: integer,
    instances: integer,
    instancesDrawn: integer,
    drawCommands: integer,
  }),
  passes: arr(obj({ id: string, submissions: integer, gpuDraws: integer })),
  byReason: map(obj({ submissions: integer, gpuDraws: integer, top: arr(string) })),
  programs: map(obj({ type: string, description: string, submissions: integer })),
  overdraw: obj({
    opaque: number,
    transparent: number,
    transparentSubmissions: integer,
    particles: integer,
    pixels: integer,
    measured: boolean,
  }),
  skinning: obj({
    submissions: integer,
    vertices: integer,
    bones: integer,
    skeletons: integer,
    maxBones: integer,
    morphTargets: integer,
    vatInstances: integer,
    vatVertices: integer,
  }),
  lighting: obj({
    lights: obj({
      directional: integer,
      point: integer,
      spot: integer,
      hemisphere: integer,
      ambient: integer,
      other: integer,
    }),
    shadowLights: integer,
    shadowPasses: integer,
    shadowCasters: integer,
    shadowTexels: integer,
    shadowSubmissions: integer,
  }),
  js: obj({
    renderMs: number,
    ledgerMs: number,
    frameMs: number,
    objects: integer,
    autoUpdatedMatrices: integer,
    hiddenOriginals: integer,
    skipped: integer,
  }),
  memory: obj({
    textures: obj({ count: integer, bytes: integer }),
    geometries: obj({ count: integer, bytes: integer }),
    renderTargets: obj({ count: integer, bytes: integer }),
    unreferenced: obj({ geometries: integer, textures: integer }),
    chunks: obj({ total: integer, resident: integer }),
    measured: nullable(
      obj({
        textures: obj({ count: integer, bytes: number }),
        geometries: obj({ count: integer, bytes: number }),
        renderTargets: obj({ count: integer }),
        bytes: number,
      }),
    ),
    estimated: { const: true },
  }),
  hints: arr(hint),
  items: arr(
    obj({
      name: string,
      kind: string,
      material: materialIndex,
      materialType: string,
      programHash,
      variantHash,
      transparent: boolean,
      pass: string,
      reason: string,
      flags: arr(string),
      expectedGpuDraws: integer,
      instances: integer,
      instancesDrawn: integer,
      vertices: integer,
      bones: integer,
      skeleton: nullable(integer),
      morphTargets: integer,
    }),
  ),
};
const snapshotRequired = [
  'byReason',
  'env',
  'hints',
  'js',
  'lighting',
  'memory',
  'overdraw',
  'passes',
  'programs',
  'schemaVersion',
  'skinning',
  'totals',
];

/**
 * The FrameSnapshot body: no `$schema`/`$id`/`title` of its own, so it can be embedded as `$defs.FrameSnapshot` in the
 * analyze/inspect/optimize document schemas below (referenced by `{ $ref: '#/$defs/FrameSnapshot' }`) without
 * registering a second schema under `frame-snapshot-v3.json`. Every exported schema then validates standalone in ajv:
 * no `addSchema` of the others, and no network or `$id` resolution at validation time.
 */
function frameSnapshotDef(): ObjectSchema {
  return { type: 'object', properties: snapshotProperties, required: snapshotRequired, additionalProperties: false };
}

export const SNAPSHOT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://threeforge.dev/schema/frame-snapshot-v3.json',
  title: 'threeforge FrameSnapshot v3',
  ...frameSnapshotDef(),
};

/**
 * The `schemaVersion` of the analyze, inspect and optimize documents. Their `$id` and title are built from it, so a
 * consumer caching schemas by `$id` never validates a v2 document against the v1 schema. `analyze`, `inspect` and
 * `optimize` stamp their documents with it (`AgentDocument`, `OptimizeDocument`).
 */
export const DOCUMENT_SCHEMA_VERSION = 2 as const;

const runInput = (first: Record<string, Schema>): Schema =>
  obj({
    ...first,
    backend: { enum: ['webgl2', 'webgpu'] },
    tier: { enum: ['auto', 'desktop', 'phone-mid', 'phone-low'] },
    budget: nullable(number),
    frames: integer,
    compile: boolean,
    timeout: number,
    headed: boolean,
  });
const verdict = obj({
  pass: boolean,
  budget: nullable(obj({ maxSubmissions: number, actual: integer, pass: boolean })),
  errors: arr(string),
  reasons: arr(string),
});
const asset = obj({
  meshes: integer,
  materials: integer,
  vertices: integer,
  triangles: integer,
  animations: integer,
  skinned: integer,
  morph: integer,
  loadMs: number,
});
const parity = obj({
  diffPct: number,
  threshold: number,
  pass: boolean,
  views: arr(obj({ view: string, diffPct: number, changedPixels: integer })),
});
const compileReport: Schema = {
  type: 'object',
  description:
    "threeforge CompileReport: before/after counts, groups, skipped meshes with their rule. Left open (additionalProperties: true) rather than enumerated field-by-field, except for the two true counts below; report fields worth knowing about: the bake summary's `keptCoincidentFaces` (coincident faces the seam guard kept), `keptDuplicateFaces` (exact copies the duplicate rule kept, for any of its reasons: an excluded or non-removable copy among them, copies that draw differently, or another triangle drawn over them) and `unbakeableEntries` (meshes batched instead of baked because the bake cannot prove the merged mesh draws what they drew: a node in any slot, an instance function, a subclass or a `displacementMap` in their material, or an attribute the bake does not carry), and `occlusion.skippedSynced` (batches opted out of occlusion culling because they hold synced movers). `skipped` and `groups` list at most 256 entries each (the CLI caps every array a page returns); `skippedCount` and `groupCount` are their true lengths.",
  properties: {
    skippedCount: {
      type: 'integer',
      minimum: 0,
      description: 'How many objects compile() skipped; `skipped` lists at most 256 of them.',
    },
    groupCount: {
      type: 'integer',
      minimum: 0,
      description: 'How many groups compile() built; `groups` lists at most 256 of them.',
    },
  },
  // Adding a required field to a document schema version that has shipped needs a bump; these two joined v2 before
  // 0.9.0 first shipped it.
  required: ['skippedCount', 'groupCount'],
  additionalProperties: true,
};

const analyzeInput = obj({
  file: string,
  backend: { enum: ['webgl2', 'webgpu'] },
  tier: { enum: ['auto', 'desktop', 'phone-mid', 'phone-low'] },
  budget: nullable(number),
  frames: integer,
  compile: boolean,
  bake: { enum: ['off', 'on', 'buried'] },
  views: integer,
  parity: number,
  timeout: number,
  headed: boolean,
});

/**
 * The analyze/inspect document body: no `$schema`/`$id`/`title`/`$defs` of its own, so `document()` can wrap it as a
 * standalone schema (adding its own `$defs.FrameSnapshot`) and `optimize`'s schema can nest it again as
 * `$defs.AnalyzeDocument` (reusing the enclosing schema's own `$defs.FrameSnapshot` — `before`/`after` always ref
 * `'#/$defs/FrameSnapshot'`, a JSON Pointer resolved against whichever root schema embeds this body).
 */
function documentBody(command: 'analyze' | 'inspect', input: Schema, assetSchema: Schema, paritySchema: Schema) {
  const snapshotRef: Schema = { $ref: '#/$defs/FrameSnapshot' };
  return {
    type: 'object',
    properties: {
      schemaVersion: { const: DOCUMENT_SCHEMA_VERSION },
      tool: { const: 'threeforge' },
      version: string,
      command: { const: command },
      input,
      env: snapshotProperties.env!,
      asset: assetSchema,
      before: snapshotRef,
      after: nullable(snapshotRef),
      compile: nullable(compileReport),
      parity: paritySchema,
      hints: arr(hint),
      verdict,
      timings: obj({ totalMs: number }),
    } as Record<string, Schema>,
    required: [
      'schemaVersion',
      'tool',
      'version',
      'command',
      'input',
      'env',
      'asset',
      'before',
      'after',
      'compile',
      'parity',
      'hints',
      'verdict',
      'timings',
    ],
    additionalProperties: false,
  };
}

function document(command: 'analyze' | 'inspect', input: Schema, assetSchema: Schema, paritySchema: Schema) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://threeforge.dev/schema/${command}-v${DOCUMENT_SCHEMA_VERSION}.json`,
    title: `threeforge ${command} document v${DOCUMENT_SCHEMA_VERSION}`,
    $defs: { FrameSnapshot: frameSnapshotDef() },
    ...documentBody(command, input, assetSchema, paritySchema),
  };
}

export const ANALYZE_SCHEMA = document('analyze', analyzeInput, asset, nullable(parity));
export const INSPECT_SCHEMA = document('inspect', runInput({ url: string }), { type: 'null' }, { type: 'null' });

const counts = obj({
  nodes: integer,
  meshes: integer,
  primitives: integer,
  materials: integer,
  textures: integer,
  textureBytes: integer,
  accessors: integer,
  vertices: integer,
  triangles: integer,
});
const assetStats = obj({
  nodes: integer,
  meshes: integer,
  primitives: integer,
  materials: integer,
  textures: integer,
  textureBytes: integer,
  accessors: integer,
  vertices: integer,
  triangles: integer,
  bytes: integer,
  animations: integer,
  skins: integer,
  morphTargets: integer,
  extensions: arr(string),
});
const stepName = {
  enum: [
    'dedup',
    'instance',
    'palette',
    'flatten',
    'join',
    'weld',
    'simplify',
    'resample',
    'prune',
    'textures',
    'quantize',
    'meshopt',
  ],
};
/**
 * `overwrite` is optional (outside `required`): `optimize_asset` always sets it, the CLI never does, and a programmatic
 * `optimizeAsset` caller may (`OptimizeInput.overwrite`). Every other input field is always present.
 */
const optionalInput = (schema: Schema, optional: Record<string, Schema>): Schema => ({
  ...schema,
  properties: { ...(schema.properties as Record<string, Schema>), ...optional },
});
const optimizeInput = optionalInput(
  obj({
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
  }),
  {
    overwrite: {
      type: 'boolean',
      description: 'Allow the output to replace existing files (absent from CLI documents, where the CLI replaces).',
    },
  },
);
const optimizeProperties: Record<string, Schema> = {
  schemaVersion: { const: DOCUMENT_SCHEMA_VERSION },
  tool: { const: 'threeforge' },
  version: string,
  command: { const: 'optimize' },
  input: optimizeInput,
  output: obj({ file: string, bytes: integer }),
  stats: obj({ before: assetStats, after: assetStats }),
  steps: arr(
    obj({ name: stepName, applied: boolean, ms: number, note: nullable(string), before: counts, after: counts }),
  ),
  requires: arr(obj({ extension: string, needs: string, code: nullable(string) })),
  verify: nullable(
    obj({
      backend: { enum: ['webgl2', 'webgpu'] },
      parity,
      original: { $ref: '#/$defs/AnalyzeDocument' },
      optimized: { $ref: '#/$defs/AnalyzeDocument' },
      delta: obj({
        bytes: integer,
        materials: integer,
        vertices: integer,
        triangles: integer,
        sceneSubmissions: obj({ naive: integer, compiled: nullable(integer) }),
        loadMs: number,
        memoryBytes: integer,
      }),
    }),
  ),
  verdict,
  timings: obj({ transformMs: number, verifyMs: number, totalMs: number }),
};
/**
 * `threeforge schema optimize`: the document `optimize` prints. `verify.original`/`verify.optimized` are full analyze
 * documents, embedded as `$defs.AnalyzeDocument` (which itself refs the shared `$defs.FrameSnapshot`) rather than by
 * `$id`, so this schema also validates standalone.
 */
export const OPTIMIZE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://threeforge.dev/schema/optimize-v${DOCUMENT_SCHEMA_VERSION}.json`,
  title: `threeforge optimize document v${DOCUMENT_SCHEMA_VERSION}`,
  $defs: {
    FrameSnapshot: frameSnapshotDef(),
    AnalyzeDocument: documentBody('analyze', analyzeInput, asset, nullable(parity)),
  },
  type: 'object',
  properties: optimizeProperties,
  required: Object.keys(optimizeProperties).sort(),
  additionalProperties: false,
};
