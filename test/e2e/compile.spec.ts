import { expect, test, type ForgePage } from './fixtures.js';
import { differingPixels, pixelDiff, settle } from './pixels.js';

/** Records a measurement on the test (visible in the JSON and HTML reports) instead of printing it. */
function note(description: string): void {
  test.info().annotations.push({ type: 'materials', description });
}

interface View {
  name: string;
  position: [number, number, number];
  lookAt: [number, number, number];
}

/**
 * Two viewpoints on the naive scene. The first is the harness default, which the committed baseline images were taken
 * from; the second is low and oblique across the prop field, so the props are drawn in a different order, at a
 * different depth and with a different set of them culled. One camera can miss a batch that is wrong only where that
 * camera does not look, or right only in that one draw order.
 */
const VIEWS: View[] = [
  { name: 'default', position: [0, 110, 150], lookAt: [0, 0, 0] },
  { name: 'oblique', position: [-70, 18, -70], lookAt: [20, 5, 20] },
];

async function look(forge: ForgePage, view: View): Promise<void> {
  await forge.page.evaluate((v: View) => {
    const f = window.__forge;
    f.camera.position.set(v.position[0], v.position[1], v.position[2]);
    f.camera.lookAt(v.lookAt[0], v.lookAt[1], v.lookAt[2]);
    f.camera.updateMatrixWorld();
  }, view);
}

/** One screenshot per view, leaving the camera back on the first (the one the committed baselines were taken from). */
async function shootViews(forge: ForgePage): Promise<Record<string, Buffer>> {
  const shots: Record<string, Buffer> = {};
  for (const view of VIEWS) {
    await look(forge, view);
    await settle(forge.page, 3);
    shots[view.name] = await forge.page.screenshot({ type: 'png' });
  }
  await look(forge, VIEWS[0]!);
  await settle(forge.page, 2);
  return shots;
}

/** What the ledger reports was actually drawn, summarised so a naive frame and a compiled one can be compared. */
interface DrawSet {
  triangles: number;
  /** Per pass, over scene submissions only: the output quad is renderer-internal and is left out of both sides. */
  byPass: Record<string, { submissions: number; instancesDrawn: number; expectedGpuDraws: number }>;
  /** Sorted names of the submissions the compiler did not fold into a batch, which survive compilation as themselves. */
  named: string[];
  /** Whether this frame's context folds a batch into one multi-draw call. A capability, not a backend name. */
  multiDraw: boolean;
  /** Reported draw calls this frame's model did not predict. Asserted at 0 per draw set, not only on the first frame. */
  unattributed: number;
}

/**
 * Renders at `view` and summarises `ledger.frame({ items: true })`.
 *
 * Pixels alone cannot settle whether a prop was dropped: a prop lost in front of another prop reads prop-on-prop on
 * both sides of the comparison and no colour test can see it. The draw set can, so the naive and compiled scenes are
 * compared by what the ledger says each actually submitted. Leaves the camera on the first view, as `shootViews` does.
 */
async function drawSetAt(forge: ForgePage, view: View): Promise<DrawSet> {
  await look(forge, view);
  const set = await forge.page.evaluate(async () => {
    const f = window.__forge;
    for (let i = 0; i < 3; i++) await f.frameAsync(); // let per-instance culling settle at the new camera
    const frame = await f.frameAsync({ items: true });
    const scene = (frame.items ?? []).filter((i) => i.reason !== 'renderer-internal');
    const byPass: Record<string, { submissions: number; instancesDrawn: number; expectedGpuDraws: number }> = {};
    for (const item of scene) {
      const bucket = (byPass[item.pass] ??= { submissions: 0, instancesDrawn: 0, expectedGpuDraws: 0 });
      bucket.submissions++;
      bucket.instancesDrawn += item.instancesDrawn;
      bucket.expectedGpuDraws += item.expectedGpuDraws;
    }
    return {
      triangles: frame.totals.triangles,
      multiDraw: frame.env.multiDraw,
      unattributed: frame.totals.unattributed,
      byPass,
      named: scene
        .filter((i) => i.reason !== 'batched')
        .map((i) => i.name)
        .sort(),
    };
  });
  await look(forge, VIEWS[0]!);
  return set;
}

