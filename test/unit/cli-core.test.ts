import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../../src/cli/args.js';
import { explain, REMEDIES } from '../../src/cli/explain.js';
import { summarize, summarizeOptimize } from '../../src/cli/format.js';
import { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from '../../src/cli/schema.js';
import type { AgentDocument, AnalyzeInput, OptimizeDocument, OptimizeInput } from '../../src/cli/types.js';
import { exitCodeOf, verdictOf } from '../../src/cli/verdict.js';
import { budgetsFor } from '../../src/ledger/budgets.js';
import { hintsFor } from '../../src/ledger/hints.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';

const env = { three: '186', backend: 'webgl2' as const, multiDraw: true, tier: 'phone-low' as const, gpu: 'x', dpr: 1, viewport: [800, 600] as [number, number] };

describe('parseArgs', () => {
  it('parses analyze with defaults and flags', () => {
    expect(parseArgs(['analyze', 'a.glb'])).toEqual({ name: 'analyze', json: false, input: { file: 'a.glb', backend: 'webgl2', tier: 'auto', budget: null, frames: 30, compile: true, bake: 'off', views: 0, timeout: 60000, headed: false } });
    expect(parseArgs(['analyze', 'a.glb', '--bake', '--views', '4'])).toMatchObject({ input: { bake: 'on', views: 4 } });
    expect(parseArgs(['analyze', 'a.glb', '--bake-buried'])).toMatchObject({ input: { bake: 'buried' } });
    expect(parseArgs(['analyze', 'a.glb', '--backend', 'webgpu', '--tier', 'phone-mid', '--budget', '150', '--frames', '10', '--no-compile', '--json', '--timeout', '5000', '--headed'])).toMatchObject({
      json: true,
      input: { backend: 'webgpu', tier: 'phone-mid', budget: 150, frames: 10, compile: false, timeout: 5000, headed: true },
    });
  });

  it('parses inspect, explain, schema, mcp and help', () => {
    expect(parseArgs(['inspect', 'http://localhost:5173', '--compile'])).toMatchObject({ name: 'inspect', input: { url: 'http://localhost:5173', compile: true, frames: 30 } });
    expect(parseArgs(['explain', 'untagged', '--json'])).toEqual({ name: 'explain', code: 'untagged', all: false, json: true });
    expect(parseArgs(['explain', '--all'])).toEqual({ name: 'explain', code: null, all: true, json: false });
    expect(parseArgs(['schema'])).toEqual({ name: 'schema', which: 'all', json: false });
    expect(parseArgs(['schema', 'snapshot', '--json'])).toEqual({ name: 'schema', which: 'snapshot', json: true });
    expect(parseArgs(['mcp'])).toEqual({ name: 'mcp' });
    expect(parseArgs([])).toEqual({ name: 'help' });
    expect(parseArgs(['--help'])).toEqual({ name: 'help' });
  });

  it('rejects bad input with a UsageError', () => {
    expect(() => parseArgs(['analyze'])).toThrow(UsageError);
    expect(() => parseArgs(['analyze', 'a.glb', '--backend', 'metal'])).toThrow(/backend/);
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
    expect(() => parseArgs(['analyze', 'a.glb', '--frames', 'x'])).toThrow(/frames/);
    expect(() => parseArgs(['schema', 'nope'])).toThrow(/schema/);
  });
});

describe('verdict', () => {
  it('passes a clean frame and fails on budget, error hints or parity', () => {
    const clean = emptyFrame(env);
    expect(verdictOf(clean, clean, null, null)).toEqual({ pass: true, budget: null, errors: [], reasons: [] });
    const over = emptyFrame(env);
    over.totals.sceneSubmissions = 200;
    const v = verdictOf(over, over, 100, { diffPct: 0.1, threshold: 0.5, pass: true, views: [] });
    expect(v.pass).toBe(false);
    expect(v.budget).toEqual({ maxSubmissions: 100, actual: 200, pass: false });
    expect(exitCodeOf(v)).toBe(1);
    const bad = emptyFrame(env);
    bad.hints = [{ category: 'drawCalls', severity: 'error', code: 'unsupported-material', message: 'x', objects: [] }];
    expect(verdictOf(bad, bad, null, null).errors).toEqual(['unsupported-material']);
    expect(verdictOf(clean, clean, null, { diffPct: 2, threshold: 0.5, pass: false, views: [] }).reasons).toContain('pixel parity 2.00% > 0.5%');
    expect(exitCodeOf(verdictOf(clean, clean, null, null))).toBe(0);
  });
});

describe('explain', () => {
  it('has a remedy for every hint code hintsFor can emit, and nothing else', () => {
    const f = emptyFrame(env);
    f.totals.sceneSubmissions = 1e9;
    f.totals.triangles = 1e9;
    f.totals.programs = 1e9;
    f.byReason = { untagged: { submissions: 1, gpuDraws: 1, top: [] }, 'unique-material': { submissions: 99, gpuDraws: 99, top: [] }, 'unsupported-material': { submissions: 1, gpuDraws: 1, top: [] } };
    f.overdraw = { opaque: 9, transparent: 9, transparentSubmissions: 1, measured: true };
    f.skinning.vertices = 1e9;
    f.lighting.shadowTexels = 1e9;
    f.memory.textures.bytes = 1e12;
    const codes = hintsFor(f, budgetsFor('phone-low'), { staticAutoUpdated: ['a'], pointShadowLights: ['l'], transmissive: ['g'] }).map((h) => h.code);
    for (const code of codes) expect(explain(code), code).not.toBeNull();
    expect(explain('nope')).toBeNull();
    expect(Object.keys(REMEDIES).sort()).toEqual([...new Set(codes)].sort());
    for (const r of Object.values(REMEDIES)) expect(r.fix.length).toBeGreaterThan(20);
  });
});

describe('schema', () => {
  it('declares every snapshot key and every document key', () => {
    const keys = Object.keys(emptyFrame(env)).sort();
    expect(SNAPSHOT_SCHEMA.required).toEqual(keys);
    for (const key of keys) expect(SNAPSHOT_SCHEMA.properties[key], key).toBeDefined();
    const docKeys = ['schemaVersion', 'tool', 'version', 'command', 'input', 'env', 'asset', 'before', 'after', 'compile', 'parity', 'hints', 'verdict', 'timings'];
    for (const s of [ANALYZE_SCHEMA, INSPECT_SCHEMA]) expect(Object.keys(s.properties)).toEqual(docKeys);
    expect(SNAPSHOT_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });
});

describe('summarize', () => {
  it('prints the verdict, the submissions before and after, the six cost rows and hints', () => {
    const before = emptyFrame(env);
    before.totals.sceneSubmissions = 500;
    const after = emptyFrame(env);
    after.totals.sceneSubmissions = 30;
    after.hints = [{ category: 'lighting', severity: 'warn', code: 'shadow-texels', message: 'too many', objects: [] }];
    const input: AnalyzeInput = { file: 'a.glb', backend: 'webgl2', tier: 'auto', budget: 100, frames: 30, compile: true, bake: 'off', views: 0, timeout: 60000, headed: false };
    const doc: AgentDocument = { schemaVersion: 1, tool: 'threeforge', version: '0.2.0', command: 'analyze', input, env, asset: null, before, after, compile: null, parity: { diffPct: 0.01, threshold: 0.5, pass: true, views: [{ view: 'default', diffPct: 0.01 }] }, hints: after.hints, verdict: verdictOf(after, before, 100, null), timings: { totalMs: 10 } };
    const text = summarize(doc);
    expect(text).toContain('PASS');
    expect(text).toContain('500 → 30 submissions');
    expect(text).toContain('draw calls');
    expect(text).toContain('! shadow-texels');
    expect(text).toContain('parity 0.01%');
  });
});

describe('parseArgs optimize', () => {
  it('parses defaults, presets, step toggles and the lossy flags', () => {
    expect(parseArgs(['optimize', 'a.glb'])).toEqual({ name: 'optimize', json: false, input: { file: 'a.glb', out: null, preset: 'safe', steps: {}, simplify: null, simplifyError: 0.001, compress: 'none', textures: null, textureSize: null, textureQuality: 85, verify: true, parity: 0.5, views: 2, backend: 'webgl2', tier: 'auto', budget: null, frames: 30, compile: true, timeout: 60000, headed: false } });
    expect(parseArgs(['optimize', 'a.glb', '--out', 'b.glb', '--preset', 'aggressive', '--no-palette', '--quantize', '--join', '--json'])).toMatchObject({ json: true, input: { out: 'b.glb', preset: 'aggressive', steps: { palette: false, quantize: true, join: true } } });
    expect(parseArgs(['optimize', 'a.glb', '--simplify', '0.3', '--simplify-error', '0.01', '--compress', 'meshopt', '--textures', 'avif', '--texture-size', '512', '--texture-quality', '70'])).toMatchObject({ input: { simplify: 0.3, simplifyError: 0.01, compress: 'meshopt', textures: 'avif', textureSize: 512, textureQuality: 70 } });
    expect(parseArgs(['optimize', 'a.glb', '--simplify', '--textures'])).toMatchObject({ input: { simplify: 0.5, textures: 'webp' } });
    expect(parseArgs(['optimize', 'a.glb', '--no-simplify', '--textures', 'none'])).toMatchObject({ input: { steps: { simplify: false }, textures: 'none' } });
    expect(parseArgs(['optimize', 'a.glb', '--no-verify', '--parity', '2', '--views', '0', '--budget', '10', '--frames', '5', '--no-compile'])).toMatchObject({ input: { verify: false, parity: 2, views: 0, budget: 10, frames: 5, compile: false } });
  });

  it('rejects bad optimize input', () => {
    expect(() => parseArgs(['optimize'])).toThrow(UsageError);
    expect(() => parseArgs(['optimize', 'a.glb', '--preset', 'max'])).toThrow(/preset/);
    expect(() => parseArgs(['optimize', 'a.glb', '--simplify', '1.5'])).toThrow(/simplify/);
    expect(() => parseArgs(['optimize', 'a.glb', '--simplify', '0'])).toThrow(/simplify/);
    expect(() => parseArgs(['optimize', 'a.glb', '--compress', 'draco'])).toThrow(/compress/);
    expect(() => parseArgs(['optimize', 'a.glb', '--textures', 'jpg'])).toThrow(/textures/);
    expect(() => parseArgs(['optimize', 'a.glb', '--out'])).toThrow(/out/);
    expect(parseArgs(['schema', 'optimize'])).toEqual({ name: 'schema', which: 'optimize', json: false });
  });
});

describe('optimize schema and summary', () => {
  const counts = { nodes: 1, meshes: 1, primitives: 1, materials: 1, textures: 0, accessors: 2, vertices: 4, triangles: 2 };
  const stats = { ...counts, bytes: 100, textureBytes: 0, animations: 0, skins: 0, morphTargets: 0, extensions: [] as string[] };
  const parsed = parseArgs(['optimize', 'a.glb', '--compress', 'meshopt']);
  const input: OptimizeInput = parsed.name === 'optimize' ? parsed.input : (undefined as never);
  const doc: OptimizeDocument = {
    schemaVersion: 1,
    tool: 'threeforge',
    version: '0.3.0',
    command: 'optimize',
    input,
    output: { file: 'a.forge.glb', bytes: 60 },
    stats: { before: { ...stats, materials: 6 }, after: { ...stats, bytes: 60, extensions: ['EXT_meshopt_compression'] } },
    steps: [
      { name: 'dedup', applied: true, ms: 1, note: null, before: { ...counts, materials: 6 }, after: counts },
      { name: 'textures', applied: false, ms: 0, note: 'skipped: texture compression needs sharp (npm i -D sharp)', before: counts, after: counts },
    ],
    requires: [{ extension: 'EXT_meshopt_compression', needs: 'MeshoptDecoder', code: 'loader.setMeshoptDecoder(MeshoptDecoder);' }],
    verify: null,
    verdict: { pass: true, budget: null, errors: [], reasons: [] },
    timings: { transformMs: 3, verifyMs: 0, totalMs: 4 },
  };

  it('declares every document key', () => {
    const props = OPTIMIZE_SCHEMA.properties as Record<string, unknown>;
    for (const key of Object.keys(doc)) expect(props[key], key).toBeDefined();
    expect(OPTIMIZE_SCHEMA.required).toEqual(Object.keys(props).sort());
  });

  it('summarises the verdict, the deltas, each step, the requirements and skipped notes', () => {
    const text = summarizeOptimize(doc);
    expect(text).toContain('PASS');
    expect(text).toContain('100 B → 60 B');
    expect(text).toContain('materials 6 → 1');
    expect(text).toContain('dedup: materials 6 → 1');
    expect(text).toContain('textures: skipped');
    expect(text).toContain('setMeshoptDecoder');
    expect(text).toContain('not verified');
  });
});
