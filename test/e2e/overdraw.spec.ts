import { expect, test } from './fixtures.js';

/*
 * The count pass must agree with geometry. Every cell draws into an orthographic view of the 2 x 2 square at the origin
 * (camera at z = 5 looking down -z), so fragments per pixel are whole numbers or exact halves: the 800 x 600 canvas
 * counts into a 128 x 96 target, and a 2-texel texture splits it at column 64. `toBeCloseTo(x, 2)` allows 0.005, less
 * than the harness background's red channel (0x20 in sRGB, 0.014 linear) that the count used to add.
 */

test('overdraw: one opaque full-screen quad reads 1, two stacked transparent quads read 2', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const quad = (z: number, transparent: boolean) => {
      const m = new T.Mesh(new T.PlaneGeometry(2, 2), new T.MeshBasicMaterial({ transparent, opacity: 0.5 }));
      m.position.z = z;
      m.frustumCulled = false;
      return m;
    };
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    f.scene.add(quad(0, false), quad(1, true), quad(2, true));
    const measured = await f.measureOverdraw(cam);
    await f.frameAsync();
    const frame = f.frame();
    return {
      measured,
      frame: frame.overdraw,
      unattributed: frame.totals.unattributed,
      sceneSubmissions: frame.totals.sceneSubmissions,
    };
  });
  expect(r.measured.opaque).toBeCloseTo(1, 2);
  expect(r.measured.transparent).toBeCloseTo(2, 2);
  expect(r.frame).toEqual({
    opaque: r.measured.opaque,
    transparent: r.measured.transparent,
    transparentSubmissions: 2,
    particles: 0,
    pixels: 800 * 600,
    measured: true,
  });
  // The measurement renders are not frames: the following real frame still attributes every draw.
  expect(r.unattributed).toBe(0);
  expect(r.sceneSubmissions).toBe(3);
});

test('the background never counts: white colour, texture and background node still read 1 and 2', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const quad = (z: number, transparent: boolean) => {
      const m = new T.Mesh(new T.PlaneGeometry(2, 2), new T.MeshBasicMaterial({ transparent, opacity: 0.5 }));
      m.position.z = z;
      m.frustumCulled = false;
      return m;
    };
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    f.scene.add(quad(0, false), quad(1, true), quad(2, true));
    const scene = f.scene as typeof f.scene & { backgroundNode?: unknown };
    const results: Record<string, { opaque: number; transparent: number }> = {};
    const white = new T.Color(0xffffff);
    scene.background = white;
    results.colour = await f.measureOverdraw(cam);
    const texture = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.needsUpdate = true;
    scene.background = texture;
    results.texture = await f.measureOverdraw(cam);
    const node = f.webgpu.TSL.color(0xffffff);
    scene.background = null;
    scene.backgroundNode = node;
    results.node = await f.measureOverdraw(cam);
    return { results, restored: scene.background === null && scene.backgroundNode === node };
  });
  for (const [name, measured] of Object.entries(r.results)) {
    expect(measured.opaque, name).toBeCloseTo(1, 2);
    expect(measured.transparent, name).toBeCloseTo(2, 2);
  }
  expect(Object.keys(r.results)).toEqual(['colour', 'texture', 'node']);
  expect(r.restored).toBe(true);
});

test('black instance and batch colours count: instanced quad reads 1, two-quad batch reads 2', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    const plane = new T.PlaneGeometry(2, 2);
    const black = new T.Color(0x000000);
    const instanced = new T.InstancedMesh(plane, new T.MeshBasicMaterial(), 1);
    instanced.setMatrixAt(0, new T.Matrix4());
    instanced.setColorAt(0, black);
    instanced.frustumCulled = false;
    const batch = new T.BatchedMesh(2, 4, 6, new T.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
    const geometry = batch.addGeometry(plane);
    for (const z of [1, 2]) {
      const id = batch.addInstance(geometry);
      batch.setMatrixAt(id, new T.Matrix4().makeTranslation(0, 0, z));
      batch.setColorAt(id, black);
    }
    batch.frustumCulled = false;
    batch.perObjectFrustumCulled = false;
    f.scene.add(instanced, batch);
    return f.measureOverdraw(cam);
  });
  expect(r.opaque).toBeCloseTo(1, 2);
  expect(r.transparent).toBeCloseTo(2, 2);
});

