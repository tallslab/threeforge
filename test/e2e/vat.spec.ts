import { PNG } from 'pngjs';
import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/**
 * A two-part rig whose parts sit at different offsets from the character root: a Kenney mini character with its head
 * part moved off the root (`vatPartOffset`; every Kenney part sits at the root). Bound in attached mode, the skinned
 * original draws the same wherever its parts sit, so its AnimatedInstances twin must draw each part at that part's own
 * offset to match it. Like for like: one frame of the original alone and one of the twin alone, at the same place, clip
 * and time (0.5 s of `walk`, baked frame 15 at 30 fps, so the mixer and the texture hold the same pose), framed close.
 *
 * The placement carries a y rotation rather than being a bare translation. `AnimatedInstances` builds each part's model
 * matrix as `instanceMatrix.mul(offset)` (src/skinning/AnimatedInstances.ts ~113); two translations commute, so under a
 * pure translation a reordered `offset.mul(instanceMatrix)` draws exactly the same picture and this test would pass
 * straight through that bug. A rotation does not commute with the part offset, so the order is pinned. The likeness is
 * measured on a lit surface as well, so the normals built from that same matrix (`normalLocal`, ~114) have to be right.
 */

/** Luminance spread across the pixels the character covers. A flat or unlit surface would have almost none. */
function litSpread(shot: Buffer, empty: Buffer): { spread: number; covered: number } {
  const a = PNG.sync.read(shot);
  const b = PNG.sync.read(empty);
  let min = 255;
  let max = 0;
  let covered = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.data[o]! - b.data[o]!), Math.abs(a.data[o + 1]! - b.data[o + 1]!), Math.abs(a.data[o + 2]! - b.data[o + 2]!));
    if (d <= 24) continue;
    covered++;
    const l = 0.2126 * a.data[o]! + 0.7152 * a.data[o + 1]! + 0.0722 * a.data[o + 2]!;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return { spread: covered === 0 ? 0 : max - min, covered };
}

test('vat: a two-part character whose parts sit at different offsets looks like its skinned original, under a placement that does not commute with those offsets', async ({ forge }) => {
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
      // Both go to the original's place (x = -1), and both are turned by the same y rotation, which is what makes the
      // placement fail to commute with the part offset. The camera frames that place close.
      const turn = new f.three.Quaternion().setFromAxisAngle(new f.three.Vector3(0, 1, 0), 0.9);
      vat.setMatrixAt(0, new f.three.Matrix4().compose(new f.three.Vector3(-1, 0, 0), turn, new f.three.Vector3(1, 1, 1)));
      original.position.set(-1, 0, 0);
      original.quaternion.copy(turn);
      original.updateMatrixWorld(true);
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
  // The placement really does carry a rotation: with a pure translation the multiply order would go untested.
  const placement = await forge.page.evaluate(() => Array.from(window.__forge.vat!.getMatrixAt(0, new window.__forge.three.Matrix4()).elements));
  expect(Math.abs(placement[0]! - 1), 'the placement must not be a pure translation').toBeGreaterThan(0.1);
  const cover = pixelDiff(original, empty);
  const likeness = pixelDiff(original, vat);
  const lit = litSpread(original, empty);
  console.log(`vat two-part: character covers ${(cover * 100).toFixed(2)}% · original vs vat ${(likeness * 100).toFixed(2)}% · lit spread ${lit.spread.toFixed(1)} over ${lit.covered} px`);
  // The character fills enough of the frame for a displaced part to show.
  expect(cover).toBeGreaterThan(0.1);
  // It is shaded rather than flat, so a wrongly built normal matrix would move these pixels too.
  expect(lit.spread, 'the character must be visibly lit for its normals to matter').toBeGreaterThan(40);
  expect(likeness).toBeLessThan(0.03);
});
