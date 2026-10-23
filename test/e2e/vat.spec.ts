import { PNG } from 'pngjs';
import { expect, type ForgePage, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/**
 * A two-part rig whose parts sit at different offsets from the character root (a Kenney mini character with its head
 * moved off the root via `vatPartOffset`). Bound in attached mode the skinned original draws the same wherever its
 * parts sit, so its AnimatedInstances twin must draw each part at its own offset: one frame of each alone, same place,
 * clip and time (0.5 s of `walk`, baked frame 15 at 30 fps). The placement carries a y rotation because
 * `AnimatedInstances` builds each part's matrix as `instanceMatrix.mul(offset)` (src/skinning/AnimatedInstances.ts
 * ~113) and two translations commute. Normals are not pinned (the offset's upper 3x3 is the identity, `normalLocal`
 * ~118); `litSpread` only catches normals that ignore the instance rotation altogether.
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
    const d = Math.max(
      Math.abs(a.data[o]! - b.data[o]!),
      Math.abs(a.data[o + 1]! - b.data[o + 1]!),
      Math.abs(a.data[o + 2]! - b.data[o + 2]!),
    );
    if (d <= 24) continue;
    covered++;
    const l = 0.2126 * a.data[o]! + 0.7152 * a.data[o + 1]! + 0.0722 * a.data[o + 2]!;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return { spread: covered === 0 ? 0 : max - min, covered };
}

test('vat: parts at different offsets match the skinned original under a non-commuting placement', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(120_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('vat', { vatClip: 'walk', vatTime: '0.5', vatPartOffset: '0.2,0.3,0' });
  const parts = await forge.page.evaluate(() =>
    window.__forge.vat!.animation.parts.map((p) => Array.from(p.matrix.elements)),
  );
  expect(parts).toHaveLength(2);
  expect(parts[0]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(parts[1]!.slice(12, 15).map((v) => Number(v.toFixed(6)))).toEqual([0.2, 0.3, 0]);
  const shot = async (show: 'original' | 'vat' | 'none') => {
    await forge.page.evaluate(async (which) => {
      const f = window.__forge;
      const vat = f.vat!;
      const original = f.scene.children.find(
        (o) => !(o as { isLight?: boolean }).isLight && !vat.meshes.includes(o as never),
      )!;
      // Both go to the original's place (x = -1), and both are turned by the same y rotation, which is what makes the
      // placement fail to commute with the part offset. The camera frames that place close.
      const turn = new f.three.Quaternion().setFromAxisAngle(new f.three.Vector3(0, 1, 0), 0.9);
      vat.setMatrixAt(
        0,
        new f.three.Matrix4().compose(new f.three.Vector3(-1, 0, 0), turn, new f.three.Vector3(1, 1, 1)),
      );
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
  const placement = await forge.page.evaluate(() =>
    Array.from(window.__forge.vat!.getMatrixAt(0, new window.__forge.three.Matrix4()).elements),
  );
  expect(Math.abs(placement[0]! - 1), 'the placement must not be a pure translation').toBeGreaterThan(0.1);
  const cover = pixelDiff(original, empty);
  const likeness = pixelDiff(original, vat);
  const lit = litSpread(original, empty);
  console.log(
    `vat two-part: character covers ${(cover * 100).toFixed(2)}% · original vs vat ${(likeness * 100).toFixed(2)}% · lit spread ${lit.spread.toFixed(1)} over ${lit.covered} px`,
  );
  // The character fills enough of the frame for a displaced part to show.
  expect(cover).toBeGreaterThan(0.1);
  // It is shaded rather than flat, so a wrongly built normal matrix would move these pixels too.
  expect(lit.spread, 'the character must be visibly lit for its normals to matter').toBeGreaterThan(40);
  expect(likeness).toBeLessThan(0.03);
});

/** Frames the twin close at x = 1 with the original hidden, and renders that. */
async function frameTwin(forge: ForgePage): Promise<void> {
  await forge.page.evaluate(async () => {
    const f = window.__forge;
    const vat = f.vat!;
    for (const o of f.scene.children) {
      if ((o as { isLight?: boolean }).isLight) continue;
      o.visible = vat.meshes.some((mesh) => mesh === o);
    }
    f.camera.position.set(1, 0.4, 1.05);
    f.camera.lookAt(1, 0.34, 0);
    f.camera.updateMatrixWorld();
    for (let i = 0; i < 2; i++) await f.frameAsync();
  });
}

/** A clip switch: at `at` seconds (the current time when left out), with an optional fade. */
type Switch = { clip: string; at?: number; fade?: number };

/** The twin at `seconds`, after the switches. */
async function twinAt(forge: ForgePage, seconds: number, switches: Switch[]): Promise<Buffer> {
  await forge.page.evaluate(
    async ({ seconds, switches }) => {
      const f = window.__forge;
      const vat = f.vat!;
      for (const { clip, at, fade } of switches) {
        if (at !== undefined) vat.setTime(at);
        vat.setClipAt(0, clip, { fade });
      }
      vat.setTime(seconds);
      for (let i = 0; i < 2; i++) await f.frameAsync();
    },
    { seconds, switches },
  );
  return forge.page.screenshot({ type: 'png' });
}

test('vat: a crossfade starts on the clip it leaves, ends on the next', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(120_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('vat', { vatClip: 'walk' });
  await frameTwin(forge);
  const walk = (t: number) => twinAt(forge, t, [{ clip: 'walk' }]);
  const die = (t: number) => twinAt(forge, t, [{ clip: 'die' }]);
  // At 0.3 s the twin walks and starts a 0.6 s fade into `die`.
  const fading = (t: number) => twinAt(forge, t, [{ clip: 'walk' }, { clip: 'die', at: 0.3, fade: 0.6 }]);
  const start = { walk: await walk(0.3), fade: await fading(0.3) };
  const end = { die: await die(0.9), fade: await fading(0.9) };
  const middle = { walk: await walk(0.6), die: await die(0.6), fade: await fading(0.6) };
  const poses = pixelDiff(middle.walk, middle.die);
  const atStart = pixelDiff(start.walk, start.fade);
  const atEnd = pixelDiff(end.die, end.fade);
  const fromWalk = pixelDiff(middle.fade, middle.walk);
  const fromDie = pixelDiff(middle.fade, middle.die);
  console.log(
    `vat crossfade: walk vs die ${(poses * 100).toFixed(2)}% · start ${(atStart * 100).toFixed(3)}% · end ${(atEnd * 100).toFixed(3)}% · middle vs walk ${(fromWalk * 100).toFixed(2)}% · vs die ${(fromDie * 100).toFixed(2)}%`,
  );
  // The two clips are far enough apart for a blend to show.
  expect(poses).toBeGreaterThan(0.02);
  expect(atStart).toBeLessThan(0.001);
  expect(atEnd).toBeLessThan(0.001);
  // Halfway it is neither clip.
  expect(fromWalk).toBeGreaterThan(poses / 5);
  expect(fromDie).toBeGreaterThan(poses / 5);
});

test('vat: an active count of zero draws nothing, as the ledger says', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(120_000);
  await forge.open('vat', { vatClip: 'walk' });
  await frameTwin(forge);
  const state = (active: number) =>
    forge.page.evaluate(async (n) => {
      const f = window.__forge;
      f.vat!.activeCount = n;
      await f.frameAsync();
      const frame = await f.frameAsync();
      return { vatInstances: frame.skinning.vatInstances, parts: f.vat!.meshes.length };
    }, active);
  const shown = await state(1);
  const shot = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;
  const hidden = await state(0);
  const empty = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;
  const back = await state(1);
  // One instance per part: the Kenney character is a head and a body.
  expect(shown.parts).toBe(2);
  expect(shown.vatInstances).toBe(2);
  expect(hidden.vatInstances).toBe(0);
  expect(back).toEqual(shown);
  if (shot && empty) {
    await forge.page.evaluate(() => {
      for (const mesh of window.__forge.vat!.meshes) mesh.visible = false;
    });
    await forge.page.evaluate(() => window.__forge.frameAsync());
    const bare = await forge.page.screenshot({ type: 'png' });
    expect(pixelDiff(shot, bare)).toBeGreaterThan(0.02);
    expect(pixelDiff(empty, bare)).toBe(0);
  }
});

