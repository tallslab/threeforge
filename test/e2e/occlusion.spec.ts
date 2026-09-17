import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

test('occlusion proxies hide chunk batches behind a wall after the query results arrive', async ({ forge }) => {
  await forge.open('naive', { compile: '1', chunk: '40', occlusion: '1', wall: '1' });
  const result = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const first = f.frame().totals;
    const proxies = f.frame().byReason['occlusion-proxy']?.submissions ?? 0;
    // Query results are resolved asynchronously; give the renderer a few frames.
    const wait = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
    let settled = first;
    for (let i = 0; i < 6; i++) {
      await wait();
      settled = f.frame().totals;
    }
    const byReason = f.frame().byReason;
    return { first, settled, proxies, batchedFirst: first.sceneSubmissions, byReason, report: f.ledger.report() };
  });
  console.log(result.report);
  expect(result.proxies).toBeGreaterThan(4);
  expect(result.settled.unattributed).toBe(0);
  expect(result.settled.sceneSubmissions).toBeLessThan(result.first.sceneSubmissions);
  expect(result.byReason['occlusion-proxy']?.submissions).toBe(result.proxies);
});

/*
 * The cells below build their scene on `empty` (unlit materials, so the naive render is exact) and each adds a group
 * behind a wall whose proxy the wall covers: it must end up hidden, which shows the queries run on the backend.
 * Every batch that must stay visible is read after each of 12 frames, and the compiled frame is compared with the
 * same view decompiled (threshold 4, bar 0.05 %).
 */
const FRAMES = 12;

/**
 * Runs in the page (it must not use anything outside itself). A solid 10 x 10 slab of cubes at z = 0; four corner cubes
 * stand out at z = 1, so the box's front face (z = 1.5) is ahead of the slab and its back face (z = -0.5) behind it. A
 * black wall at z = 5 with a 6 x 6 window shows only the middle of the slab and covers the box's edges. Behind the wall's
 * solid part, `hidden-*` cubes with another material form the control group. The camera looks through the window.
 */
function windowScene(mirror: boolean): void {
  const f = window.__forge;
  const T = f.three;
  const cube = new T.BoxGeometry(1, 1, 1);
  const colours = [new T.MeshBasicMaterial({ color: 0xe0a040 }), new T.MeshBasicMaterial({ color: 0x40a0e0 })];
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < 10; y++) {
      const m = new T.Mesh(cube, colours[(x + y) % 2]!);
      m.name = `slab-${x}-${y}`;
      m.position.set(x - 4.5, y - 4.5, 0);
      m.userData.forge = 'static';
      f.scene.add(m);
    }
  }
  for (const [x, y] of [
    [-4.5, -4.5],
    [4.5, -4.5],
    [-4.5, 4.5],
    [4.5, 4.5],
  ] as const) {
    const m = new T.Mesh(cube, colours[0]!);
    m.name = `corner-${x}-${y}`;
    m.position.set(x, y, 1);
    m.userData.forge = 'static';
    f.scene.add(m);
  }
  const black = new T.MeshLambertMaterial({ color: 0x000000 });
  for (const [w, h, x, y] of [
    [80, 40, 0, 23],
    [80, 40, 0, -23],
    [37, 6, -21.5, 0],
    [37, 6, 21.5, 0],
  ] as const) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, 0.5), black);
    m.name = `wall-${x}-${y}`;
    m.position.set(x, y, 5);
    m.userData.forge = 'static';
    f.scene.add(m);
  }
  const normal = new T.MeshNormalMaterial();
  for (let i = 0; i < 4; i++) {
    const m = new T.Mesh(cube, normal);
    m.name = `hidden-${i}`;
    m.position.set(12 + i * 1.5, 0, 0);
    m.userData.forge = 'static';
    f.scene.add(m);
  }
  f.camera.position.set(0, 0, 20);
  f.camera.lookAt(0, 0, 0);
  f.camera.updateMatrixWorld();
  if (mirror) f.scene.scale.x = -1;
  f.scene.updateMatrixWorld(true);
}