test('map and alphaMap cutouts count only their kept texels: half-cut quads read 0.5', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    const plane = new T.PlaneGeometry(2, 2);
    // Two texels, nearest-filtered: the left one is cut, the right one kept.
    const halves = (texels: number[]) => {
      const t = new T.DataTexture(new Uint8Array(texels), 2, 1);
      t.needsUpdate = true;
      return t;
    };
    const mapCut = new T.Mesh(
      plane,
      new T.MeshBasicMaterial({ map: halves([255, 255, 255, 0, 255, 255, 255, 255]), alphaTest: 0.5 }),
    );
    // alphaMap reads the green channel.
    const alphaMapCut = new T.Mesh(
      plane,
      new T.MeshBasicMaterial({
        alphaMap: halves([0, 0, 0, 255, 255, 255, 255, 255]),
        alphaTest: 0.5,
        transparent: true,
      }),
    );
    alphaMapCut.position.z = 1;
    for (const m of [mapCut, alphaMapCut]) m.frustumCulled = false;
    f.scene.add(mapCut, alphaMapCut);
    return f.measureOverdraw(cam);
  });
  expect(r.opaque).toBeCloseTo(0.5, 2);
  expect(r.transparent).toBeCloseTo(0.5, 2);
});

test('a closed box counts its front faces once: opaque and transparent boxes read 1 each', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    const solid = new T.Mesh(new T.BoxGeometry(4, 4, 4), new T.MeshBasicMaterial());
    const glass = new T.Mesh(new T.BoxGeometry(3, 3, 3), new T.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
    for (const m of [solid, glass]) m.frustumCulled = false;
    f.scene.add(solid, glass);
    return f.measureOverdraw(cam);
  });
  expect(r.opaque).toBeCloseTo(1, 2);
  expect(r.transparent).toBeCloseTo(1, 2);
});

test('measuring while the app renders changes nothing: the counts match a still measurement', async ({ forge }) => {
  await forge.open('empty', { animate: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const quad = (z: number, transparent: boolean) => {
      const m = new T.Mesh(new T.PlaneGeometry(2, 2), new T.MeshBasicMaterial({ transparent, opacity: 0.5 }));
      m.position.z = z;
      m.frustumCulled = false;
      return m;
    };
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    const probe = quad(0, false);
    f.scene.add(probe, quad(1, true), quad(2, true));
    // What each app render (the harness camera: the animation loop and frame()) sees, compared with a render before any
    // measurement. The count renders use `cam` and are not recorded.
    const renderer = f.renderer;
    const stateOf = () => [
      f.scene.overrideMaterial,
      f.scene.background,
      (f.scene as { backgroundNode?: unknown }).backgroundNode,
      renderer.getRenderTarget(),
      renderer.getRenderObjectFunction(),
      renderer.getMRT(),
      renderer.autoClear,
      renderer.opaque,
      renderer.transparent,
    ];
    let baseline: unknown[] | null = null;
    let measuring = false;
    const during: boolean[] = [];
    probe.onBeforeRender = (_renderer, _scene, camera) => {
      if (camera !== f.camera) return;
      const now = stateOf();
      if (baseline === null) baseline = now;
      else if (measuring) during.push(now.every((value, i) => value === baseline![i]));
    };
    f.frame();
    measuring = true;
    const pending = f.measureOverdraw(cam);
    const frame = f.frame(); // renders while both read-backs are still pending
    const measured = await pending;
    measuring = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.setAnimationLoop(null);
    const still = await f.measureOverdraw(cam);
    return {
      measured,
      still,
      during,
      sceneSubmissions: frame.totals.sceneSubmissions,
      unattributed: frame.totals.unattributed,
    };
  });
  expect(r.during.length).toBeGreaterThan(0);
  expect(r.during.every(Boolean)).toBe(true);
  expect(r.sceneSubmissions).toBe(3);
  expect(r.unattributed).toBe(0);
  expect(r.measured.opaque).toBeCloseTo(r.still.opaque, 2);
  expect(r.measured.transparent).toBeCloseTo(r.still.transparent, 2);
  expect(r.still.opaque).toBeCloseTo(1, 2);
  expect(r.still.transparent).toBeCloseTo(2, 2);
});

