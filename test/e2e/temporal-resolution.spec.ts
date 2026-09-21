/**
 * A forced scale sequence down and back up while the camera orbits, one rendered frame per step. The canvas is laid
 * out at a fixed 800 x 600, as an app's stylesheet would, so every screenshot has the same output size whatever the
 * drawing buffer is. Each step has two references from pages that never change scale: the same pose on a page held at
 * that step's scale, which the first frame after a change must equal, and the same pose at full resolution, which a
 * scaled frame must be a resampling of. The view changes every step, so a frame left over from the step before cannot
 * pass for the current one.
 */
import { expect, type ForgePage, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';
import { Sequence, type Step } from './temporal.js';

const SCALES = [1, 0.75, 0.5, 0.5, 0.75, 1, 1];
const DEGREES_PER_STEP = 20;

async function open(forge: ForgePage): Promise<void> {
  await forge.open('naive', { seed: '1', compile: '1', scale: '1' });
  await forge.page.evaluate(async () => {
    const f = window.__forge;
    f.renderer.domElement.style.width = '800px';
    f.renderer.domElement.style.height = '600px';
    for (let i = 0; i < 3; i++) await f.frameAsync();
  });
}

/** One step: the scale, the orbit pose, one frame, then the buffer facts and the readback. */
async function step(forge: ForgePage, scale: number, degrees: number) {
  const facts = await forge.page.evaluate(
    async ({ scale, degrees }) => {
      const f = window.__forge;
      f.scaler!.set(scale);
      f.camera.position.set(0, 110, 150).applyAxisAngle(new f.three.Vector3(0, 1, 0), (degrees * Math.PI) / 180);
      f.camera.lookAt(0, 0, 0);
      f.camera.updateMatrixWorld();
      const frame = await f.frameAsync();
      const canvas = f.renderer.domElement;
      const buffer = f.renderer.getDrawingBufferSize(new f.three.Vector2());
      return {
        canvas: [canvas.width, canvas.height],
        buffer: [buffer.x, buffer.y],
        layout: [canvas.clientWidth, canvas.clientHeight],
        aspect: f.camera.aspect,
        pixels: frame.overdraw.pixels,
        dpr: frame.env.dpr,
        submissions: frame.totals.sceneSubmissions,
        unattributed: frame.totals.unattributed,
      };
    },
    { scale, degrees },
  );
  return { facts, png: await forge.page.screenshot({ type: 'png' }) };
}

test('a forced scale sequence resizes the buffer and keeps each frame current', { tag: '@temporal' }, async ({
  forge,
}) => {
  test.setTimeout(180_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');

  const steady = new Map<number, Array<Awaited<ReturnType<typeof step>>>>();
  for (const scale of new Set(SCALES)) {
    await open(forge);
    for (let i = 0; i < 3; i++) await step(forge, scale, -DEGREES_PER_STEP);
    const shots: Array<Awaited<ReturnType<typeof step>>> = [];
    for (const [i] of SCALES.entries()) shots.push(await step(forge, scale, i * DEGREES_PER_STEP));
    steady.set(scale, shots);
  }
  const full = steady.get(1)!;

  await open(forge);
  const sequence = new Sequence<Step & Awaited<ReturnType<typeof step>>>(test.info(), forge);
  for (const [i, scale] of SCALES.entries()) {
    const taken = await step(forge, scale, i * DEGREES_PER_STEP);
    await sequence.record({
      label: `${i}-x${scale}`,
      ...taken,
      reference: steady.get(scale)![i]!.png,
      state: { scale, orbitDegrees: i * DEGREES_PER_STEP, ...taken.facts },
    });
  }

  SCALES.forEach((scale, i) => {
    sequence.check(i, ({ facts }) => {
      const size = [Math.floor(800 * scale), Math.floor(600 * scale)];
      expect(facts.canvas, `step ${i}: canvas size`).toEqual(size);
      expect(facts.buffer, `step ${i}: drawing buffer`).toEqual(size);
      expect(facts.pixels).toBe(size[0]! * size[1]!);
      expect(facts.dpr).toBe(scale);
      expect(facts.layout).toEqual([800, 600]);
      expect(facts.aspect).toBeCloseTo(800 / 600, 9);
      expect(facts.submissions).toBe(full[i]!.facts.submissions);
      expect(facts.unattributed).toBe(0);
    });
  });

  // A frame rendered right after a scale change against the same pose on a page that has always had that scale: the
  // same buffer size and the same draws, 0 differing pixels measured on WebGL2 and 1 on WebGPU, of 480 000.
  const transition = sequence.bound(
    (s) => pixelDiff(s.png, s.reference, { threshold: 4 }),
    (share) => expect(share, 'a frame after a scale change is not a settled frame at that scale').toBeLessThan(0.0001),
  );
  // Against full resolution the half-scale frame differs on 3.1 % of the pixels (edges, after the browser's upscale)
  // and the previous step's frame on 11 %; the bound sits halfway to a stale frame.
  const motion = Math.min(...full.slice(1).map((r, i) => pixelDiff(r.png, full[i]!.png)));
  const resampled = sequence.bound(
    (s, i) => pixelDiff(s.png, full[i]!.png),
    (share) => expect(share, 'a scaled frame is not the full-resolution picture resampled').toBeLessThan(motion / 2),
  );
  console.log(
    `resolution [${forge.backend}]: worst transition ${sequence.steps[transition.index]!.label} ${(transition.value * 100).toFixed(4)}%, ` +
      `worst resampling ${sequence.steps[resampled.index]!.label} ${(resampled.value * 100).toFixed(2)}%, one orbit step ${(motion * 100).toFixed(2)}%`,
  );
});
