/**
 * A camera dollies across both LOD boundaries, back, and to and fro around each, one rendered frame per pose. The
 * level is a function of distance alone (`levelFor`: level i from `distances[i - 1]` onward, no hysteresis), so every
 * frame has an exact reference: the same balls uncompiled, each holding the geometry of the level its distance asks
 * for. Nine balls in a row at x = -12..12 switch at different camera depths, so most poses mix levels.
 */
import { expect, type ForgePage, test } from './fixtures.js';
import { differingPixels } from './pixels.js';
import { Sequence, type Step, shareOfContent } from './temporal.js';

const DISTANCES = [30, 60];
const XS = [-12, -9, -6, -3, 0, 3, 6, 9, 12];
/** Camera depths. The centre ball switches between 30.05 and 29.95 (and 60.05, 59.95); its neighbours further in. */
const DOLLY = [
  31, 30.05, 29.95, 29.5, 28, 29.5, 29.95, 30.05, 29.95, 30.05, 31, 61, 60.05, 59.95, 59.8, 59, 59.8, 59.95, 60.05,
  59.95, 60.05, 61,
];

const levelsAt = (z: number): number[] => XS.map((x) => DISTANCES.filter((d) => Math.hypot(x, z) >= d).length);

/** Builds the row in the page and returns the triangle count of every level, base first. */
async function build(forge: ForgePage, threshold: string, compile: boolean): Promise<number[]> {
  await forge.open('empty', { lod: '1', lod0: String(DISTANCES[0]), lod1: String(DISTANCES[1]), threshold });
  return forge.page.evaluate(
    async ({ xs, compile }) => {
      const f = window.__forge;
      const T = f.three;
      const sun = new T.DirectionalLight(0xffffff, 2.2);
      sun.position.set(5, 8, 10);
      f.scene.add(new T.AmbientLight(0xffffff, 0.4), sun);
      const geometry = new T.SphereGeometry(1.3, 32, 24);
      const material = new T.MeshStandardMaterial({ color: 0xd08a4a, roughness: 0.7, metalness: 0 });
      xs.forEach((x, i) => {
        const ball = new T.Mesh(geometry, material);
        ball.name = `ball-${i}`;
        ball.position.set(x, 0, 0);
        ball.userData.forge = 'static';
        f.scene.add(ball);
      });
      f.scene.updateMatrixWorld(true);
      await f.prepareLods(f.scene, { ratios: [0.5, 0.2] });
      if (compile) f.compile();
      return [geometry, ...f.lodsOf(geometry)].map((g) => g.index!.count / 3);
    },
    { xs: XS, compile },
  );
}

/** One pose, one frame, then the readback. `levels` swaps each uncompiled ball to the geometry of that level. */
async function shoot(forge: ForgePage, z: number, levels?: number[]) {
  const frame = await forge.page.evaluate(
    async ({ z, levels }) => {
      const f = window.__forge;
      if (levels) {
        const balls = f.scene.children.filter((o) => o.name.startsWith('ball-')) as InstanceType<typeof f.three.Mesh>[];
        const base = (balls[0]!.userData.base ??= balls[0]!.geometry) as Parameters<typeof f.lodsOf>[0];
        const byLevel = [base, ...f.lodsOf(base)];
        balls.forEach((ball, i) => {
          ball.geometry = byLevel[levels[i]!]!;
        });
      }
      f.camera.position.set(0, 0, z);
      f.camera.lookAt(0, 0, 0);
      f.camera.updateMatrixWorld();
      const { totals, byReason } = await f.frameAsync();
      // three's output quad is a single triangle, counted with the scene's.
      const triangles = totals.triangles - (byReason['renderer-internal']?.submissions ?? 0);
      return { triangles, submissions: totals.sceneSubmissions, unattributed: totals.unattributed };
    },
    { z, levels },
  );
  return { frame, png: await forge.page.screenshot({ type: 'png' }) };
}

