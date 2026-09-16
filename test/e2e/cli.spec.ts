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
  expect(doc).toMatchObject({ schemaVersion: 2, tool: 'threeforge', command: 'analyze' });
  expect(doc.env.backend).toBe(forge.backend);
  expect(doc.asset.skinned).toBeGreaterThan(0);
  expect(doc.before.totals.unattributed).toBe(0);
  expect(doc.after.totals.unattributed).toBe(0);
  expect(doc.before.overdraw.measured).toBe(true);
  expect(doc.parity.pass).toBe(true);
  // R149: the default stays 0.5, and the document records it.
  expect(doc.input.parity).toBe(0.5);
  expect(doc.parity.threshold).toBe(0.5);
  expect(doc.verdict.pass).toBe(true);
  expect(r.stderr).toContain('PASS');
});

test('analyze --parity 0 judges compile parity on the raw changed-pixel count, from the built binary (R149)', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const r = run(['analyze', sample(), '--backend', forge.backend, '--frames', '3', '--views', '1', '--parity', '0', '--json']);
  const doc = JSON.parse(r.stdout);
  expect(doc.input.parity).toBe(0);
  const views = doc.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
  expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0']);
  const identical = views.every((v) => v.changedPixels === 0);
  test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] Fox analyze --parity 0: exit ${r.status}, ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')}` });
  // Whatever the compile did to this asset, the verdict is exactly "no pixel moved", and the exit code follows it.
  expect(doc.parity).toMatchObject({ threshold: 0, pass: identical });
  expect(doc.verdict.pass).toBe(identical);
  expect(r.status, r.stderr).toBe(identical ? 0 : 1);
  const bad = run(['analyze', sample(), '--parity', '101']);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--parity must be a number from 0 to 100');
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
  test.info().annotations.push({ type: 'memory', description: `[${forge.backend}] Fox analyze unreferenced: before ${JSON.stringify(doc.before.memory.unreferenced)}, after ${JSON.stringify(doc.after?.memory.unreferenced)}` });
  // The measured residual, exactly, not the hint's own threshold (8), which the hint assertions above already cover: a
  // regression that stopped disposing RoomEnvironment alone (one geometry) would stay under it. Measured on both backends
  // before and after compiling: 0 and 0 (it was 0 geometries and 1 texture before three's own render targets were allowed).
  expect(doc.before.memory.unreferenced).toEqual({ geometries: 0, textures: 0 });
  expect(snapshot.memory.unreferenced).toEqual({ geometries: 0, textures: 0 });
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

