import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

/** Sprite batching must not change a pixel: every case compares the naive render with the compiled one. */

test('the lake: 2000 raindrop sprites become one submission per pass and decompile at parity', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('lake', { variant: 'naive', freeze: '1' });
  await settle(forge.page);
  const naive = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.bench?.setTime?.(0.5);
    const frame = await f.frameAsync();
    return {
      submissions: frame.totals.sceneSubmissions,
      sprites: frame.byReason.sprite?.submissions ?? 0,
      particles: frame.overdraw.particles,
      hints: frame.hints.map((h) => h.code),
    };
  });
  const before = await forge.page.screenshot({ type: 'png' });
  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return {
      spriteBatches: report.after.spriteBatches,
      submissions: frame.totals.sceneSubmissions,
      batch: frame.byReason['sprite-batch']?.submissions ?? 0,
      sprites: frame.byReason.sprite?.submissions ?? 0,
      particles: frame.overdraw.particles,
      unattributed: frame.totals.unattributed,
    };
  });
  const after = await forge.page.screenshot({ type: 'png' });
  // Main pass plus the water's reflection pass (which sees fewer drops).
  expect(naive.sprites).toBeGreaterThanOrEqual(2000);
  expect(naive.hints).toContain('sprites-unbatched');
  expect(compiled.spriteBatches).toBe(1);
  expect(compiled.sprites).toBe(0);
  // Main pass plus the water's reflection pass each draw the batch once.
  expect(compiled.batch).toBe(2);
  expect(compiled.submissions).toBeLessThan(120);
  expect(compiled.unattributed).toBe(0);
  // The batch culls per instance like three culls sprites: the same drops are drawn.
  expect(compiled.particles).toBe(naive.particles);
  expect(naive.particles).toBeLessThan(2000);
  const diff = pixelDiff(before, after);
  console.log(
    `lake sprite batch pixel diff ${(diff * 100).toFixed(3)}% · submissions ${naive.submissions} -> ${compiled.submissions}`,
  );
  expect(diff).toBeLessThan(0.005);
  const restored = await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.decompile();
    const frame = await f.frameAsync();
    return frame.byReason.sprite?.submissions ?? 0;
  });
  expect(restored).toBe(naive.sprites);
});

// @corpus: the health bars and hit markers are attached only to `fighter-*` / `blocky-*` objects, and those come
// from the Kenney kits through buildArena. Without the kits the arena is empty, so `naiveSprites >= 16` and
// `spriteBatches === 2` below fail on a kit-less runner.
test('the bossfight: health bars and hit markers become two batches among the effects', { tag: '@corpus' }, async ({
  forge,
}) => {
  await forge.open('bossfight', { variant: 'naive' });
  await settle(forge.page);
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const naive = await f.frameAsync();
    const report = f.compile();
    await f.world.warmup(f.renderer, f.camera);
    for (let i = 0; i < 3; i++) await f.frameAsync();
    const frame = await f.frameAsync();
    return {
      naiveSprites: naive.byReason.sprite?.submissions ?? 0,
      spriteBatches: report.after.spriteBatches,
      batches: frame.byReason['sprite-batch']?.submissions ?? 0,
      sprites: frame.byReason.sprite?.submissions ?? 0,
      unattributed: frame.totals.unattributed,
      particles: frame.overdraw.particles,
    };
  });
  expect(r.naiveSprites).toBeGreaterThanOrEqual(16);
  expect(r.spriteBatches).toBe(2);
  expect(r.sprites).toBe(0);
  expect(r.batches).toBeGreaterThanOrEqual(2);
  expect(r.unattributed).toBe(0);
  expect(r.particles).toBeGreaterThan(7000);
});

for (const mirrored of [false, true] as const) {
  test(`sprites with an alphaMap compile at parity in ${mirrored ? 'a mirrored' : 'an unmirrored'} scene: the batch material takes every field of the sprites' material`, async ({
    forge,
  }) => {
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
    await forge.open('empty');
    await forge.page.evaluate((mirror) => {
      const f = window.__forge;
      const T = f.three;
      // A 4x4 checker alpha map: the alpha-tested material cuts half of each quad away, the blended one fades it.
      const data = new Uint8Array(4 * 4 * 4);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const v = (x + y) % 2 === 0 ? 255 : 40;
          data.set([v, v, v, 255], (y * 4 + x) * 4);
        }
      }
      const alphaMap = new T.DataTexture(data, 4, 4);
      alphaMap.magFilter = T.NearestFilter;
      alphaMap.minFilter = T.NearestFilter;
      alphaMap.needsUpdate = true;
      const materials = [
        new T.SpriteMaterial({ color: 0xff6040, alphaMap, alphaTest: 0.5, transparent: false }),
        new T.SpriteMaterial({ color: 0x40a0ff, alphaMap, transparent: true, depthWrite: false }),
      ];
      for (let x = 0; x < 8; x++) {
        for (let z = 0; z < 6; z++) {
          const sprite = new T.Sprite(materials[(x + z) % 2]!);
          sprite.name = `sprite-${x}-${z}`;
          sprite.position.set((x - 3.5) * 14, 6, (z - 2.5) * 14);
          sprite.scale.set(8, 5, 1);
          f.scene.add(sprite);
        }
      }
      if (mirror) f.scene.scale.x = -1;
      f.scene.updateMatrixWorld(true);
    }, mirrored);
    await settle(forge.page);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const report = f.compile();
      await f.world.warmup(f.renderer, f.camera);
      for (let i = 0; i < 3; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return {
        spriteBatches: report.after.spriteBatches,
        drawn: frame.byReason['sprite-batch']?.submissions ?? 0,
        sprites: frame.byReason.sprite?.submissions ?? 0,
        unattributed: frame.totals.unattributed,
      };
    });
    const after = await forge.page.screenshot({ type: 'png' });
    const diff = pixelDiff(before, after, { threshold: 4 });
    console.log(`alphaMap sprite grid mirrored=${mirrored} pixel diff ${(diff * 100).toFixed(4)}%`);
    expect(r.spriteBatches).toBe(2);
    expect(r.drawn).toBe(2);
    expect(r.sprites).toBe(0);
    expect(r.unattributed).toBe(0);
    expect(diff).toBeLessThan(0.0005);
  });
}
