/**
 * The optimized day/night sun moved through a scripted sweep: small steps the 0.4° throttle holds back, the steps that
 * cross it, a 3° jump whose first frame must already carry the new shadows, and a reversal. DayNight's rule is "render
 * the map when the sun is `everyDegrees` from where the map was last rendered", so the schedule is computed here from
 * the sweep alone. The reference is a second load of the same scene whose `shadow.needsUpdate` this file sets by that
 * schedule every step, whatever DayNight asked for; a held-back frame is compared to an equally stale reference.
 */
import { expect, type ForgePage, test } from './fixtures.js';
import { differingPixels } from './pixels.js';
import { Sequence, type Step } from './temporal.js';

const EVERY_DEGREES = 0.4;
const START_HOUR = 7.5;
/** Sun movement per step, in degrees (15° per hour). */
const SWEEP = [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 3, 0.1, 0.1, 0.1, 0.15, -0.2, -0.3];
const JUMP = SWEEP.indexOf(3);

function schedule(): { hours: number[]; due: boolean[] } {
  const hours: number[] = [];
  const due: boolean[] = [];
  let angle = 0;
  let rendered = 0;
  for (const step of SWEEP) {
    angle += step;
    hours.push(START_HOUR + angle / 15);
    const refresh = Math.abs(angle - rendered) >= EVERY_DEGREES;
    if (refresh) rendered = angle;
    due.push(refresh);
  }
  return { hours, due };
}

/** Loads the scene, frames it close enough for shadows to cover pixels, and lets the fresh map settle at the start. */
async function open(forge: ForgePage): Promise<number> {
  await forge.open('daynight', { seed: '1', variant: 'optimized', tier: 'desktop', t: String(START_HOUR) });
  return forge.page.evaluate(async (hour) => {
    const f = window.__forge;
    f.camera.position.set(0, 30, 70);
    f.camera.lookAt(0, 0, 0);
    f.camera.updateMatrixWorld();
    let passes = -1;
    for (let i = 0; i < 6; i++) {
      f.bench!.setTime!(hour);
      passes = (await f.frameAsync()).lighting.shadowPasses;
    }
    return passes;
  }, START_HOUR);
}

/** One step: the clock, optionally the map's refresh flag forced, one frame, the readback. */
async function step(forge: ForgePage, hour: number, force?: boolean) {
  const frame = await forge.page.evaluate(
    async ({ hour, force }) => {
      const f = window.__forge;
      f.bench!.setTime!(hour);
      if (force !== undefined) {
        const sun = f.scene.getObjectByName('sun') as InstanceType<typeof f.three.DirectionalLight>;
        sun.shadow.needsUpdate = force;
      }
      const frame = await f.frameAsync();
      return {
        shadowPasses: frame.lighting.shadowPasses,
        passes: frame.passes.map((p) => p.id),
        submissions: frame.totals.sceneSubmissions,
        unattributed: frame.totals.unattributed,
      };
    },
    { hour, force },
  );
  return { frame, png: await forge.page.screenshot({ type: 'png' }) };
}

test('daynight shadows refresh on the frame the throttle is crossed, else hold', { tag: '@temporal' }, async ({
  forge,
}) => {
  test.setTimeout(300_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const { hours, due } = schedule();
  expect(due).toEqual([false, false, true, false, false, true, true, false, false, false, true, false, true]);

  expect(await open(forge), 'the reference map must be idle before the sweep').toBe(0);
  const references: Buffer[] = [];
  for (const [i, hour] of hours.entries()) references.push((await step(forge, hour, due[i]!)).png);
  // What a due frame looks like when its refresh comes a frame late, for the smallest scheduled refresh and for the
  // jump: the sensitivity of the pixel check.
  const late: number[] = [];
  for (const at of [due.indexOf(true), JUMP]) {
    expect(await open(forge)).toBe(0);
    let stale = references[at]!;
    for (const [i, hour] of hours.slice(0, at + 1).entries()) stale = (await step(forge, hour, i < at && due[i]!)).png;
    late.push(differingPixels(references[at]!, stale, { threshold: 4 }));
  }

  expect(await open(forge), 'the map must be idle before the sweep').toBe(0);
  const sequence = new Sequence<Step & Awaited<ReturnType<typeof step>>>(test.info(), forge);
  for (const [i, hour] of hours.entries()) {
    const { frame, png } = await step(forge, hour);
    await sequence.record({
      label: `${i}-${due[i] ? 'due' : 'held'}`,
      png,
      frame,
      reference: references[i]!,
      state: { hour, sunDegrees: (hour - START_HOUR) * 15, due: due[i], ...frame },
    });
  }

  sequence.steps.forEach((_, i) => {
    sequence.check(i, ({ frame }) => {
      expect(frame.shadowPasses, `step ${i}: shadow passes`).toBe(due[i] ? 1 : 0);
      expect(frame.passes).toEqual(due[i] ? ['shadow:sun', 'main'] : ['main']);
      expect(frame.unattributed).toBe(0);
    });
  });
  // A refresh adds the casters' submissions to that frame and to no other.
  const held = new Set(sequence.steps.filter((_, i) => !due[i]).map((s) => s.frame.submissions));
  const refreshed = new Set(sequence.steps.filter((_, i) => due[i]).map((s) => s.frame.submissions));
  expect(held.size).toBe(1);
  expect(refreshed.size).toBe(1);
  expect([...refreshed][0]!).toBeGreaterThan([...held][0]!);

  expect(Math.min(...late), 'a late refresh must be visible for the pixel check to mean anything').toBeGreaterThan(
    1000,
  );
  const parity = sequence.bound(
    (s) => differingPixels(s.png, s.reference, { threshold: 4 }),
    (pixels) =>
      expect(pixels, 'a frame does not show the shadows its schedule asks for').toBeLessThan(Math.min(...late) / 20),
  );
  console.log(
    `shadows [${forge.backend}]: worst frame ${sequence.steps[parity.index]!.label}, ${parity.value} px; a late refresh moves ${late.join(' and ')} px`,
  );
});