test('vat: unlit shading ignores the lights and Lambert follows them', {
  tag: '@corpus',
}, async ({ forge }) => {
  test.setTimeout(120_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const response = async (shading: string) => {
    await forge.open('vat', { vatClip: 'idle', vatTime: '0.2', vatShading: shading });
    await frameTwin(forge);
    const type = await forge.page.evaluate(() => (window.__forge.vat!.meshes[0]!.material as { type: string }).type);
    const lit = await forge.page.screenshot({ type: 'png' });
    await forge.page.evaluate(async () => {
      const f = window.__forge;
      for (const o of f.scene.children)
        if ((o as { isLight?: boolean }).isLight) (o as unknown as { intensity: number }).intensity *= 0.3;
      for (let i = 0; i < 2; i++) await f.frameAsync();
    });
    return { type, change: pixelDiff(lit, await forge.page.screenshot({ type: 'png' })) };
  };
  const unlit = await response('unlit');
  const lambert = await response('lambert');
  console.log(
    `vat shading: dimmed lights change unlit ${(unlit.change * 100).toFixed(2)}% · lambert ${(lambert.change * 100).toFixed(2)}%`,
  );
  expect(unlit.type).toBe('MeshBasicNodeMaterial');
  expect(lambert.type).toBe('MeshLambertNodeMaterial');
  expect(unlit.change).toBe(0);
  expect(lambert.change).toBeGreaterThan(0.02);
});
