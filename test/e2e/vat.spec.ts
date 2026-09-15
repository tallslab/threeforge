import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/**
 * A two-part rig whose parts sit at different offsets from the character root: a Kenney mini character with its head
 * part moved off the root (`vatPartOffset`; every Kenney part sits at the root). Bound in attached mode, the skinned
 * original draws the same wherever its parts sit, so its AnimatedInstances twin must draw each part at that part's own
 * offset to match it. Like for like: one frame of the original alone and one of the twin alone, at the same place, clip
 * and time (0.5 s of `walk`, baked frame 15 at 30 fps, so the mixer and the texture hold the same pose), framed close.
 */
test('vat: a two-part character whose parts sit at different offsets looks like its skinned original', async ({ forge }) => {
  test.setTimeout(120_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('vat', { vatClip: 'walk', vatTime: '0.5', vatPartOffset: '0.2,0.3,0' });
  const parts = await forge.page.evaluate(() => window.__forge.vat!.animation.parts.map((p) => Array.from(p.matrix.elements)));
  expect(parts).toHaveLength(2);
  expect(parts[0]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(parts[1]!.slice(12, 15).map((v) => Number(v.toFixed(6)))).toEqual([0.2, 0.3, 0]);
  const shot = async (show: 'original' | 'vat' | 'none') => {
    await forge.page.evaluate(async (which) => {
      const f = window.__forge;
      const vat = f.vat!;
      const original = f.scene.children.find((o) => !(o as { isLight?: boolean }).isLight && !vat.meshes.includes(o as never))!;
      // The twin moves onto the original's place (x = -1), and the camera frames that place close.
      vat.setMatrixAt(0, new f.three.Matrix4().makeTranslation(-1, 0, 0));
      original.visible = which === 'original';
      for (const mesh of vat.meshes) mesh.visible = which === 'vat';
      f.camera.position.set(-1, 0.4, 1.05);
      f.camera.lookAt(-1, 0.34, 0);
      f.camera.updateMatrixWorld();
      for (let i = 0; i < 4; i++) await f.frameAsync();
    }, show);
    return forge.page.screenshot({ type: 'png' });
  };
  const original = await shot('original');
  const vat = await shot('vat');
  const empty = await shot('none');
  const cover = pixelDiff(original, empty);
  const likeness = pixelDiff(original, vat);
  console.log(`vat two-part: character covers ${(cover * 100).toFixed(2)}% · original vs vat ${(likeness * 100).toFixed(2)}%`);
  // The character fills enough of the frame for a displaced part to show.
  expect(cover).toBeGreaterThan(0.1);
  expect(likeness).toBeLessThan(0.03);
});
