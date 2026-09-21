/**
 * An animated-instances twin stepped through baked-row boundaries and clip loops beside the skinned original it was
 * baked from. Playback is nearest-lower row (`floor`, no blending between rows), so a timestamp has an exact
 * reference, the original posed at its row's time, and a loose one, the original at the timestamp itself, which the
 * twin may trail by at most the motion of one baked row. Past the end of the clip the row is the one a looping mixer
 * is in at that timestamp: the clip's duration is the period, whatever number of rows the bake holds. One twin plays
 * three legs: `walk` (20 rows, baked with two to spare), `attack-melee-right` (12.5 rows, so its last row is cut
 * short) at 1.5 × with a 0.2 s offset, then `walk` again, switched with `setClipAt` each time.
 */
import { expect, type ForgePage, test } from './fixtures.js';
import { differingPixels } from './pixels.js';
import { Sequence, type Step, shareOfContent } from './temporal.js';

const LEGS = [
  { clip: 'walk', speed: 1, offset: 0 },
  { clip: 'attack-melee-right', speed: 1.5, offset: 0.2 },
  { clip: 'walk', speed: 1, offset: 0 },
];

/**
 * Positions on a clip's own clock, in rows: either side of two row boundaries, the last rows before the loop, the
 * first after it, and one and two loops on.
 */
const positions = (loop: number): number[] => [
  5.25,
  5.75,
  6.25,
  loop - 0.75,
  loop - 0.25,
  loop + 0.25,
  loop + 1.25,
  2 * loop + 1.25,
  3 * loop + 2.25,
];

/** Opens the scene on `clip`, brings the twin to the original's place and frames it; returns the clip's loop. */
async function open(forge: ForgePage, clip: string, bakeFps = 30): Promise<{ fps: number; loop: number }> {
  await forge.open('vat', { vatClip: clip, vatFps: String(bakeFps) });
  return forge.page.evaluate((name) => {
    const f = window.__forge;
    const vat = f.vat!;
    vat.setMatrixAt(0, new f.three.Matrix4().makeTranslation(-1, 0, 0));
    f.camera.position.set(-1, 0.4, 1.05);
    f.camera.lookAt(-1, 0.34, 0);
    f.camera.updateMatrixWorld();
    const range = vat.animation.clips.find((c) => c.name === name)!;
    return { fps: vat.animation.fps, loop: range.duration * vat.animation.fps };
  }, clip);
}

/** One frame of one of the two (or neither), at `seconds` on the clock it reads. */
async function shoot(forge: ForgePage, show: 'original' | 'vat' | 'none', seconds: number): Promise<Buffer> {
  await forge.page.evaluate(
    async ({ show, seconds }) => {
      const f = window.__forge;
      const vat = f.vat!;
      f.setTime(seconds);
      for (const o of f.scene.children) {
        if ((o as { isLight?: boolean }).isLight) continue;
        o.visible = vat.meshes.some((mesh) => mesh === o) ? show === 'vat' : show === 'original';
      }
      await f.frameAsync();
    },
    { show, seconds },
  );
  return forge.page.screenshot({ type: 'png' });
}

