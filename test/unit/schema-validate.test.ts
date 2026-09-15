import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { emptyFrame, type FrameEnv, type FrameSnapshot } from '../../src/ledger/snapshot.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from '../../src/cli/schema.js';
import type { AgentDocument, AnalyzeInput, AssetStats, Counts, InspectInput, OptimizeDocument, OptimizeInput } from '../../src/cli/types.js';
import { verdictOf } from '../../src/cli/verdict.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

/**
 * `threeforge schema` embeds every `$ref` as `$defs` (Task 29): each of the four exported schemas must compile and
 * validate on its own, in a fresh ajv instance, with no `addSchema` of any other — exactly what an agent gets from
 * `threeforge schema <name>` alone (or from a bundled copy of just that one file).
 */
function compile(schema: object): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  return ajv.compile(schema);
}

const env: FrameEnv = { three: '186', backend: 'webgl2', multiDraw: true, tier: 'desktop', gpu: 'test', dpr: 1, viewport: [800, 600] };

/** A real snapshot from the ledger and a FakeRenderer, not a hand-built object. */
function realFrame(): FrameSnapshot {
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  const renderer = new FakeRenderer();
  ledger.attach(renderer as never);
  const { scene, camera } = sceneWithCamera();
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  renderer.render(scene, camera);
  ledger.measureMemory();
  return ledger.frame({ items: true });
}

function analyzeFixture(): AgentDocument {
  const before = realFrame();
  const after = emptyFrame(env);
  after.totals.sceneSubmissions = 4;
  const input: AnalyzeInput = { file: 'fixture.glb', backend: 'webgl2', tier: 'auto', budget: 100, frames: 5, compile: true, bake: 'on', views: 1, timeout: 60_000, headed: false };
  return {
    schemaVersion: 1,
    tool: 'threeforge',
    version: '0.9.0',
    command: 'analyze',
    input,
    env,
    asset: { meshes: 2, materials: 1, vertices: 48, triangles: 24, animations: 0, skinned: 0, morph: 0, loadMs: 8 },
    before,
    after,
    compile: null,
    parity: { diffPct: 0.02, threshold: 0.5, pass: true, views: [{ view: 'default', diffPct: 0.02 }] },
    hints: after.hints,
    verdict: verdictOf(after, before, 100, null),
    timings: { totalMs: 120 },
  };
}

function inspectFixture(): AgentDocument {
  const before = realFrame();
  const input: InspectInput = { url: 'http://127.0.0.1:5173/', backend: 'webgl2', tier: 'auto', budget: null, frames: 3, compile: false, timeout: 20_000, headed: false };
  return {
    schemaVersion: 1,
    tool: 'threeforge',
    version: '0.9.0',
    command: 'inspect',
    input,
    env,
    asset: null,
    before,
    after: null,
    compile: null,
    parity: null,
    hints: before.hints,
    verdict: verdictOf(null, before, null, null),
    timings: { totalMs: 40 },
  };
}

function optimizeFixture(): OptimizeDocument {
  const counts: Counts = { nodes: 4, meshes: 2, primitives: 2, materials: 1, textures: 0, textureBytes: 0, accessors: 6, vertices: 48, triangles: 24 };
  const assetStats: AssetStats = { ...counts, bytes: 2048, animations: 0, skins: 0, morphTargets: 0, extensions: [] };
  const input: OptimizeInput = { file: 'fixture.glb', out: null, preset: 'safe', steps: {}, simplify: null, simplifyError: 0.01, compress: 'none', textures: null, textureSize: null, textureQuality: 0.8, verify: true, parity: 0.5, views: 1, backend: 'webgl2', tier: 'auto', budget: null, frames: 5, compile: true, timeout: 60_000, headed: false };
  const original = analyzeFixture();
  const optimized = analyzeFixture();
  return {
    schemaVersion: 1,
    tool: 'threeforge',
    version: '0.9.0',
    command: 'optimize',
    input,
    output: { file: 'fixture.forge.glb', bytes: 1024 },
    stats: { before: assetStats, after: assetStats },
    steps: [{ name: 'dedup', applied: true, ms: 3, note: null, before: counts, after: counts }],
    requires: [],
    verify: {
      backend: 'webgl2',
      parity: { diffPct: 0.01, threshold: 0.5, pass: true, views: [{ view: 'default', diffPct: 0.01 }] },
      original,
      optimized,
      delta: { bytes: -1024, materials: 0, vertices: 0, triangles: 0, sceneSubmissions: { naive: 4, compiled: 4 }, loadMs: 0, memoryBytes: 0 },
    },
    verdict: verdictOf(optimized.after, optimized.before, null, null),
    timings: { transformMs: 10, verifyMs: 20, totalMs: 30 },
  };
}

describe('schema-validate: every exported schema is self-contained', () => {
  it('SNAPSHOT_SCHEMA has no $ref at all (nothing external to embed)', () => {
    expect(JSON.stringify(SNAPSHOT_SCHEMA)).not.toContain('$ref');
  });

  it('ANALYZE_SCHEMA, INSPECT_SCHEMA and OPTIMIZE_SCHEMA embed $defs.FrameSnapshot instead of $ref-ing SNAPSHOT_SCHEMA.$id', () => {
    for (const schema of [ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA]) {
      expect(JSON.stringify(schema)).not.toContain(SNAPSHOT_SCHEMA.$id);
      expect((schema as { $defs?: { FrameSnapshot?: unknown } }).$defs?.FrameSnapshot).toBeDefined();
    }
  });

  it('OPTIMIZE_SCHEMA embeds $defs.AnalyzeDocument instead of $ref-ing ANALYZE_SCHEMA.$id', () => {
    expect(JSON.stringify(OPTIMIZE_SCHEMA)).not.toContain(ANALYZE_SCHEMA.$id);
    expect((OPTIMIZE_SCHEMA as { $defs: { AnalyzeDocument?: unknown } }).$defs.AnalyzeDocument).toBeDefined();
  });
});

describe('schema-validate: every exported schema compiles standalone in ajv and validates real documents', () => {
  it('SNAPSHOT_SCHEMA compiles alone and validates an empty frame', () => {
    const validate = compile(SNAPSHOT_SCHEMA);
    expect(validate(emptyFrame(env)), JSON.stringify(validate.errors)).toBe(true);
  });

  it('SNAPSHOT_SCHEMA compiles alone and validates a real FakeRenderer frame, items included', () => {
    const validate = compile(SNAPSHOT_SCHEMA);
    const frame = realFrame();
    expect(frame.items && frame.items.length > 0, 'the fixture must actually draw something').toBe(true);
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it('ANALYZE_SCHEMA compiles alone (its embedded FrameSnapshot resolves with no addSchema) and validates a fixture analyze document', () => {
    const validate = compile(ANALYZE_SCHEMA);
    const doc = analyzeFixture();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it('INSPECT_SCHEMA compiles alone and validates a fixture inspect document', () => {
    const validate = compile(INSPECT_SCHEMA);
    const doc = inspectFixture();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it('OPTIMIZE_SCHEMA compiles alone (its nested AnalyzeDocument and FrameSnapshot resolve with no addSchema) and validates a fixture optimize document', () => {
    const validate = compile(OPTIMIZE_SCHEMA);
    const doc = optimizeFixture();
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a document whose frame snapshot carries the wrong schemaVersion, proving the embedded $defs are actually checked', () => {
    const validate = compile(ANALYZE_SCHEMA);
    const doc = analyzeFixture() as unknown as { before: { schemaVersion: number } };
    doc.before.schemaVersion = 2;
    expect(validate(doc)).toBe(false);
  });
});