test('the camera inside a batch box keeps the batch visible, and queries issued from inside never hide it after the camera leaves', async ({
  forge,
}) => {
  await forge.open('empty', { occlusion: '1' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    // A ring of pillars around the eye: one batch whose box (x, z -13..13, y 0..8) holds the camera.
    const pillar = new T.BoxGeometry(2, 8, 2);
    const colours = [new T.MeshBasicMaterial({ color: 0xd08040 }), new T.MeshBasicMaterial({ color: 0x4080d0 })];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const m = new T.Mesh(pillar, colours[i % 2]!);
      m.name = `ring-${i}`;
      m.position.set(Math.cos(a) * 12, 4, Math.sin(a) * 12);
      m.userData.forge = 'static';
      f.scene.add(m);
    }
    const wall = new T.Mesh(new T.BoxGeometry(2, 80, 100), new T.MeshLambertMaterial({ color: 0x607080 }));
    wall.name = 'wall';
    wall.position.set(40, 20, 0);
    wall.userData.forge = 'static';
    f.scene.add(wall);
    const cube = new T.BoxGeometry(3, 3, 3);
    const normal = new T.MeshNormalMaterial();
    for (let i = 0; i < 6; i++) {
      const m = new T.Mesh(cube, normal);
      m.name = `hidden-${i}`;
      m.position.set(60, 2 + (i % 3) * 4, -8 + i * 3);
      m.userData.forge = 'static';
      f.scene.add(m);
    }
  });
  const place = (where: 'inside' | 'outside') =>
    forge.page.evaluate((w) => {
      const c = window.__forge.camera;
      if (w === 'inside') {
        c.position.set(0, 4, 0);
        c.lookAt(40, 4, 0);
      } else {
        c.position.set(0, 6, -45);
        c.lookAt(0, 4, 0);
      }
      c.updateMatrixWorld();
    }, where);
  await place('inside');
  const inside = await forge.page.evaluate(async (frames) => {
    const f = window.__forge;
    const report = f.compile();
    const ring = f.world.slotOf(f.scene.getObjectByName('ring-0') as never)!.batch as unknown as {
      visible: boolean;
      boundingBox: { containsPoint(p: unknown): boolean };
    };
    const hidden = f.world.slotOf(f.scene.getObjectByName('hidden-0') as never)!.batch;
    const visible: boolean[] = [];
    for (let i = 0; i < frames; i++) {
      await f.frameAsync();
      visible.push(ring.visible);
    }
    return {
      proxies: report.occlusion?.proxies ?? 0,
      eyeInBox: ring.boundingBox.containsPoint(f.camera.position),
      visible,
      hiddenVisible: hidden.visible,
    };
  }, FRAMES);
  const compiledInside = await forge.page.screenshot({ type: 'png' });
  await place('outside');
  const outside = await forge.page.evaluate(async (frames) => {
    const f = window.__forge;
    const ring = f.world.slotOf(f.scene.getObjectByName('ring-0') as never)!.batch;
    const visible: boolean[] = [];
    for (let i = 0; i < frames; i++) {
      await f.frameAsync();
      visible.push(ring.visible);
    }
    return { visible };
  }, FRAMES);
  const compiledOutside = await forge.page.screenshot({ type: 'png' });
  await forge.page.evaluate(() => window.__forge.decompile());
  await place('inside');
  await forge.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
  });
  const naiveInside = await forge.page.screenshot({ type: 'png' });
  await place('outside');
  await forge.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
  });
  const naiveOutside = await forge.page.screenshot({ type: 'png' });

  expect(inside.proxies).toBe(2);
  expect(inside.eyeInBox).toBe(true);
  expect(inside.hiddenVisible, 'the group behind the wall is culled: queries run on this backend').toBe(false);
  expect(inside.visible, 'the batch around the camera, frame by frame').toEqual(new Array(FRAMES).fill(true));
  expect(outside.visible, 'the same batch after the camera left its box, frame by frame').toEqual(
    new Array(FRAMES).fill(true),
  );
  if (forge.pixelChecks) {
    const diffInside = pixelDiff(naiveInside, compiledInside, { threshold: 4 });
    const diffOutside = pixelDiff(naiveOutside, compiledOutside, { threshold: 4 });
    console.log(
      `camera inside a batch box: pixel diff inside ${(diffInside * 100).toFixed(4)}%, after leaving ${(diffOutside * 100).toFixed(4)}%`,
    );
    expect(diffInside).toBeLessThan(0.0005);
    expect(diffOutside).toBeLessThan(0.0005);
  }
});