test("vat: the twin keeps the original's time across rows, loops and clip changes", {
  tag: ['@corpus', '@temporal'],
}, async ({ forge }) => {
  test.setTimeout(300_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');

  // The original at each position of each clip: posed at the row's time, at the position itself, and one row on.
  const originals = new Map<string, Array<{ row: number; reference: Buffer; live: Buffer; next: Buffer }>>();
  let empty: Buffer | undefined;
  for (const clip of new Set(LEGS.map((leg) => leg.clip))) {
    const { fps, loop } = await open(forge, clip);
    await shoot(forge, 'original', 0.1);
    empty ??= await shoot(forge, 'none', 0);
    const shots = [];
    for (const u of positions(loop)) {
      const row = Math.floor(u % loop);
      shots.push({
        row,
        reference: await shoot(forge, 'original', row / fps),
        live: await shoot(forge, 'original', u / fps),
        next: await shoot(forge, 'original', (row + 1) / fps),
      });
    }
    originals.set(clip, shots);
  }

  const { fps } = await open(forge, LEGS[0]!.clip);
  // The twin's pipeline is compiled before the first measured timestamp, at a time the sequence never visits.
  await shoot(forge, 'vat', 0.1);
  const sequence = new Sequence<Step & { leg: number; row: number; live: Buffer; next: Buffer }>(test.info(), forge);
  for (const [k, leg] of LEGS.entries()) {
    const loop = await forge.page.evaluate(
      ({ k, leg }) => {
        const vat = window.__forge.vat!;
        // The first leg plays the clip the scene assigned; the others are switched to, clock settings included.
        if (k > 0) vat.setClipAt(0, leg.clip, { offset: leg.offset, speed: leg.speed });
        return vat.animation.clips.find((c) => c.name === leg.clip)!.duration * vat.animation.fps;
      },
      { k, leg },
    );
    for (const [i, u] of positions(loop).entries()) {
      // The shared clock at which this instance's own clock, `seconds × speed + offset`, reads position `u`.
      const seconds = (u / fps - leg.offset) / leg.speed;
      const original = originals.get(leg.clip)![i]!;
      await sequence.record({
        leg: k,
        ...original,
        label: `${k}-${leg.clip}-${u.toFixed(2)}`,
        png: await shoot(forge, 'vat', seconds),
        state: { seconds, clip: leg.clip, speed: leg.speed, offset: leg.offset, position: u, loop, row: original.row },
      });
    }
  }

  // The twin skins the same vertices from the same matrices as three does: next to no differing pixels on both
  // backends at every timestamp (0.001 % at worst), against 27 % or more of the character's pixels for one row out
  // of place.
  const exact = sequence.bound(
    (s) => shareOfContent(s.png, s.reference, empty!),
    (share) => expect(share, 'the twin is not at the row its timestamp asks for').toBeLessThan(0.005),
  );
  console.log(
    `vat [${forge.backend}]: worst row match ${sequence.steps[exact.index]!.label}, ${(exact.value * 100).toFixed(3)}%`,
  );

  // Against the original at the timestamp itself the twin is late by a fraction of a row, never by more than one.
  const rowMotion = sequence.steps.map((s) => shareOfContent(s.next, s.reference, empty!));
  console.log(`vat [${forge.backend}]: one row moves ${(Math.min(...rowMotion) * 100).toFixed(1)}% at least`);
  expect(Math.min(...rowMotion), 'the original must move between rows for this to prove anything').toBeGreaterThan(0.2);
  const late = sequence.bound(
    (s, i) => shareOfContent(s.png, s.live, empty!) - rowMotion[i]!,
    (margin) => expect(margin, 'further from the original than one baked row').toBeLessThanOrEqual(0),
  );
  console.log(
    `vat [${forge.backend}]: closest to a full row behind at ${sequence.steps[late.index]!.label}, margin ${(-late.value * 100).toFixed(2)}%`,
  );

  // Playback advances: within a leg the picture changes exactly when the row does, and by as much as the original's.
  for (let i = 1; i < sequence.steps.length; i++) {
    if (sequence.steps[i]!.leg !== sequence.steps[i - 1]!.leg) continue;
    sequence.check(i, (step) => {
      const previous = sequence.steps[i - 1]!;
      const moved = differingPixels(step.png, previous.png, { threshold: 4 });
      if (step.row === previous.row) expect(moved, `${step.label} is the same row as ${previous.label}`).toBe(0);
      else {
        const original = differingPixels(step.reference, previous.reference, { threshold: 4 });
        expect(moved, `${step.label} did not advance from ${previous.label}`).toBeGreaterThan(original * 0.9);
      }
    });
  }
});

/**
 * Timestamps one float32 step from a loop boundary. The row counter is `floor(mod(x, loopRows))` in float32, and just
 * below a multiple of loopRows the quotient in `x - y × floor(x / y)` can round up to the whole number. The remainder
 * is then a hair below zero and the row the one before the clip's first: the previous clip's end pose, or for the first
 * clip a row outside the texture. Without the one-period correction each timestamp drew that row on SwiftShader
 * (which matched correctly rounded float32: only loop lengths that do not multiply exactly, as `die` at 25 fps, 8.33
 * rows), through WebGPU on an Apple M1 (whole loop lengths too: the first timestamp, with the row counter wrapped at
 * 12), or on both.
 */
const BOUNDARIES = [
  { clip: 'die', fps: 30, speed: 1, offset: 0, seconds: 1.9999998807907104 },
  { clip: 'die', fps: 25, speed: 1, offset: 0, seconds: 1.6666667461395264 },
  { clip: 'die', fps: 25, speed: 1, offset: 0, seconds: 3.6666667461395264 },
  { clip: 'die', fps: 25, speed: 1.5, offset: 0.2, seconds: 0.9777778387069702 },
  // The first clip of the texture: the row before it does not exist.
  { clip: 'static', fps: 24, speed: 1, offset: 0, seconds: 0.5 },
  { clip: 'static', fps: 24, speed: 1, offset: 0, seconds: 4.5 },
];

test('vat: a timestamp a float32 step from the loop boundary stays inside its clip', {
  tag: ['@corpus', '@temporal'],
}, async ({ forge }) => {
  test.setTimeout(240_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const sequence = new Sequence<Step & { empty: Buffer }>(test.info(), forge);
  for (const c of BOUNDARIES) {
    const { loop } = await open(forge, c.clip, c.fps);
    await forge.page.evaluate((c) => window.__forge.vat!.setClipAt(0, c.clip, { speed: c.speed, offset: c.offset }), c);
    await shoot(forge, 'vat', 0.01);
    const empty = await shoot(forge, 'none', 0);
    const png = await shoot(forge, 'vat', c.seconds);
    // The twin has to show the pose on one side of the boundary or the other: the clip's last row, or its first.
    const before = await shoot(forge, 'original', (Math.ceil(Math.fround(loop)) - 1) / c.fps);
    const after = await shoot(forge, 'original', 0);
    const reference = shareOfContent(png, before, empty) < shareOfContent(png, after, empty) ? before : after;
    const drawnPixels = differingPixels(png, empty, { threshold: 4 });
    await sequence.record({
      label: `${c.clip}-${c.fps}fps-${c.seconds}`,
      png,
      reference,
      empty,
      state: { ...c, drawnPixels },
    });
  }
  const off = sequence.bound(
    (s) => shareOfContent(s.png, s.reference, s.empty),
    (share, step) => {
      expect(step.state.drawnPixels, 'the twin is not drawn at all').toBeGreaterThan(10_000);
      // Another clip's row differs on 100 % of the character's pixels and more, its own row across the boundary on
      // none.
      expect(share, 'the twin shows neither pose next to the loop boundary').toBeLessThan(0.005);
    },
  );
  console.log(
    `vat boundary [${forge.backend}]: worst ${sequence.steps[off.index]!.label}, ${(off.value * 100).toFixed(3)}% from the nearer pose`,
  );
});