/** A tinted group compiled with default options (a BatchedMesh) and with `bake: true` (a baked mesh). */
const TINTED_MODES = [
  ['default options', {}],
  ['bake: true', { bake: '1' }],
] as const;

test('world.compile() takes the naive scene from 503 to 28 submissions with identical pixels, from two cameras, and decompile() puts the picture back', async ({ forge }) => {
  await forge.open('naive');
  const before = await forge.page.evaluate(() => window.__forge.frame());
  expect(before.totals.sceneSubmissions).toBe(503);
  // Baseline image of the naive render; the compiled render must match it.
  if (forge.pixelChecks) await expect(forge.page).toHaveScreenshot(`naive-${forge.backend}.png`, { maxDiffPixelRatio: 0.002 });
  // Captured at the oblique camera, where the pixel diff is largest, and independently of whether screenshots work here.
  const naiveDraw = await drawSetAt(forge, VIEWS[1]!);
  const naiveShots = forge.pixelChecks ? await shootViews(forge) : null;

  const { report, after, text } = await forge.page.evaluate(() => {
    const f = window.__forge;
    const report = f.compile();
    const after = f.frame();
    return { report, after, text: f.ledger.report() };
  });
  console.log(text);
  console.log(JSON.stringify({ before: report.before, after: report.after, groups: report.groups.length, skipped: report.skipped.length }));

  expect(report.after.batches).toBe(15);
  expect(after.totals.sceneSubmissions).toBe(28);
  expect(after.totals.unattributed).toBe(0);
  expect(after.byReason).toMatchObject({
    batched: { submissions: 15 },
    dynamic: { submissions: 10 },
    skinned: { submissions: 2 },
    'unique-material': { submissions: 1 },
    'renderer-internal': { submissions: 1 },
  });
  expect(after.totals.programSwitches).toBeLessThan(before.totals.programSwitches);
  if (forge.pixelChecks) await expect(forge.page).toHaveScreenshot(`naive-${forge.backend}.png`, { maxDiffPixelRatio: 0.002 });
  const compiledDraw = await drawSetAt(forge, VIEWS[1]!);
  const compiledShots = forge.pixelChecks ? await shootViews(forge) : null;

  const restored = await forge.page.evaluate(() => {
    window.__forge.decompile();
    return window.__forge.frame().totals.sceneSubmissions;
  });
  expect(restored).toBe(503);
  // The scene is naive again: the picture must be the one it started with, not merely "some naive scene".
  const restoredShots = forge.pixelChecks ? await shootViews(forge) : null;

  // The oblique view's pixel diff is the strictest check here and it is not zero, so "did a prop get dropped?" is
  // settled on what the ledger says was submitted rather than on colours — a prop lost in front of another prop reads
  // prop-on-prop on both sides and no colour test can see it. Batching may reorder draws and change how many GPU draws
  // they cost, but it must never change which instances are drawn: a dropped prop shows up here at once, as fewer
  // triangles or fewer drawn instances.
  expect(Object.keys(compiledDraw.byPass).sort(), 'oblique: the same passes').toEqual(Object.keys(naiveDraw.byPass).sort());
  for (const pass of Object.keys(naiveDraw.byPass)) {
    expect(compiledDraw.byPass[pass]!.instancesDrawn, `oblique, pass ${pass}: instances drawn`).toBe(naiveDraw.byPass[pass]!.instancesDrawn);
  }
  expect(compiledDraw.triangles, 'oblique: triangles drawn').toBe(naiveDraw.triangles);
  // `expectedGpuDraws` used to be recorded in the annotation below and never asserted, so a backend-specific draw-count
  // anomaly could only be found by reading a report. It cannot be compared naive-against-compiled — batching is
  // *supposed* to change it — but each side has a per-backend law it must obey, and this scene is simple enough to
  // state it: one pass (`main`), nothing nested, so no batch has slots an enclosing pass zeroed.
  //   with WEBGL_multi_draw: a batch collapses to one call, so every submission costs exactly one draw
  //           (naive 500 -> 500, compiled 28 -> 28).
  //   without it (WebGPU, and any WebGL2 context lacking the extension): one call per multi-draw slot, so a pass
  //           costs one draw per drawn instance (naive 500 -> 500, compiled 28 submissions -> 500).
  // The law keys on `frame.env.multiDraw`, the capability the ledger predicts from, not on the Playwright project
  // name: a webgl2 context without `WEBGL_multi_draw` would obey the second law, and selecting by backend name would
  // fail there blaming a threeforge property for an environment condition. (The SwiftShader webgl2 context the bench
  // baselines were recorded on does report `multiDraw: true`; the guard is for any context that does not.)
  //
  // What this adds over `unattributed`, asserted at 0 for each of these two draw sets just below: that assertion ties
  // the ledger's cost *model* to the number the backend actually reported, so a model-only regression fails there
  // (breaking the webgl2 folding rule in `expectedDraws.ts` alone lands as `unattributed: -475`, not here). It says
  // nothing about what the backend is doing. These two lines do: that a multi-draw context really is folding each
  // batch into one call, and that a non-multi-draw one really is issuing one per drawn instance. If the platform
  // stopped offering WEBGL_multi_draw, or three stopped using it, the compiled frame would cost 500 calls instead of
  // 28, the ledger would report that faithfully, `unattributed` would stay 0 — and submissions, instances drawn,
  // triangles and every pixel would be unchanged, so nothing else in this spec would notice a scene that got 18x
  // more expensive to draw.
  for (const [label, set] of [
    ['naive', naiveDraw],
    ['compiled', compiledDraw],
  ] as const) {
    // The law above is stated per draw set, so the reconciliation it leans on is asserted per draw set too: the
    // `unattributed` at 0 earlier in this test is the default-camera frame, not either of these oblique ones.
    expect(set.unattributed, `oblique, ${label}: unattributed draws`).toBe(0);
    for (const [pass, bucket] of Object.entries(set.byPass)) {
      const expected = set.multiDraw ? bucket.submissions : bucket.instancesDrawn;
      const law = set.multiDraw ? 'one draw per submission (multi-draw)' : 'one draw per drawn instance';
      expect(bucket.expectedGpuDraws, `oblique, ${label}, pass ${pass}: multiDraw=${set.multiDraw} costs ${law}`).toBe(expected);
    }
  }
  // And everything the compiler left as its own draw was drawn naively too, so nothing left the set under another name.
  // Two relations, because the two sides are not comparable as sets: naively *nothing* is batched, so `naiveDraw.named`
  // is every submission of that frame (500 at this camera) while `compiledDraw.named` is the 13 the compiler left
  // alone. A subset is therefore the only relation that can hold between them, and on its own it is weak — a compiler
  // that dropped one unbatched object and admitted another in its place satisfies it, since both names are in the
  // naive 500. So the compiled side is pinned exactly as well: the ground (its material is unique), the ten movers and
  // the two skinned dummies, which is the same 13 the `byReason` block above counts at the default camera. A swap
  // moves a name in or out of this list and fails here.
  expect(naiveDraw.named, 'oblique: an object the compiler kept was not drawn naively').toEqual(expect.arrayContaining(compiledDraw.named));
  expect(compiledDraw.named, 'oblique: exactly the submissions the compiler leaves as themselves').toEqual([
    'ground',
    'prop-136',
    'prop-18',
    'prop-203',
    'prop-247',
    'prop-267',
    'prop-285',
    'prop-356',
    'prop-370',
    'prop-421',
    'prop-70',
    'skinned-0',
    'skinned-1',
  ]);
  note(
    `[${forge.backend}] oblique draw set: triangles ${naiveDraw.triangles} naive / ${compiledDraw.triangles} compiled; ` +
      Object.keys(naiveDraw.byPass)
        .map(
          (p) =>
            `${p}: ${naiveDraw.byPass[p]!.instancesDrawn} -> ${compiledDraw.byPass[p]!.instancesDrawn} instances drawn, ` +
            `${naiveDraw.byPass[p]!.expectedGpuDraws} -> ${compiledDraw.byPass[p]!.expectedGpuDraws} gpu draws, ` +
            `${naiveDraw.byPass[p]!.submissions} -> ${compiledDraw.byPass[p]!.submissions} submissions`,
        )
        .join('; '),
  );

  if (naiveShots && compiledShots && restoredShots) {
    for (const view of VIEWS) {
      const compiled = pixelDiff(naiveShots[view.name]!, compiledShots[view.name]!, { threshold: 4 });
      const back = differingPixels(naiveShots[view.name]!, restoredShots[view.name]!, { threshold: 4 });
      note(`[${forge.backend}] ${view.name} view: compile ${(compiled * 100).toFixed(4)}%, decompile ${back} pixels`);
      // The measured baseline, so whoever next sees this fail reads it against the known margin instead of rediscovering
      // it: at the 800x600 viewport pixelDiff divides by 480,000, and the oblique view sits at 0.0467% (webgl2) /
      // 0.0471% (webgpu) of the 0.0500% bound — 224 / 226 differing pixels, about 14 px of headroom. It is draw-order
      // tie-breaking among overlapping distant props, which the draw-set comparison above proves rather than infers.
      // The default view sits at 0.0069% / 0.0071%. decompile() is held to what it measures, not to the compile bound
      // (240 pixels, enough to hide a prop restored at a wrong transform, 30-200 px at this view): 0 differing pixels on
      // both views and both backends (two runs each), bounded at a few pixels.
      expect(compiled, `${view.name} view: compile() changed the picture`).toBeLessThan(0.0005);
      expect(back, `${view.name} view: decompile() did not restore the picture`).toBeLessThanOrEqual(8);
    }
  }
});