for (const path of [
  { name: 'instanced', threshold: '4' },
  { name: 'batched', threshold: '1000' },
]) {
  test(`${path.name} LOD levels follow the camera across both boundaries`, { tag: '@temporal' }, async ({ forge }) => {
    test.setTimeout(180_000);
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');

    const triangles = await build(forge, path.threshold, false);
    expect(triangles[1]!).toBeLessThan(triangles[0]!);
    expect(triangles[2]!).toBeLessThan(triangles[1]!);
    const references: Buffer[] = [];
    // Where a step changes levels, the same pose with the previous step's levels held: what the switch alone changes.
    const held = new Map<number, Buffer>();
    for (const [i, z] of DOLLY.entries()) {
      references.push((await shoot(forge, z, levelsAt(z))).png);
      const before = levelsAt(DOLLY[i - 1] ?? z);
      if (before.some((level, k) => level !== levelsAt(z)[k])) held.set(i, (await shoot(forge, z, before)).png);
    }
    const empties = new Map<number, Buffer>();
    await forge.page.evaluate(() => {
      for (const o of window.__forge.scene.children) if (o.name.startsWith('ball-')) o.visible = false;
    });
    for (const z of new Set(DOLLY)) empties.set(z, (await shoot(forge, z)).png);

    await build(forge, path.threshold, true);
    // Shaders and buffers are warm before the first measured pose; the pose itself has never been rendered.
    await shoot(forge, 45);
    const sequence = new Sequence<Step & Awaited<ReturnType<typeof shoot>>>(test.info(), forge);
    for (const [i, z] of DOLLY.entries()) {
      const { frame, png } = await shoot(forge, z);
      await sequence.record({
        label: `z${z}`,
        png,
        frame,
        reference: references[i]!,
        state: { z, expectedLevels: levelsAt(z), ...frame },
      });
    }

    // Same geometry, material and lights on both sides: 0 differing pixels measured on both backends. A missing ball
    // is 11 % of the balls' pixels and balls a level off at the far boundary 0.5 %; one ball a level off at the near
    // boundary stays under this bound, and the triangle counts below are what hold it.
    const parity = sequence.bound(
      (s) => shareOfContent(s.png, s.reference, empties.get(s.state.z as number)!),
      (share) => expect(share, 'a frame differs from the levels its distances ask for').toBeLessThan(0.002),
    );
    console.log(
      `lod [${forge.backend}] ${path.name}: worst frame ${sequence.steps[parity.index]!.label}, ${(parity.value * 100).toFixed(3)}% of the balls' pixels`,
    );

    DOLLY.forEach((z, i) => {
      sequence.check(i, ({ frame }) => {
        const expected = levelsAt(z).reduce((sum, level) => sum + triangles[level]!, 0);
        expect(frame.triangles, `triangles at z = ${z}`).toBe(expected);
        expect(frame.unattributed).toBe(0);
        expect(frame.submissions).toBeLessThanOrEqual(DISTANCES.length + 1);
      });
    });

    // No hysteresis: a pose reached from the near side and from the far side is the same picture.
    DOLLY.forEach((z, i) => {
      const earlier = DOLLY.indexOf(z);
      if (earlier === i) return;
      sequence.check(i, (step) => {
        expect(differingPixels(step.png, sequence.steps[earlier]!.png, { threshold: 4 }), `z = ${z} revisited`).toBe(0);
      });
    });

    // The pop itself: a switch may redraw a ball's rim and shift its shading, never replace the ball. Measured at the
    // default threshold of 24, as a share of the pixels of the balls that switched: 1.5 % at worst on both backends.
    expect(held.size).toBeGreaterThanOrEqual(12);
    const pop = sequence.bound(
      (step, i) => {
        const unswitched = held.get(i);
        if (!unswitched) return undefined;
        const before = levelsAt(DOLLY[i - 1]!);
        const switched = levelsAt(DOLLY[i]!).filter((level, k) => level !== before[k]).length;
        const ball = differingPixels(references[i]!, empties.get(DOLLY[i]!)!, { threshold: 4 }) / XS.length;
        return differingPixels(step.png, unswitched) / (ball * switched);
      },
      (share, step) => expect(share, `the switch at ${step.label} replaced more than a rim`).toBeLessThan(0.05),
    );
    console.log(
      `lod [${forge.backend}] ${path.name}: worst switch at ${DOLLY[pop.index]}, ${(pop.value * 100).toFixed(2)}%`,
    );
  });
}