for (const mirrored of [false, true] as const) {
  test(`a batch seen through a window stays visible in ${mirrored ? 'a mirrored' : 'an unmirrored'} scene`, async ({
    forge,
  }) => {
    await forge.open('empty', { occlusion: '1' });
    await forge.page.evaluate(windowScene, mirrored);
    const r = await forge.page.evaluate(async (frames) => {
      const f = window.__forge;
      const report = f.compile();
      const slab = f.world.slotOf(f.scene.getObjectByName('slab-0-0') as never)!.batch;
      const hidden = f.world.slotOf(f.scene.getObjectByName('hidden-0') as never)!.batch;
      const visible: boolean[] = [];
      for (let i = 0; i < frames; i++) {
        await f.frameAsync();
        visible.push(slab.visible);
      }
      return {
        proxies: report.occlusion?.proxies ?? 0,
        mirrored: f.scene.matrixWorld.determinant() < 0,
        visible,
        hiddenVisible: hidden.visible,
      };
    }, FRAMES);
    const compiled = await forge.page.screenshot({ type: 'png' });
    await forge.page.evaluate(async () => {
      const f = window.__forge;
      f.decompile();
      for (let i = 0; i < 3; i++) await f.frameAsync();
    });
    const naive = await forge.page.screenshot({ type: 'png' });

    expect(r.mirrored).toBe(mirrored);
    expect(r.proxies, 'slab, wall and the hidden group').toBe(3);
    expect(r.hiddenVisible, 'the group behind the wall is culled: queries run on this backend').toBe(false);
    expect(r.visible, 'the slab seen through the window, frame by frame').toEqual(new Array(FRAMES).fill(true));
    if (forge.pixelChecks) {
      const diff = pixelDiff(naive, compiled, { threshold: 4 });
      console.log(`slab through a window, mirrored=${mirrored}: pixel diff ${(diff * 100).toFixed(4)}%`);
      expect(diff).toBeLessThan(0.0005);
    }
  });
}

for (const mode of ['frame', 'async'] as const) {
  test(`warmup (${mode}) issues no occlusion queries: a batch seen through a window stays visible in the frames after it`, async ({
    forge,
  }) => {
    await forge.open('empty', { occlusion: '1' });
    await forge.page.evaluate(windowScene, false);
    const r = await forge.page.evaluate(
      async ({ frames, warmupMode }) => {
        const f = window.__forge;
        const report = f.compile();
        const slab = f.world.slotOf(f.scene.getObjectByName('slab-0-0') as never)!.batch;
        const hidden = f.world.slotOf(f.scene.getObjectByName('hidden-0') as never)!.batch;
        // The documented step after compile(): its frame renders under a 1x1 scissor.
        const warm = await f.world.warmup(f.renderer, f.camera, { mode: warmupMode });
        const proxies = f.scene.children.filter(
          (o) => (o.userData.forge as { kind?: string } | undefined)?.kind === 'occlusion-proxy',
        );
        const proxiesOn = proxies.every((o) => (o as unknown as { occlusionTest: boolean }).occlusionTest === true);
        const visible: boolean[] = [];
        for (let i = 0; i < frames; i++) {
          await f.frameAsync();
          visible.push(slab.visible);
        }
        return {
          mode: warm.mode,
          proxies: report.occlusion?.proxies ?? 0,
          proxiesOn,
          visible,
          hiddenVisible: hidden.visible,
        };
      },
      { frames: FRAMES, warmupMode: mode },
    );
    const compiled = await forge.page.screenshot({ type: 'png' });
    await forge.page.evaluate(async () => {
      const f = window.__forge;
      f.decompile();
      for (let i = 0; i < 3; i++) await f.frameAsync();
    });
    const naive = await forge.page.screenshot({ type: 'png' });

    expect(r.mode).toBe(mode);
    expect(r.proxies, 'slab, wall and the hidden group').toBe(3);
    expect(r.proxiesOn, 'every proxy queries again after warmup').toBe(true);
    expect(r.hiddenVisible, 'the group behind the wall is culled: queries run on this backend').toBe(false);
    expect(r.visible, 'the slab seen through the window, frame by frame after warmup').toEqual(
      new Array(FRAMES).fill(true),
    );
    if (forge.pixelChecks) {
      const diff = pixelDiff(naive, compiled, { threshold: 4 });
      console.log(`slab through a window after warmup (${mode}): pixel diff ${(diff * 100).toFixed(4)}%`);
      expect(diff).toBeLessThan(0.0005);
    }
  });
}