test("transparent: 'keep' leaves transparent statics unbatched: no unattributed draws, more submissions than the default 28", async ({ forge }) => {
  await forge.open('naive', { transparent: 'keep', compile: '1' });
  const after = await forge.page.evaluate(() => window.__forge.frame());

  expect(after.totals.unattributed).toBe(0);
  expect(after.totals.sceneSubmissions).toBeGreaterThan(28);
});

test('resolve() maps a raycast against the compiled scene back to the original prop', async ({ forge }) => {
  await forge.open('naive', { compile: '1' });
  const result = await forge.page.evaluate(() => {
    const f = window.__forge;
    // A static prop standing alone above the ground plane: pick the tallest static so nothing else is hit first.
    const target = f.naive!.props.filter((p) => p.userData.forge === 'static').sort((a, b) => b.position.y - a.position.y)[0]!;
    return { ...f.raycastDown(target.position.x, target.position.z), targetName: target.name };
  });
  expect(result.hitCount).toBeGreaterThan(0);
  expect(result.hitIsBatch).toBe(true);
  expect(result.resolvedName).toBe(result.targetName);
});

test("dynamics: 'batch-sync' folds the 10 movers into their batches: 28 -> 18 submissions, same pixels, and they still move", async ({ forge }) => {
  await forge.open('naive', { dynamics: 'batch-sync', compile: '1' });
  const result = await forge.page.evaluate(() => {
    const f = window.__forge;
    const frame = f.frame();
    const mover = f.naive!.dynamics[0]!;
    const slot = f.world.slotOf(mover)!;
    mover.rotation.y += 1;
    f.frame();
    const M = mover.matrixWorld.clone();
    (slot.batch as { getMatrixAt(i: number, m: unknown): void }).getMatrixAt(slot.instanceId, M);
    const same = M.elements.every((e, i) => Math.abs(e - mover.matrixWorld.elements[i]!) < 1e-4);
    mover.rotation.y -= 1;
    f.frame();
    return { totals: frame.totals, byReason: frame.byReason, same };
  });
  expect(result.totals.sceneSubmissions).toBe(18);
  expect(result.totals.unattributed).toBe(0);
  expect(result.byReason.dynamic).toBeUndefined();
  expect(result.same).toBe(true);
  if (forge.pixelChecks) await expect(forge.page).toHaveScreenshot(`naive-${forge.backend}.png`, { maxDiffPixelRatio: 0.002 });
});

