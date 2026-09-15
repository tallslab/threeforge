// Ledger overhead report (not a gate): the time DrawCallLedger adds per submission and the bytes it allocates per frame.
//
//   pnpm build:lib && node scripts/ledger-overhead.mjs [submissions...]     (default 2000 10000 20000)
//
// Renders two synthetic scenes through a minimal renderer (a fixed render list, one renderObject call per mesh, no GPU)
// twice: once bare and once with a ledger attached. The difference is the ledger's cost.
// - flat: N unnamed meshes directly under the scene (every name is a `Mesh[i]` path), tags alternating static/dynamic.
// - nested: N unnamed meshes in unnamed groups of 50 under named, static-tagged zones of 500 (`zone-3/Group[4]/Mesh[17]`).
// Both share 16 registered materials and one geometry. µs per submission is the best of 9 ledger rounds of 5 frames
// minus the best of 9 bare rounds (the best of the per-round differences picks the round whose ledger time was lowest
// and whose bare time was highest, which is biased low and can even read negative); bytes per
// frame is the heap growth over 10 frames with the young generation sized so no scavenge runs inside the window (the
// script re-runs itself with --expose-gc and a large semi-space). Neither window contains the ledger's periodic rescan
// (every 60 frames), which is timed on its own in the `rescan ms` column. Numbers vary by machine; compare runs on one.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  const flags = ['--expose-gc', '--min-semi-space-size=512', '--max-semi-space-size=512'];
  const run = spawnSync(process.execPath, [...flags, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const dist = (path) => new URL(`../dist/${path}`, import.meta.url);
if (!existsSync(fileURLToPath(dist('ledger/DrawCallLedger.js')))) {
  console.error('ledger-overhead: dist/ is missing; run `pnpm build:lib` first');
  process.exit(1);
}
const { DrawCallLedger } = await import(dist('ledger/DrawCallLedger.js').href);
const { MaterialRegistry } = await import(dist('registry/MaterialRegistry.js').href);
const { tag } = await import(dist('tags.js').href);
const { BoxGeometry, Color, DirectionalLight, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, REVISION, Scene } = await import('three');

const counts = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const SUBMISSIONS = counts.length > 0 ? counts : [2000, 10000, 20000];
const MATERIALS = 16;
const ROUNDS = 9;
const ROUND_FRAMES = 5;
const BYTE_FRAMES = 10;

/** three's render loop reduced to what the ledger patches: a fixed render list, one renderObject call per item. */
class MinimalRenderer {
  constructor(list) {
    this.list = list;
    this.info = { render: { drawCalls: 0, triangles: 0 }, memory: { programs: MATERIALS, textures: 0, geometries: 1 } };
    this.backend = { hasFeature: (name) => name === 'WEBGL_multi_draw' };
  }

  render(scene, camera) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const object = list[i];
      this.renderObject(object, scene, camera, object.geometry, object.material, null, null, null, null);
    }
  }

  renderObject(object) {
    object.onBeforeRender();
    this.info.render.drawCalls++;
    this.info.render.triangles += 12;
    object.onAfterRender();
  }
}

function buildScene(shape, submissions) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  const sun = new DirectionalLight(0xffffff, 1);
  sun.name = 'sun';
  scene.add(sun);
  const geometry = new BoxGeometry(1, 1, 1);
  const materials = [];
  for (let i = 0; i < MATERIALS; i++) materials.push(new MeshStandardMaterial({ color: new Color().setHSL(i / MATERIALS, 0.5, 0.5) }));
  const list = [];
  let zone = null;
  let group = null;
  for (let i = 0; i < submissions; i++) {
    const mesh = new Mesh(geometry, materials[i % MATERIALS]);
    mesh.castShadow = i % 4 === 0;
    if (shape === 'flat') {
      (i % 2 === 0 ? tag.static : tag.dynamic)(mesh);
      scene.add(mesh);
    } else {
      if (i % 500 === 0) {
        zone = tag.static(new Group());
        zone.name = `zone-${i / 500}`;
        scene.add(zone);
      }
      if (i % 50 === 0) {
        group = new Group();
        zone.add(group);
      }
      group.add(mesh);
    }
    list.push(mesh);
  }
  scene.updateMatrixWorld(true);
  return { scene, camera, materials, list };
}

function frames(renderer, scene, camera, n) {
  for (let i = 0; i < n; i++) renderer.render(scene, camera);
}

function heapUsed() {
  return process.memoryUsage().heapUsed;
}

function measure(shape, submissions) {
  const { scene, camera, materials, list } = buildScene(shape, submissions);
  const registry = new MaterialRegistry();
  for (const m of materials) registry.register(m);
  const bare = new MinimalRenderer(list);
  const renderer = new MinimalRenderer(list);
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer);
  // Warm up the JIT and every cache, then restart the 60-frame rescan period so no window below contains a rescan.
  for (let i = 0; i < 40; i++) {
    bare.render(scene, camera);
    renderer.render(scene, camera);
  }
  ledger.rescan();

  globalThis.gc();
  let before = heapUsed();
  frames(bare, scene, camera, BYTE_FRAMES);
  const bareBytes = (heapUsed() - before) / BYTE_FRAMES;
  globalThis.gc();
  before = heapUsed();
  frames(renderer, scene, camera, BYTE_FRAMES);
  const ledgerBytes = (heapUsed() - before) / BYTE_FRAMES;

  // Each side's own best round: noise is one-sided (a round is never faster than the work it does), so the minimum of
  // each estimates its true cost, while the minimum of the differences subtracts a slow bare round from a fast ledger one.
  let bestBare = Infinity;
  let bestLedger = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    let t = performance.now();
    frames(bare, scene, camera, ROUND_FRAMES);
    bestBare = Math.min(bestBare, performance.now() - t);
    t = performance.now();
    frames(renderer, scene, camera, ROUND_FRAMES);
    bestLedger = Math.min(bestLedger, performance.now() - t);
  }
  const best = (bestLedger - bestBare) / ROUND_FRAMES;

  let rescanMs = Infinity;
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    ledger.rescan();
    rescanMs = Math.min(rescanMs, performance.now() - t);
  }

  const snapshot = ledger.frame();
  if (snapshot.totals.submissions !== submissions) throw new Error(`expected ${submissions} submissions, the ledger saw ${snapshot.totals.submissions}`);
  ledger.detach();
  return { shape, submissions, usPerSubmission: (best * 1000) / submissions, bytesPerFrame: ledgerBytes - bareBytes, rescanMs };
}

const pad = (value, width) => String(value).padStart(width);
console.log(`threeforge ledger overhead: node ${process.version}, three r${REVISION} (not a gate; compare runs on one machine)`);
console.log(`${'scene'.padEnd(7)} ${pad('submissions', 11)} ${pad('µs/submission', 13)} ${pad('bytes/frame', 12)} ${pad('MB/frame', 8)} ${pad('rescan ms', 9)}`);
for (const shape of ['flat', 'nested']) {
  for (const n of SUBMISSIONS) {
    const r = measure(shape, n);
    const bytes = Math.max(0, Math.round(r.bytesPerFrame));
    console.log(`${shape.padEnd(7)} ${pad(n, 11)} ${pad(r.usPerSubmission.toFixed(2), 13)} ${pad(bytes, 12)} ${pad((bytes / 1e6).toFixed(2), 8)} ${pad(r.rescanMs.toFixed(1), 9)}`);
  }
}
console.log('targets at 10k submissions: ≤ 1 µs per submission and ≤ 1 MB per frame (audit of 0.8.0: 3.8 µs, 8.7 MB)');