test('a batch-synced mover that leaves its batch box stays visible: batches holding synced movers get no proxy', async ({
  forge,
}) => {
  await forge.open('empty', { occlusion: '1', dynamics: 'batch-sync' });
  await forge.page.evaluate(() => {
    const f = window.__forge;
    const T = f.three;
    const cube = new T.BoxGeometry(2, 2, 2);
    // A black wall over the left half of the view, and behind it a group of cubes, one of them a batch-synced mover.
    const wall = new T.Mesh(new T.BoxGeometry(60, 40, 1), new T.MeshLambertMaterial({ color: 0x000000 }));
    wall.name = 'wall';
    wall.position.set(-30, 0, 10);
    wall.userData.forge = 'static';
    f.scene.add(wall);
    const orange = new T.MeshBasicMaterial({ color: 0xd08040 });
    for (let i = 0; i < 6; i++) {
      const m = new T.Mesh(cube, orange);
      m.name = `group-${i}`;
      m.position.set(-20 + (i % 3) * 3, -3 + Math.floor(i / 3) * 3, 0);
      m.userData.forge = 'static';
      f.scene.add(m);
    }
    const mover = new T.Mesh(cube, orange);
    mover.name = 'mover';
    mover.position.set(-17, 3, 0);
    mover.userData.forge = 'dynamic';
    f.scene.add(mover);
    const normal = new T.MeshNormalMaterial();
    for (let i = 0; i < 4; i++) {
      const m = new T.Mesh(cube, normal);
      m.name = `hidden-${i}`;
      m.position.set(-12 + i * 2.5, -8, 0);
      m.userData.forge = 'static';
      f.scene.add(m);
    }
    f.camera.position.set(0, 0, 40);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
  });
  const r = await forge.page.evaluate(async (frames) => {
    const f = window.__forge;
    const report = f.compile();
    const mover = f.scene.getObjectByName('mover')!;
    const holder = f.world.slotOf(mover as never)!.batch;
    const group = f.world.slotOf(f.scene.getObjectByName('group-0') as never)!.batch;
    const hidden = f.world.slotOf(f.scene.getObjectByName('hidden-0') as never)!.batch;
    for (let i = 0; i < 8; i++) await f.frameAsync();
    // The mover leaves its batch's box for the open right half of the view, and grows so it is easy to see.
    mover.position.set(12, 4, 0);
    mover.scale.setScalar(3);
    const visible: boolean[] = [];
    for (let i = 0; i < frames; i++) {
      await f.frameAsync();
      visible.push(holder.visible);
    }
    return {
      synced: report.synced,
      occlusion: report.occlusion,
      sameBatch: holder === group,
      visible,
      hiddenVisible: hidden.visible,
    };
  }, FRAMES);
  const compiled = await forge.page.screenshot({ type: 'png' });
  await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.decompile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
  });
  const naive = await forge.page.screenshot({ type: 'png' });

  expect(r.synced).toBe(1);
  expect(r.sameBatch, 'the mover shares its batch with the group behind the wall').toBe(true);
  expect(r.hiddenVisible, 'the group behind the wall is culled: queries run on this backend').toBe(false);
  expect(r.visible, 'the batch holding the mover, frame by frame after it moved').toEqual(new Array(FRAMES).fill(true));
  if (forge.pixelChecks) {
    const diff = pixelDiff(naive, compiled, { threshold: 4 });
    console.log(`synced mover out of its box: pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(diff).toBeLessThan(0.0005);
  }
  expect(r.occlusion, 'only the group without movers has a proxy; the mover batch is counted as skipped').toEqual({
    proxies: 1,
    skippedSynced: 1,
  });
});