test('optimize changes zero pixels of the Fox at --parity 0 in every view, skin and clips kept', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const out = join(dir, 'fox.glb');
    // --parity 0, and every view asserted at zero *changed pixels* on both backends: `safe` is held to zero changed
    // pixels at --parity 0 on the Fox and the Buggy (CONTRIBUTING.md rule 7), and neither the 0.5 % default this test began with nor the rounded
    // `diffPct` that replaced it could prove that — `diffPct` is rounded to three decimals, which at 1280x720
    // absorbs up to 4 changed pixels of 921,600. `changedPixels` (Ruling R104) is the exact count, so these rows
    // are the first form of this assertion that actually tests rule 7.
    const r = run(['optimize', asset('Fox'), '--out', out, '--parity', '0', '--backend', forge.backend, '--frames', '5', '--json']);
    // Status first. This became a real parity gate only in fix round 3 (Ruling R108): until then the CLI compared
    // the rounded percentage, so `--parity 0` exited 0 while 1-4 pixels moved, and the round-2 comment here — and
    // that commit's message — claimed a gate the tool did not yet have. `parityOf` now judges a threshold of 0 on
    // the raw counts, so exit 0 does mean no pixel moved; the per-view assertions below no longer stand alone.
    // Passing stderr as the message also keeps a crashed CLI from surfacing as "Unexpected end of JSON input".
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schemaVersion: 2, tool: 'threeforge', command: 'optimize', input: { preset: 'safe', parity: 0 } });
    // R100 moved `weld` to `balanced` (it moved pixels) and R105 moved `resample` after it (it grew files), so `safe`
    // is these three steps. `--weld` / `--resample` add them back (pinned in pipeline.test.ts).
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'prune']);
    expect(statSync(out).size).toBe(doc.output.bytes);
    // A two-sided band around the measured figure, not a one-sided bound that anything from a total shrink to a
    // 5 % growth would satisfy. Measured: 162,852 -> 164,252 bytes, +0.86 %. None of safe's three steps costs bytes
    // on this asset (the Fox has one material, so `palette` does nothing here); the growth is glTF-Transform
    // rewriting the container, which lands the Fox at exactly the same 164,252 with no steps at all. Assets that
    // are not tiny and animation-heavy go the other way -- the Buggy is -27.4 % below.
    const sizeRatio = doc.output.bytes / doc.stats.before.bytes;
    expect(sizeRatio, `safe took the Fox to ${doc.output.bytes} bytes (${(sizeRatio * 100).toFixed(2)} % of the input)`).toBeGreaterThan(0.98);
    expect(sizeRatio, `safe took the Fox to ${doc.output.bytes} bytes (${(sizeRatio * 100).toFixed(2)} % of the input)`).toBeLessThan(1.02);
    expect(doc.stats.after.vertices).toBe(doc.stats.before.vertices);
    expect(doc.stats.after).toMatchObject({ skins: 1, animations: 3 });
    expect(doc.requires).toEqual([]);
    expect(doc.verify.optimized.asset).toMatchObject({ skinned: doc.verify.original.asset.skinned, animations: doc.verify.original.asset.animations });
    expect(doc.verify.original.before.totals.unattributed).toBe(0);
    expect(doc.verify.optimized.after.totals.unattributed).toBe(0);
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1']);
    expect(doc.verify.parity.threshold).toBe(0);
    // R156: `--parity` is the original-versus-optimized threshold and does not reach each file's *own* compile check,
    // which stays at the analyze default. The Buggy case below is where that separation is pinned and argued; here it
    // is enough that the two thresholds are the two different numbers this run asked for.
    expect(doc.verify.original.input.parity).toBe(0.5);
    expect(doc.verify.optimized.input.parity).toBe(0.5);
    expect(doc.verify.optimized.parity.pass, JSON.stringify(doc.verify.optimized.parity)).toBe(true);
    expect(doc.verify.original.parity.pass, JSON.stringify(doc.verify.original.parity)).toBe(true);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] safe Fox: ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')}` });
    // Two defects had to be fixed before this could assert zero, and both were found by measuring rather than by
    // reading: `weld` moved to `balanced` (Ruling R100) because it moves pixels on WebGPU on some assets even
    // though it changes no drawn value, and `resample` now runs at tolerance 0 (Ruling R104) because
    // glTF-Transform's default is 1e-4, not 0, which dropped keyframes near the interpolated value and shifted the
    // pose the harness fixes at `mixer.setTime(0.7)` — 1-3 pixels of 921,600 on webgl2 and 3-5 on webgpu, small
    // enough that the rounded percent read 0.000 on webgl2 and hid it. Asserting the raw count on both backends is
    // what keeps either from coming back silently.
    for (const v of views) {
      expect(v.changedPixels, `${v.view}: --preset safe changed pixels`).toBe(0);
      expect(v.diffPct, `${v.view}: --preset safe changed pixels`).toBe(0);
    }
    expect(doc.verify.parity.pass).toBe(true);
    expect(r.status, r.stderr).toBe(0);
    expect(doc.verdict.pass).toBe(true);
    expect(r.stderr).toContain('PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Ruling R112: `--resample` under `safe` is the one lossless path with no end-to-end cover.
 *
 * R105 moved `resample` out of `safe`, and `--resample` adds it back — where it runs at `tolerance: 0` (R104),
 * because glTF-Transform's default is a lossy `1e-4` that drops keyframes merely *near* the value interpolated from
 * their neighbours. That tolerance is the entire difference between lossless and not, and until now it was pinned
 * only in `test/unit/pipeline.test.ts`, which tests `planSteps` — a pure function that decides the number. Nothing
 * checked that the shipped CLI carries it through to `fns.resample()`, and `fns.resample()` called with no options
 * silently takes 1e-4 back. That regression would shift the Fox's posed silhouette by 1-5 pixels of 921,600 — under
 * `diffPct`'s three-decimal rounding on WebGL2, so even a percentage-based parity check would have missed it. The
 * raw changed-pixel count on both backends is the guard.
 */
test('optimize --preset safe --resample changes zero pixels of the Fox at --parity 0: the flag runs resample losslessly', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const out = join(dir, 'fox.glb');
    const r = run(['optimize', asset('Fox'), '--out', out, '--resample', '--parity', '0', '--backend', forge.backend, '--frames', '5', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.input).toMatchObject({ preset: 'safe', parity: 0, steps: { resample: true } });
    // Added back in pipeline order, and it really ran: a step reported `applied: false` would make the parity below
    // vacuous, since a step that does nothing changes no pixel.
    expect(doc.steps.map((s: { name: string }) => s.name)).toEqual(['dedup', 'palette', 'resample', 'prune']);
    expect(doc.steps.find((s: { name: string }) => s.name === 'resample')).toMatchObject({ applied: true, note: null });
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1']);
    expect(doc.verify.parity.threshold).toBe(0);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] safe+resample Fox: ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')}` });
    for (const v of views) {
      expect(v.changedPixels, `${v.view}: --preset safe --resample changed pixels`).toBe(0);
      expect(v.diffPct, `${v.view}: --preset safe --resample changed pixels`).toBe(0);
    }
    expect(doc.verify.parity.pass).toBe(true);
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
    // --parity 0: the same zero-changed-pixels measurement as the Fox above, on the asset whose 148 materials the palette step
    // collapses to one. Every view must be exactly 0, not merely inside the 0.5 % default. This asset corroborates
    // nothing about weld, which is a measured no-op on it (245,673 vertices in and out, all 148 primitives already
    // indexed) and no longer in `safe` anyway; what it covers is dedup, palette and prune -- `safe`'s steps since
    // R105 moved resample out of the preset -- on a many-material asset, where safe does measure 0 on both backends.
    const r = run(['optimize', asset('Buggy'), '--out', join(dir, 'buggy.glb'), '--parity', '0', '--backend', forge.backend, '--frames', '3', '--views', '1', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.stats.before.materials).toBe(148);
    expect(doc.stats.after.materials).toBe(1);
    expect(doc.stats.after.textures).toBe(1);
    expect(doc.verify.delta.materials).toBeLessThan(0);
    expect(doc.verify.optimized.after.totals.sceneSubmissions).toBeLessThanOrEqual(doc.verify.original.after.totals.sceneSubmissions);
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0']);
    expect(doc.verify.parity.threshold).toBe(0);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] safe Buggy: ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')}` });
    for (const v of views) {
      expect(v.changedPixels, `${v.view}: --preset safe changed pixels`).toBe(0);
      expect(v.diffPct, `${v.view}: --preset safe changed pixels`).toBe(0);
    }
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verdict.pass).toBe(true);

    // R156, pinned here because this asset is the one that can tell the two questions apart, and an attempt to
    // conflate them shipped and was reverted.
    //
    // `--parity` is the ORIGINAL-versus-OPTIMIZED threshold. `--parity 0` asks "is the optimized asset exactly the
    // original?" and for the Buggy the answer is yes: every view above is exactly 0 changed pixels, on both backends
    // (CONTRIBUTING.md rule 7). Whether COMPILING a file moves a pixel is a different question: threeforge's batching of
    // this asset moves 1 px on webgl2 and 2 px of 921,600 on webgpu, measured from the built binary twice per
    // backend, and identically on the ORIGINAL file — so it is a property of the asset, not of the rewrite. It is
    // reported in `verify.optimized.parity` (threshold 0.5 %, never tightened by `--parity`) and an agent that needs
    // compile exactness reads that field or runs `analyze --parity 0`, which asks it directly.
    //
    // Carrying a stricter `--parity` into those inner checks made this run exit 1 — answering "no" to a question
    // whose answer is yes. If someone reintroduces that, the two expectations below go red together.
    const compileDrift = (side: 'original' | 'optimized'): number[] => (doc.verify[side].parity.views as Array<{ changedPixels: number }>).map((v) => v.changedPixels);
    expect(doc.verify.original.parity.threshold, '--parity must not reach the inner compile checks').toBe(0.5);
    expect(doc.verify.optimized.parity.threshold, '--parity must not reach the inner compile checks').toBe(0.5);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] Buggy compile drift: original ${JSON.stringify(compileDrift('original'))}, optimized ${JSON.stringify(compileDrift('optimized'))}` });
    // The drift is real, symmetric between the two files, and small enough that only a zero threshold would see it.
    expect(Math.max(...compileDrift('optimized')), 'the premise of this test: compiling the Buggy moves pixels').toBeGreaterThan(0);
    expect(compileDrift('optimized')).toEqual(compileDrift('original'));
    for (const changed of [...compileDrift('original'), ...compileDrift('optimized')]) expect(changed).toBeLessThanOrEqual(4);
    // Reported, not judged into the verdict: the run still passes, and the drift is readable in the document.
    expect(doc.verify.optimized.parity.pass).toBe(true);
    expect(doc.verdict.reasons).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The tolerance is measured, not guessed. `optimize --preset balanced --parity 100` on the Fox, three times per
 * backend (twice before Ruling R100 and again after it, which does not change what `balanced` runs), reported the
 * same figures every time: webgl2 default 0.008 %, orbit-0 0.005 %, orbit-1 0.002 %; webgpu default 0.014 %,
 * orbit-0 0.014 %, orbit-1 0.015 %. So the worst view measured is 0.015 % and 0.05 % leaves ~3.3x headroom.
 * It covers three lossy sources together: `weld` (which R100 moved here out of `safe`, and which is most of the
 * webgpu figure — 0.013 % of the 0.015 % on its own), `quantize` (positions, UVs and weights to integers) and
 * `textures` (the base colour map re-encoded as WebP at quality 85). It is deliberately far below the CLI's own
 * 0.5 % default: balanced is lossy, but only just, and a step that starts moving a tenth of a percent should fail.
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
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
    expect(views.map((v) => v.view)).toEqual(['default', 'orbit-0', 'orbit-1']);
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] balanced Fox: ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')} (tolerance ${BALANCED_PARITY} %)` });
    for (const v of views) expect(v.diffPct, `${v.view}: --preset balanced moved more pixels than the measured tolerance`).toBeLessThanOrEqual(BALANCED_PARITY);
    // Balanced is lossy where safe is not: safe measures 0 changed pixels in every view on both backends, and this
    // measures 76/42/21 on webgl2 and 126/129/141 on webgpu. A run that changed nothing would mean weld, quantize
    // and the WebP re-encode had all stopped doing anything.
    expect(Math.max(...views.map((v) => v.changedPixels)), 'balanced changed no pixel at all: did the lossy steps run?').toBeGreaterThan(0);
    expect(doc.verify.parity.pass).toBe(true);
    expect(doc.verdict.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Ruling R113: `--parity 0` has to fail the *process*, not only the decision.
 *
 * `test/unit/cli-core.test.ts` drives the whole chain — `parityOf` → `verdictOf` → `exitCodeOf` — on a one-pixel
 * difference, but in process. That proves the decision and nothing about the wiring. `src/cli/index.ts` is what turns
 * a verdict into `process.exitCode`, and a change there (an `optimize` case that returns 0, a lost `exitCodeOf` call,
 * a watchdog that exits before the code is read) leaves every unit test green while the shipped binary reports
 * success on a run that moved pixels. Agents branch on the exit code, so that is the failure that matters, and until
 * now the only evidence for it was a one-off manual run.
 *
 * `balanced` is the fixture because it is measurably lossy — weld, quantize and the WebP re-encode move 21-141 pixels
 * per view across the two backends — so `--parity 0` must reject it, on both. The `safe` tests above are the
 * complement: the same binary, the same flag, exit 0.
 */
test('optimize exits 1 when --parity 0 is not met, from the built binary and not only the decision path', { tag: '@corpus' }, async ({ forge }) => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'forge-opt-'));
  try {
    const r = run(['optimize', asset('Fox'), '--out', join(dir, 'fox.glb'), '--preset', 'balanced', '--parity', '0', '--backend', forge.backend, '--frames', '5', '--json']);
    // The assertion the ruling is about: the status of the process, read first so a crash does not surface as
    // "Unexpected end of JSON input".
    expect(r.status, `exit status of a run that moved pixels at --parity 0\n${r.stderr}`).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.input).toMatchObject({ preset: 'balanced', parity: 0 });
    const views = doc.verify.parity.views as Array<{ view: string; diffPct: number; changedPixels: number }>;
    const worst = Math.max(...views.map((v) => v.changedPixels));
    test.info().annotations.push({ type: 'parity', description: `[${forge.backend}] balanced Fox at --parity 0: exit ${r.status}, ${views.map((v) => `${v.view} ${v.changedPixels} px (${v.diffPct} %)`).join(', ')}` });
    // And it failed for the right reason: pixels really moved. Without this the test would also pass if `balanced`
    // had quietly degraded to `safe` and the non-zero exit came from something else entirely.
    expect(worst, 'balanced changed no pixel at all: did the lossy steps run?').toBeGreaterThan(0);
    expect(doc.verify.parity).toMatchObject({ threshold: 0, pass: false });
    expect(doc.verdict.pass).toBe(false);
    expect(doc.verdict.reasons.join(' | '), 'the verdict names parity as the cause').toMatch(/pixel parity .* > 0%/);
    // The changed-pixel count reaches the terminal too, not only the percentage, which at this size rounds to 0.000
    // on WebGL2 and would read as "no difference" to anyone reading the summary.
    expect(r.stderr).toContain('FAIL');
    expect(r.stderr).toMatch(new RegExp(`${worst} changed pixels in the worst view`));
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