test('tinted node-material statics keep an instance setupOutput, alphaTest, a user-added property and a userData uniform node when a group clone carries the tints', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  for (const [mode, query] of TINTED_MODES) {
    await forge.open('empty', { ...query });
    await forge.page.evaluate(() => {
      const f = window.__forge;
      const T = f.three;
      const W = f.webgpu;
      // Alpha in stripes that alphaTest cuts out, and an instance setupOutput that darkens the colour by a user-added own
      // property and mixes in a uniform node kept in userData, both read through `this`. NodeMaterial.copy() carries none
      // of them: alphaTest is an accessor on Material.prototype, instance functions and user-added properties are not on
      // a fresh instance, and userData is JSON-copied, which turns the uniform node into a plain object. (A uniform
      // reached only from inside a setup method is uploaded once, on the render object's first frame, in the naive
      // render too, so this cell keeps its value fixed while the classic cell animates its userData uniform. The
      // mechanism is NodeMaterialObserver.containsNode (r186, ~325-342): it walks the material's own properties and
      // reports the material as holding nodes only when one of those properties is itself a node, so a node reachable
      // only through a closure leaves hasNode false and needsRefresh returns FULL only on the render object's first
      // frame. The uniform -- objectGroup, UniformNode's default -- is uploaded in that refresh and never again.)
      const size = 32;
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          data[o] = data[o + 1] = data[o + 2] = 255;
          data[o + 3] = Math.floor(y / 4) % 2 === 0 ? 255 : 0;
        }
      }
      const map = new T.DataTexture(data, size, size);
      map.needsUpdate = true;
      const extra = { darken: 0.35 };
      const glow = W.TSL.uniform(0.3);
      const setupOutput = function (this: { extra: typeof extra; userData: { glow: typeof glow } }, builder: unknown, output: unknown) {
        const out = output as { rgb: { mul(value: number): unknown }; a: unknown };
        const rgb = W.TSL.mix(out.rgb.mul(this.extra.darken) as never, W.TSL.vec3(1, 0.85, 0.2), this.userData.glow as never);
        return (W.NodeMaterial.prototype.setupOutput as (...args: unknown[]) => unknown).call(this, builder, W.TSL.vec4(rgb as never, out.a as never));
      };
      const geometry = new T.BoxGeometry(1.4, 1.4, 1.4);
      [0xd04040, 0x40b060, 0x4060d0, 0xd0b040].forEach((color, i) => {
        const material = Object.assign(new W.MeshStandardNodeMaterial({ color, map, roughness: 0.8 }), { setupOutput, extra });
        material.alphaTest = 0.5;
        material.userData.glow = glow;
        const mesh = new T.Mesh(geometry, material);
        mesh.position.set(i * 2 - 3, 0.7, 0);
        mesh.rotation.y = 0.5;
        (mesh.userData as { forge?: string }).forge = 'static';
        f.scene.add(mesh);
      });
      const sun = new T.DirectionalLight(0xffffff, 2);
      sun.position.set(3, 6, 5);
      f.scene.add(new T.AmbientLight(0xffffff, 0.8), sun);
      f.scene.updateMatrixWorld(true);
      f.camera.position.set(0, 3, 8);
      f.camera.lookAt(0, 0.7, 0);
      f.camera.updateMatrixWorld();
    });
    await settle(forge.page, 5);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      for (let i = 0; i < 3; i++) await f.frameAsync();
      return { after: report.after };
    });
    await settle(forge.page, 2);
    const after = await forge.page.screenshot({ type: 'png' });
    const diff = pixelDiff(before, after, { threshold: 4 });
    note(`[${forge.backend}] tinted node materials with extra and a userData uniform node, ${mode}: ${r.after.batches} batches, ${r.after.baked} baked, pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(r.after.batches + r.after.baked, `${mode}: the tinted group is compiled`).toBe(1);
    expect(diff, mode).toBeLessThan(0.0005);
  }
});

test('tinted classic statics keep a custom onBeforeCompile, define, user-added property and a userData uniform animated through the source when a group clone carries the tints (drawn by WebGLRenderer, which runs them)', async ({ forge }) => {
  // three r186 runs material onBeforeCompile and defines only in renderers/WebGLRenderer.js; the harness's WebGPURenderer
  // (both backends) ignores them, so this cell draws the same scene with a classic WebGLRenderer inside the page.
  for (const [mode, query] of TINTED_MODES) {
    await forge.open('empty', { ...query });
    const r = await forge.page.evaluate(() => {
      const f = window.__forge;
      const T = f.three;
      // The hook reads, through `this` (the drawn material), a user-added own property, which Material.copy() does not
      // carry, and a uniform kept in userData, which Material.copy() JSON-copies and so cuts loose from the source.
      const extra = { uTint: { value: new T.Color(0.6, 0.9, 0.75) } };
      const onBeforeCompile = function (this: { extra: typeof extra; userData: { uWave: { value: number } } }, shader: { fragmentShader: string; uniforms: Record<string, unknown> }): void {
        shader.uniforms.uTint = this.extra.uTint;
        shader.uniforms.uWave = this.userData.uWave;
        shader.fragmentShader = `uniform vec3 uTint;\nuniform float uWave;\n${shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n#ifdef MY_DEFINE\n\tgl_FragColor.rgb = vec3( 1.0 ) - gl_FragColor.rgb;\n#endif\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb * uTint, vec3( 1.0, 0.85, 0.2 ), uWave );')}`;
      };
      const wave = { value: 0 };
      const geometry = new T.BoxGeometry(1.4, 1.4, 1.4);
      const sources = [0xd04040, 0x40b060, 0x4060d0, 0xd0b040].map((color, i) => {
        const material = Object.assign(new T.MeshStandardMaterial({ color, roughness: 0.8 }), { onBeforeCompile, extra, defines: { STANDARD: '', MY_DEFINE: '' } });
        material.userData.uWave = wave;
        const mesh = new T.Mesh(geometry, material);
        mesh.position.set(i * 2 - 3, 0.7, 0);
        mesh.rotation.y = 0.5;
        (mesh.userData as { forge?: string }).forge = 'static';
        f.scene.add(mesh);
        return material;
      });
      const sun = new T.DirectionalLight(0xffffff, 2);
      sun.position.set(3, 6, 5);
      f.scene.add(new T.AmbientLight(0xffffff, 0.8), sun);
      const gl = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
      gl.setPixelRatio(1);
      gl.setSize(400, 300, false);
      const camera = new T.PerspectiveCamera(50, 4 / 3, 0.5, 50);
      camera.position.set(0, 3, 8);
      camera.lookAt(0, 0.7, 0);
      camera.updateMatrixWorld();
      const shot = (): string => {
        f.scene.updateMatrixWorld(true);
        gl.render(f.scene, camera);
        return gl.domElement.toDataURL('image/png');
      };
      // Animated through a source material, as an app holding its own material does it.
      const waveThroughSource = (value: number): void => {
        (sources[0]!.userData as { uWave: { value: number } }).uWave.value = value;
      };
      const naive = [shot()];
      waveThroughSource(0.6);
      naive.push(shot());
      waveThroughSource(0);
      const report = f.compile();
      shot();
      const compiled = [shot()];
      waveThroughSource(0.6);
      compiled.push(shot());
      gl.dispose();
      return { naive, compiled, after: report.after };
    });
    const png = (dataUrl: string): Buffer => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const animated = pixelDiff(png(r.naive[0]!), png(r.naive[1]!), { threshold: 4 });
    const diffs = [0, 1].map((k) => pixelDiff(png(r.naive[k]!), png(r.compiled[k]!), { threshold: 4 }));
    note(`[${forge.backend}] tinted classic materials with onBeforeCompile, MY_DEFINE, extra and a userData uniform (WebGLRenderer), ${mode}: ${r.after.batches} batches, ${r.after.baked} baked, the wave uniform changes the naive render by ${(animated * 100).toFixed(4)}%, pixel diff at wave 0 ${(diffs[0]! * 100).toFixed(4)}%, at wave 0.6 set through the source ${(diffs[1]! * 100).toFixed(4)}%`);
    expect(r.after.batches + r.after.baked, `${mode}: the tinted group is compiled`).toBe(1);
    expect(animated, `${mode}: the wave uniform visibly changes the naive render`).toBeGreaterThan(0.01);
    expect(diffs[0], `${mode}, wave 0`).toBeLessThan(0.0005);
    expect(diffs[1], `${mode}, wave 0.6 set through the source`).toBeLessThan(0.0005);
  }
});
