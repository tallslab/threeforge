import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures.js';

/** The built CLI, as an agent would run it: `node dist/cli/index.js …` (npx threeforge … after install). */
const bin = 'dist/cli/index.js';
const run = (args: string[]) => spawnSync('node', [bin, ...args], { encoding: 'utf8', timeout: 300_000, env: { ...process.env } });
const asset = (name: string): string => {
  const index = JSON.parse(readFileSync('test/assets/files/index.json', 'utf8')) as Array<{ name: string; entry: string }>;
  return `test/assets/files/${index.find((a) => a.name === name)!.entry}`;
};
const sample = (): string => {
  const index = JSON.parse(readFileSync('test/assets/files/index.json', 'utf8')) as Array<{ name: string; entry: string }>;
  return `test/assets/files/${index.find((a) => a.name === 'Fox')!.entry}`;
};

test.beforeAll(() => {
  if (!existsSync(bin) || !existsSync('dist/cli-app/index.html')) execFileSync('pnpm', ['build'], { stdio: 'inherit' });
});

test('analyze renders a sample asset, compiles it and prints the document', async ({ forge }) => {
  test.setTimeout(600_000);
  const r = run(['analyze', sample(), '--backend', forge.backend, '--frames', '5', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc).toMatchObject({ schemaVersion: 1, tool: 'threeforge', command: 'analyze' });
  expect(doc.env.backend).toBe(forge.backend);
  expect(doc.asset.skinned).toBeGreaterThan(0);
  expect(doc.before.totals.unattributed).toBe(0);
  expect(doc.after.totals.unattributed).toBe(0);
  expect(doc.before.overdraw.measured).toBe(true);
  expect(doc.parity.pass).toBe(true);
  expect(doc.verdict.pass).toBe(true);
  expect(r.stderr).toContain('PASS');
});

test('analyze reports no false unreferenced-resources hint for the Fox (harness environment disposal)', async ({ forge }) => {
  test.setTimeout(600_000);
  const r = run(['analyze', sample(), '--backend', forge.backend, '--frames', '5', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  const codes = doc.hints.map((h: { code: string }) => h.code);
  expect(codes).not.toContain('unreferenced-resources');
  const snapshot = doc.after ?? doc.before;
  const afterCodes = snapshot.hints.map((h: { code: string }) => h.code);
  expect(afterCodes).not.toContain('unreferenced-resources');
  const unreferenced = snapshot.memory.unreferenced.geometries + snapshot.memory.unreferenced.textures;
  expect(unreferenced, JSON.stringify(snapshot.memory.unreferenced)).toBeLessThan(8);
});

test('analyze fails the verdict on a tiny budget (exit 1), usage on a missing file (exit 2), and --no-compile skips the compile', async ({ forge }) => {
  test.setTimeout(600_000);
  // The Fox compiles to exactly one submission, so a budget of 0 is the smallest failing budget.
  const over = run(['analyze', sample(), '--backend', forge.backend, '--frames', '3', '--budget', '0', '--json']);
  expect(over.status).toBe(1);
  expect(JSON.parse(over.stdout).verdict.budget.pass).toBe(false);
  const missing = run(['analyze', 'nope.glb', '--json']);
  expect(missing.status).toBe(2);
  expect(missing.stdout).toBe('');
  const plain = run(['analyze', sample(), '--backend', forge.backend, '--frames', '3', '--no-compile', '--json']);
  expect(plain.status, plain.stderr).toBe(0);
  const doc = JSON.parse(plain.stdout);
  expect(doc.after).toBeNull();
  expect(doc.compile).toBeNull();
  expect(doc.parity).toBeNull();
});

test('inspect drives a page that exposes window.__threeforge', async ({ forge }) => {
  test.setTimeout(600_000);
  const r = run(['inspect', `http://localhost:5179/?scene=village&variant=naive&backend=${forge.backend}`, '--backend', forge.backend, '--frames', '5', '--compile', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.command).toBe('inspect');
  expect(doc.asset).toBeNull();
  expect(doc.before.totals.sceneSubmissions).toBeGreaterThanOrEqual(300);
  expect(doc.after.totals.sceneSubmissions).toBeLessThan(60);
  expect(doc.before.overdraw.measured).toBe(true);
  expect(doc.before.totals.unattributed).toBe(0);
});

test('inspect reports a page without the hook as a page error (exit 4)', () => {
  const r = run(['inspect', 'http://localhost:5179/?scene=nope', '--timeout', '8000', '--json']);
  expect(r.status).toBe(4);
  expect(r.stderr).toMatch(/__threeforge|exposeToAgents|harness failed/);
});

test('explain, schema and help are pure and fast', () => {
  const e = run(['explain', 'untagged', '--json']);
  expect(e.status).toBe(0);
  expect(JSON.parse(e.stdout).fix).toContain('tag.');
  expect(run(['explain', 'nope', '--json']).status).toBe(2);
  const all = run(['explain', '--all', '--json']);
  expect(Object.keys(JSON.parse(all.stdout)).length).toBeGreaterThan(10);
  const s = run(['schema', 'snapshot', '--json']);
  expect(JSON.parse(s.stdout).properties.overdraw).toBeDefined();
  const help = run([]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('threeforge');
  expect(help.stdout).toContain('analyze');
});

test('analyze --bake --views keeps parity on a multi-part static asset and reports what the bake removed', async ({ forge }) => {
  test.setTimeout(600_000);
  const index = JSON.parse(readFileSync('test/assets/files/index.json', 'utf8')) as Array<{ name: string; entry: string }>;
  const engine = index.find((a) => a.name === '2CylinderEngine')!;
  const r = run(['analyze', `test/assets/files/${engine.entry}`, '--backend', forge.backend, '--frames', '3', '--bake', '--views', '3', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.input.bake).toBe('on');
  expect(doc.compile.after.baked).toBeGreaterThan(0);
  expect(doc.compile.bake.groups).toBe(doc.compile.after.baked);
  expect(doc.compile.bake.triangles).toBeLessThanOrEqual(doc.compile.bake.inputTriangles);
  expect(doc.parity.views.map((v: { view: string }) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1', 'orbit-2']);
  expect(doc.parity.pass, JSON.stringify(doc.parity)).toBe(true);
  expect(doc.after.totals.unattributed).toBe(0);
  expect(r.stderr).toContain('bake:');
});

test('optimize keeps the Fox pixel-identical, keeps its skin and clips, and shrinks the file', async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const out = join(dir, 'fox.glb');
    const r = run(['optimize', asset('Fox'), '--out', out, '--backend', forge.backend, '--frames', '5', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schemaVersion: 1, tool: 'threeforge', command: 'optimize', input: { preset: 'safe' } });
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune']);
    expect(statSync(out).size).toBe(doc.output.bytes);
    expect(doc.output.bytes).toBeLessThan(doc.stats.before.bytes * 0.7);
    expect(doc.stats.after.vertices).toBeLessThan(doc.stats.before.vertices);
    expect(doc.stats.after).toMatchObject({ skins: 1, animations: 3 });
    expect(doc.requires).toEqual([]);
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verify.parity.views).toHaveLength(3);
    expect(doc.verify.optimized.asset).toMatchObject({ skinned: doc.verify.original.asset.skinned, animations: doc.verify.original.asset.animations });
    expect(doc.verify.original.before.totals.unattributed).toBe(0);
    expect(doc.verify.optimized.after.totals.unattributed).toBe(0);
    expect(doc.verdict.pass).toBe(true);
    expect(r.stderr).toContain('PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize collapses the Buggy to one material and still compiles to one submission', async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const r = run(['optimize', asset('Buggy'), '--out', join(dir, 'buggy.glb'), '--backend', forge.backend, '--frames', '3', '--views', '1', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.stats.before.materials).toBe(148);
    expect(doc.stats.after.materials).toBe(1);
    expect(doc.stats.after.textures).toBe(1);
    expect(doc.verify.delta.materials).toBeLessThan(0);
    expect(doc.verify.optimized.after.totals.sceneSubmissions).toBeLessThanOrEqual(doc.verify.original.after.totals.sceneSubmissions);
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verdict.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize --preset aggressive --compress meshopt lowers triangles, needs the decoder, and loads through the harness', async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const r = run(['optimize', asset('Fox'), '--out', join(dir, 'fox.glb'), '--preset', 'aggressive', '--compress', 'meshopt', '--parity', '5', '--backend', forge.backend, '--frames', '3', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'weld', 'simplify', 'resample', 'prune', 'textures', 'meshopt']);
    expect(doc.stats.after.triangles).toBeLessThan(doc.stats.before.triangles);
    expect(doc.stats.after.extensions).toContain('EXT_meshopt_compression');
    expect(doc.requires.find((q: { extension: string }) => q.extension === 'EXT_meshopt_compression').code).toContain('setMeshoptDecoder');
    expect(doc.verify.optimized.asset.skinned).toBe(1);
    expect(doc.verify.parity.diffPct).toBeLessThan(5);
    expect(doc.verdict.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize --no-verify runs without a browser, and a missing file is a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const r = run(['optimize', asset('Fox'), '--out', join(dir, 'fox.glb'), '--no-verify', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.verify).toBeNull();
    expect(doc.verdict.pass).toBe(true);
    expect(r.stderr).toContain('not verified');
    expect(run(['optimize', 'nope.glb', '--json']).status).toBe(2);
    expect(run(['optimize', asset('Fox'), '--out', asset('Fox'), '--no-verify']).status).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