/**
 * Independent review C1. three r186's `LoaderUtils.resolveURL` returns an absolute `http://` URI unchanged, so before
 * the fix `analyze` handed one straight to headless Chromium: the page issued the request from this machine's network,
 * outside the confined static server. The whole run is the temporary file below, so this test needs no downloaded
 * content and runs in CI's `--grep-invert "@corpus|@bench"` selection.
 */
test('analyze refuses an asset whose buffer URI points off the served origin (exit 2, before a browser opens)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-analyze-uri-'));
  try {
    const hostile = join(dir, 'hostile.gltf');
    writeFileSync(hostile, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'http://127.0.0.1:1/x.bin', byteLength: 4 }] }));
    const started = Date.now();
    const r = run(['analyze', hostile, '--json']);
    const ms = Date.now() - started;
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('buffers[0].uri');
    expect(r.stderr).toContain('http://127.0.0.1:1/x.bin');
    expect(r.stderr).toMatch(/URI scheme/);
    // No browser is launched for this, so it is an argument-check-speed failure, not a page one.
    expect(ms).toBeLessThan(20_000);
    // The same for an image URI that climbs out of the asset's directory, and for a protocol-relative host.
    const climbing = join(dir, 'climbing.gltf');
    writeFileSync(climbing, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../../../../etc/passwd' }] }));
    expect(run(['analyze', climbing, '--json']).status).toBe(2);
    const relative = join(dir, 'relative.gltf');
    writeFileSync(relative, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '//attacker.example/beacon.png' }] }));
    const protocolRelative = run(['analyze', relative, '--json']);
    expect(protocolRelative.status, protocolRelative.stderr).toBe(2);
    expect(protocolRelative.stderr).toContain('//attacker.example/beacon.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
