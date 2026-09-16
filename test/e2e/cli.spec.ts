import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ANALYZE_SCHEMA } from '../../src/cli/schema.js';
import { expect, test } from './fixtures.js';

/** The built CLI, as an agent would run it: `node dist/cli/index.js …` (npx threeforge … after install). */
const bin = 'dist/cli/index.js';
const run = (args: string[]) => spawnSync('node', [bin, ...args], { encoding: 'utf8', timeout: 300_000, env: { ...process.env } });
/** Like `run`, but keeps this process's event loop free (a server in the test can answer); SIGKILL after `timeout`. */
const runAsync = (args: string[], timeout: number) =>
  new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((done) => {
    const child = spawn('node', [bin, ...args], { env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status, signal, stdout, stderr });
    });
  });
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

test('analyze renders a sample asset, compiles it and prints the document', { tag: '@corpus' }, async ({ forge }) => {
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

test('analyze reports no false unreferenced-resources hint for the Fox (harness environment disposal)', { tag: '@corpus' }, async ({ forge }) => {
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

test('analyze fails the verdict on a tiny budget (exit 1), usage on a missing file (exit 2), and --no-compile skips the compile', { tag: '@corpus' }, async ({ forge }) => {
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
  expect(doc.before.schemaVersion).toBe(3);
  expect(doc.before.js.ledgerMs).toBeGreaterThanOrEqual(0);
});

test('inspect reports a page without the hook as a page error (exit 4)', () => {
  const r = run(['inspect', 'http://localhost:5179/?scene=nope', '--timeout', '8000', '--json']);
  expect(r.status).toBe(4);
  expect(r.stderr).toMatch(/__threeforge|exposeToAgents|harness failed/);
});

test('analyze exits 3 promptly when Chromium cannot launch', { tag: '@corpus' }, ({ backend }) => {
  const started = Date.now();
  const r = spawnSync('node', [bin, 'analyze', sample(), '--backend', backend, '--json'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/nonexistent' } });
  const ms = Date.now() - started;
  expect(r.status, `${r.stderr}\n(signal ${r.signal} after ${ms} ms)`).toBe(3);
  expect(r.stderr).toContain('environment: could not launch Chromium');
  expect(r.stdout).toBe('');
  // Well under the 5 s exit watchdog: the static server is closed, nothing holds the event loop.
  expect(ms).toBeLessThan(5_000);
});

test('inspect exits 4 when the hook never resolves a frame, bounded by --timeout', async ({ backend }) => {
  test.setTimeout(60_000);
  const hook = `window.__threeforge = { version: 'stuck', schemaVersion: 3, frame: () => ({}), frameAsync: () => new Promise(() => {}), measureMemory: () => ({}), hints: () => [], report: () => '' };`;
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>stuck</title><script>${hook}</script>`));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const r = await runAsync(['inspect', `http://127.0.0.1:${port}/`, '--backend', backend, '--frames', '2', '--timeout', '3000', '--json'], 30_000);
    const ms = Date.now() - started;
    expect(r.status, `${r.stderr}\n(signal ${r.signal} after ${ms} ms)`).toBe(4);
    expect(r.stderr).toMatch(/page: .*timed out after 3000 ms/);
    expect(r.stdout).toBe('');
    expect(ms).toBeLessThan(20_000);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test('inspect exits 4 at once for an app whose hook exposes schemaVersion 2 (threeforge 0.8.0)', async ({ backend }) => {
  test.setTimeout(60_000);
  const hook = `window.__threeforge = { version: '0.8.0', schemaVersion: 2, frame: () => ({}), frameAsync: () => Promise.resolve({}), measureMemory: () => ({}), hints: () => [], report: () => '' };`;
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>v2</title><script>${hook}</script>`));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const r = await runAsync(['inspect', `http://127.0.0.1:${port}/`, '--backend', backend, '--frames', '2', '--timeout', '20000', '--json'], 40_000);
    const ms = Date.now() - started;
    expect(r.status, `${r.stderr}\n(signal ${r.signal} after ${ms} ms)`).toBe(4);
    expect(r.stderr).toMatch(/unsupported schemaVersion 2/);
    expect(r.stderr).not.toMatch(/timed out/);
    expect(r.stdout).toBe('');
    expect(ms).toBeLessThan(15_000);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
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

test('usage errors exit 2 with nothing on stdout, and a boolean flag never swallows the argument after it', { tag: '@corpus' }, () => {
  const typo = run(['explain', 'untagged', '--jsonn']);
  expect(typo.status, typo.stderr).toBe(2);
  expect(typo.stdout).toBe('');
  expect(typo.stderr).toContain('did you mean --json?');
  const tier = run(['inspect', 'http://localhost:5179/', '--tier', 'desktop', '--json']);
  expect(tier.status, tier.stderr).toBe(2);
  expect(tier.stdout).toBe('');
  expect(tier.stderr).toContain('--tier is not a flag of inspect');
  const budget = run(['optimize', asset('Fox'), '--no-verify', '--budget', '10', '--json']);
  expect(budget.status, budget.stderr).toBe(2);
  expect(budget.stdout).toBe('');
  expect(budget.stderr).toContain('--budget needs verification');
  const swallowed = run(['explain', '--json', 'untagged']);
  expect(swallowed.status, swallowed.stderr).toBe(0);
  expect(JSON.parse(swallowed.stdout).code).toBe('untagged');
});

test('analyze --bake --views keeps parity on a multi-part static asset and reports what the bake removed', { tag: '@corpus' }, async ({ forge }) => {
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

test('analyze --bake --json output validates against ANALYZE_SCHEMA, compiled standalone in ajv (Task 29: self-contained $defs)', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const index = JSON.parse(readFileSync('test/assets/files/index.json', 'utf8')) as Array<{ name: string; entry: string }>;
  const engine = index.find((a) => a.name === '2CylinderEngine')!;
  const r = run(['analyze', `test/assets/files/${engine.entry}`, '--backend', forge.backend, '--frames', '3', '--bake', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const doc = JSON.parse(r.stdout);
  expect(doc.input.bake).toBe('on');
  // A fresh Ajv2020 instance, given only the one schema `threeforge schema analyze` prints: no addSchema of the
  // snapshot schema, proving the embedded $defs (not an external $ref) are what resolve `before`/`after`.
  const validate = new Ajv2020({ strict: true }).compile(ANALYZE_SCHEMA);
  expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
});

test('optimize keeps the Fox pixel-identical at --parity 0, keeps its skin and clips, and shrinks the file', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const out = join(dir, 'fox.glb');
    // --parity 0, and every view asserted at exactly 0: `safe` is documented as never changing a pixel (CONTRIBUTING.md
    // rule 7), so the 0.5 % default this test used to accept proved nothing about that claim. The document is on
    // stdout even when the verdict fails, so it is parsed before the verdict is judged.
    const r = run(['optimize', asset('Fox'), '--out', out, '--parity', '0', '--backend', forge.backend, '--frames', '5', '--json']);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schemaVersion: 1, tool: 'threeforge', command: 'optimize', input: { preset: 'safe', parity: 0 } });
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune']);
    expect(statSync(out).size).toBe(doc.output.bytes);
    expect(doc.output.bytes).toBeLessThan(doc.stats.before.bytes * 0.7);
    expect(doc.stats.after.vertices).toBeLessThan(doc.stats.before.vertices);
    expect(doc.stats.after).toMatchObject({ skins: 1, animations: 3 });
    expect(doc.requires).toEqual([]);
    expect(doc.verify.optimized.asset).toMatchObject({ skinned: doc.verify.original.asset.skinned, animations: doc.verify.original.asset.animations });
    expect(doc.verify.original.before.totals.unattributed).toBe(0);
    expect(doc.verify.optimized.after.totals.unattributed).toBe(0);
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1']);
    expect(doc.verify.parity.threshold).toBe(0);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] safe Fox: ${views.map((v) => `${v.view} ${v.diffPct} %`).join(', ')}` });
    // FINDING (Task 42, see .superpowers/sdd/make-a-plan-to-dreamy-breeze/task-42-report.md): on webgpu the safe
    // preset is NOT pixel-identical on the Fox. Measured, identically on three runs: default 0.007 %, orbit-0
    // 0.011 %, orbit-1 0.014 % (65/97/123 pixels of 1280x720); webgl2 is exactly 0 in every view. Bisected to the
    // `weld` step alone (0 through dedup and palette, 0.013 as soon as weld runs; resample adds 0.001 on orbit-1).
    // weld is lossless here — the drawn triangle stream is value- and order-identical, only the layout changes from
    // 1728 non-indexed vertices to 434 indexed ones — and the Fox has no NORMAL attribute, so GLTFLoader gives it a
    // flat-shaded material (GLTFLoader.js:3500, :3559) whose normal comes from screen-space derivatives; every
    // differing pixel is interior (0 of 285 touch the background), so this is shading at interior triangle edges,
    // not a moved silhouette. Marked fixme rather than given a tolerance: the fix (change the step, or correct the
    // pixel-identical claim in the docs to the measured figure) is the controller's call, not this test's.
    test.fixme(forge.backend === 'webgpu', 'safe moves 0.007-0.014 % of pixels on the Fox on webgpu (weld); awaiting the step-or-docs decision');
    for (const v of views) expect(v.diffPct, `${v.view}: --preset safe changed pixels`).toBe(0);
    expect(doc.verify.parity.pass).toBe(true);
    expect(r.status, r.stderr).toBe(0);
    expect(doc.verdict.pass).toBe(true);
    expect(r.stderr).toContain('PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize collapses the Buggy to one material and still compiles to one submission', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    // --parity 0: the same pixel-identical claim as the Fox above, on the asset whose 148 materials the palette step
    // collapses to one. Every view must be exactly 0, not merely inside the 0.5 % default.
    const r = run(['optimize', asset('Buggy'), '--out', join(dir, 'buggy.glb'), '--parity', '0', '--backend', forge.backend, '--frames', '3', '--views', '1', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.stats.before.materials).toBe(148);
    expect(doc.stats.after.materials).toBe(1);
    expect(doc.stats.after.textures).toBe(1);
    expect(doc.verify.delta.materials).toBeLessThan(0);
    expect(doc.verify.optimized.after.totals.sceneSubmissions).toBeLessThanOrEqual(doc.verify.original.after.totals.sceneSubmissions);
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0']);
    expect(doc.verify.parity.threshold).toBe(0);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] safe Buggy: ${views.map((v) => `${v.view} ${v.diffPct} %`).join(', ')}` });
    for (const v of views) expect(v.diffPct, `${v.view}: --preset safe changed pixels`).toBe(0);
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verdict.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The tolerance is measured, not guessed. `optimize --preset balanced --parity 100` on the Fox, twice per backend,
 * reported exactly the same figures both times: webgl2 default 0.008 %, orbit-0 0.005 %, orbit-1 0.002 %; webgpu
 * default 0.014 %, orbit-0 0.014 %, orbit-1 0.015 %. So the worst view measured is 0.015 % and 0.05 % leaves ~3.3x
 * headroom. It covers three lossy sources together: `quantize` (positions, UVs and weights to integers),
 * `textures` (the base colour map re-encoded as WebP at quality 85), and — on webgpu only — the 0.014 % the safe
 * steps already move there (see the Fox safe test above). It is deliberately far below the CLI's own 0.5 % default:
 * balanced is lossy, but only just, and a step that starts moving a tenth of a percent should fail this.
 */
const BALANCED_PARITY = 0.05;

test('optimize --preset balanced quantizes and re-encodes the Fox, changing pixels but staying inside a measured 0.05 %', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const out = join(dir, 'fox.glb');
    const r = run(['optimize', asset('Fox'), '--out', out, '--preset', 'balanced', '--parity', String(BALANCED_PARITY), '--backend', forge.backend, '--frames', '5', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'weld', 'resample', 'prune', 'textures', 'quantize']);
    // Both lossy steps really ran: the preset is not quietly degrading to safe because sharp is missing.
    expect(doc.steps.find((s: { name: string }) => s.name === 'textures')).toMatchObject({ applied: true, note: null });
    expect(doc.stats.after.extensions).toEqual(['EXT_texture_webp', 'KHR_mesh_quantization']);
    expect(doc.requires.map((q: { extension: string; code: string | null }) => [q.extension, q.code])).toEqual([
      ['EXT_texture_webp', null],
      ['KHR_mesh_quantization', null],
    ]);
    expect(doc.stats.after).toMatchObject({ skins: 1, animations: 3, triangles: doc.stats.before.triangles });
    expect(doc.verify.optimized.asset).toMatchObject({ skinned: 1, animations: 3 });
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1']);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] balanced Fox: ${views.map((v) => `${v.view} ${v.diffPct} %`).join(', ')} (tolerance ${BALANCED_PARITY} %)` });
    for (const v of views) expect(v.diffPct, `${v.view}: --preset balanced moved more pixels than the measured tolerance`).toBeLessThanOrEqual(BALANCED_PARITY);
    // Balanced is lossy where safe is not: on webgl2 safe measures exactly 0 and this measures 0.008 %. A run that
    // reported 0 here would mean quantize and the WebP re-encode had stopped doing anything.
    expect(doc.verify.parity.diffPct, 'balanced changed no pixel at all: did the lossy steps run?').toBeGreaterThan(0);
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verdict.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize --preset aggressive --compress meshopt lowers triangles, needs the decoder, and loads through the harness', { tag: '@corpus' }, async ({ forge }) => {
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

test('optimize --no-verify runs without a browser; a missing file, an out-of-directory resource URI and a non-glTF --out are usage errors', { tag: '@corpus' }, () => {
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
    // glTF-Transform would embed whatever an image URI reaches; the CLI refuses it before reading (exit 2, nothing on stdout).
    const hostile = join(dir, 'hostile.gltf');
    writeFileSync(hostile, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../../../../etc/passwd' }] }));
    const refused = run(['optimize', hostile, '--no-verify', '--json']);
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/images\[0\]\.uri .*outside/);
    expect(existsSync(join(dir, 'hostile.forge.glb'))).toBe(false);
    expect(run(['optimize', asset('Fox'), '--out', join(dir, 'fox.txt'), '--no-verify']).status).toBe(2);
    expect(existsSync(join(dir, 'fox.txt'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