test('occlusion proxies and batch colours leave the count alone: compiled measures like naive', async ({ forge }) => {
  await forge.open('empty', { occlusion: '1' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    f.camera.position.set(0, 0, 5);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
    // A 4 x 4 wall of static cubes in two colours filling the view. The compiler batches it, and the batch's occlusion proxy
    // (colorWrite off) is a box whose front face lies on the cubes' front faces.
    const cube = new T.BoxGeometry(0.5, 0.5, 0.5);
    const colours = [new T.MeshBasicMaterial({ color: 0x802010 }), new T.MeshBasicMaterial({ color: 0x103080 })];
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const m = new T.Mesh(cube, colours[(x + y) % 2]!);
        m.name = `cube-${x}-${y}`;
        m.position.set(x * 0.5 - 0.75, y * 0.5 - 0.75, 0);
        m.userData.forge = 'static';
        f.scene.add(m);
      }
    }
    f.scene.updateMatrixWorld(true);
    const naive = await f.measureOverdraw(cam);
    const report = f.compile();
    const wait = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    let frame = f.frame();
    for (let i = 0; i < 4; i++) {
      await wait();
      frame = f.frame();
    }
    const compiled = await f.measureOverdraw(cam);
    return {
      naive,
      compiled,
      batches: f.world.batchedMeshes.length,
      proxies: report.occlusion?.proxies ?? 0,
      proxySubmissions: frame.byReason['occlusion-proxy']?.submissions ?? 0,
      sceneSubmissions: frame.totals.sceneSubmissions,
    };
  });
  expect(r.batches).toBeGreaterThan(0);
  expect(r.proxies).toBeGreaterThan(0);
  expect(r.proxySubmissions).toBeGreaterThan(0);
  expect(r.naive.opaque).toBeCloseTo(1, 2);
  expect(r.naive.transparent).toBeCloseTo(0, 2);
  expect(r.compiled.opaque).toBeCloseTo(r.naive.opaque, 2);
  expect(r.compiled.transparent).toBeCloseTo(r.naive.transparent, 2);
});

test('16 tilted sprites an eighth of the view wide read 0.25, naive and compiled alike', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    // Orthographic and tilted over the field: every billboard faces the camera, so a sprite of scale 0.25 (an eighth of
    // the 2 x 2 view's width) covers 16 x 12 texels of the 128 x 96 target wherever it lands, 1/64 of it: 16 read 0.25.
    const ortho = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    ortho.position.set(4, 5, 6);
    ortho.lookAt(0, 0, 0);
    ortho.updateMatrixWorld();
    // The harness perspective camera, tilted too: no closed-form coverage, but naive and compiled must agree.
    f.camera.position.set(1.5, 2, 2.5);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
    const material = new T.SpriteMaterial({ color: 0x406080, transparent: true, depthWrite: false });
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        const sprite = new T.Sprite(material);
        sprite.name = `sprite-${x}-${z}`;
        sprite.position.set((x - 1.5) * 0.3, 0, (z - 1.5) * 0.3);
        sprite.scale.set(0.25, 0.25, 1);
        f.scene.add(sprite);
      }
    }
    f.scene.updateMatrixWorld(true);
    const naive = { ortho: await f.measureOverdraw(ortho), perspective: await f.measureOverdraw(f.camera) };
    const report = f.compile();
    await f.frameAsync();
    const frame = f.frame();
    const compiled = { ortho: await f.measureOverdraw(ortho), perspective: await f.measureOverdraw(f.camera) };
    return {
      naive,
      compiled,
      spriteBatches: report.after.spriteBatches,
      batchSubmissions: frame.byReason['sprite-batch']?.submissions ?? 0,
      sprites: frame.byReason.sprite?.submissions ?? 0,
    };
  });
  expect(r.spriteBatches).toBe(1);
  expect([r.batchSubmissions, r.sprites]).toEqual([1, 0]);
  expect(r.naive.ortho.transparent).toBeCloseTo(0.25, 2);
  expect(r.compiled.ortho.transparent).toBeCloseTo(r.naive.ortho.transparent, 2);
  expect(r.naive.perspective.transparent).toBeGreaterThan(0.01);
  expect(r.compiled.perspective.transparent).toBeCloseTo(r.naive.perspective.transparent, 2);
  for (const measured of [r.naive.ortho, r.naive.perspective, r.compiled.ortho, r.compiled.perspective])
    expect(measured.opaque).toBeCloseTo(0, 2);
});

test('node alpha counts: maskNode and opacityNode + alphaTestNode cutouts each read 0.5', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const W = f.webgpu;
    const { uv, step, float } = W.TSL;
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    const plane = new T.PlaneGeometry(2, 2);
    // Both keep the right half of the quad: uv.x at the 128 texel centres is never exactly 0.5.
    const masked = new W.MeshBasicNodeMaterial();
    masked.maskNode = uv().x.greaterThan(0.5);
    const faded = new W.MeshBasicNodeMaterial({ transparent: true });
    faded.opacityNode = step(0.5, uv().x);
    faded.alphaTestNode = float(0.5);
    const opaque = new T.Mesh(plane, masked);
    const transparent = new T.Mesh(plane, faded);
    transparent.position.z = 1;
    for (const m of [opaque, transparent]) m.frustumCulled = false;
    f.scene.add(opaque, transparent);
    return f.measureOverdraw(cam);
  });
  expect(r.opaque).toBeCloseTo(0.5, 2);
  expect(r.transparent).toBeCloseTo(0.5, 2);
});
