import { expect, type ForgePage, test } from './fixtures.js';
import { differingPixels, pixelDiff, settle } from './pixels.js';

/**
 * The measurements the `batch-local-space` hint and its docs rest on, pinned as a test instead of a comment.
 *
 * `docs/threeforge.md`, `src/compiler/batchStatics.ts` and `src/ledger/DrawCallLedger.ts` say that batching changes
 * the picture on **default settings** (bake off, `dynamics: 'separate'`) for three kinds of material, and cite this
 * spec for it. Nothing pinned that before: if three ever makes batching preserve mesh-local space — or someone
 * changes what the hint looks at — the claim, the hint's justification and the CHANGELOG rows would quietly become
 * wrong with nothing red.
 *
 * Each case asserts both halves of the claim: the `batch-local-space` hint fires, **and** the picture changed
 * (`changedPixels > 0` at tolerance 4). The control case asserts the converse — a plain `MeshStandardMaterial` on the
 * same transformed boxes gives no hint and no changed pixels — so a run that changed every pixel for an unrelated
 * reason cannot make the three cases pass by accident.
 *
 * What is pinned is that the change exists, not its size. Each case annotates the share of *this scene's* frame it
 * measured, currently about 11.1 % for the `positionLocal` gradient, 5.6 % for `alphaHash` and 9.5 % for the
 * object-space normal map on both backends; those shares scale with how much of the frame the affected meshes cover,
 * so they are recorded rather than asserted — asserting a percentage would pin the camera, not the mechanism. The
 * docs quote the same three numbers, from these annotations, and say the same about them.
 *
 * When this spec goes red because a case reached 0 changed pixels, that is the good outcome: batching became exact for
 * it, and the hint, the docs and the CHANGELOG rows for it should go, not the assertion.
 */
function note(description: string): void {
  test.info().annotations.push({ type: 'local-space', description });
}

/** The tolerance these shares are measured at, as `docs/threeforge.md` states them; not the e2e default of 24. */
const TOLERANCE = 4;

/**
 * Four translated, rotated and scaled boxes sharing one material, under a fixed light and camera — the arrangement the
 * quoted percentages were measured on. `material` runs in the page and returns the material to share; the meshes are
 * tagged static, so `compile()` batches them (the default `instanceThreshold` is 64, so four boxes batch rather than
 * instance) and `bake` stays off.
 */
async function buildBoxes(
  forge: ForgePage,
  kind: 'gradient' | 'alphaHash' | 'objectSpaceNormalMap' | 'plain',
): Promise<void> {
  await forge.page.evaluate((which) => {
    const f = window.__forge;
    const T = f.three;
    const TSL = f.webgpu.TSL;
    /** A 16x16 object-space normal map with a per-texel tilt, so the normal matrix a draw applies to it shows. */
    const normalMap = () => {
      const size = 16;
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) {
        const x = i % size;
        const y = Math.floor(i / size);
        const nx = Math.sin((x / size) * Math.PI * 2) * 0.6;
        const ny = Math.cos((y / size) * Math.PI * 2) * 0.6;
        const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
        data.set(
          [
            Math.round((nx * 0.5 + 0.5) * 255),
            Math.round((ny * 0.5 + 0.5) * 255),
            Math.round((nz * 0.5 + 0.5) * 255),
            255,
          ],
          i * 4,
        );
      }
      const texture = new T.DataTexture(data, size, size);
      texture.needsUpdate = true;
      return texture;
    };
    let material: InstanceType<typeof T.Material>;
    if (which === 'gradient') {
      // A colour computed from mesh-local position: batching assigns positionLocal = batchingMatrix * positionLocal
      // (three r186 Batch.js:148), so every box shades from the scene's space instead of its own.
      const node = new f.webgpu.MeshStandardNodeMaterial({ roughness: 0.8 });
      node.name = 'gradient';
      node.colorNode = TSL.mix(TSL.color(0x2040ff), TSL.color(0xff8020), TSL.positionLocal.y.mul(0.5).add(0.5));
      material = node as unknown as InstanceType<typeof T.Material>;
    } else if (which === 'alphaHash') {
      // getAlphaHashThreshold hashes positionLocal (NodeMaterial.js:893) to choose the pixels it discards.
      material = new T.MeshStandardMaterial({
        name: 'hashed',
        color: 0xd8c0a0,
        roughness: 0.8,
        alphaHash: true,
        opacity: 0.5,
      });
    } else if (which === 'objectSpaceNormalMap') {
      // Object-space normals go through the draw's model normal matrix (NormalMapNode.js:120-122): the batch's, not
      // each box's, so a rotated box is lit as if unrotated.
      material = new T.MeshStandardMaterial({
        name: 'engraved',
        color: 0xb0b4c0,
        roughness: 0.55,
        normalMap: normalMap(),
        normalMapType: T.ObjectSpaceNormalMap,
      });
    } else {
      material = new T.MeshStandardMaterial({ name: 'plain', color: 0xb0b4c0, roughness: 0.55 });
    }
    const geometry = new T.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 4; i++) {
      const mesh = new T.Mesh(geometry, material);
      mesh.name = `box-${i}`;
      mesh.position.set(i * 1.6 - 2.4, 1 + (i % 2) * 0.4, (i % 3) * 0.3);
      mesh.rotation.set(0.3 + i * 0.15, i * 0.5, 0.4 - i * 0.1);
      mesh.scale.set(1, 1.6, 0.8);
      (mesh.userData as { forge?: string }).forge = 'static';
      f.scene.add(mesh);
    }
    const backdrop = new T.Mesh(new T.BoxGeometry(9, 6, 0.2), new T.MeshStandardMaterial({ color: 0x242c3a }));
    backdrop.position.set(0, 1.6, -2.4);
    backdrop.name = 'backdrop';
    f.scene.add(backdrop);
    const sun = new T.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 6, 5);
    f.scene.add(new T.AmbientLight(0xffffff, 0.5), sun);
    f.scene.updateMatrixWorld(true);
    f.camera.position.set(0, 2.2, 6.5);
    f.camera.lookAt(0, 1.3, 0);
    f.camera.updateMatrixWorld();
  }, kind);
}

async function compileAndSettle(forge: ForgePage) {
  return forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    for (let i = 0; i < 3; i++) await f.frameAsync();
    // `localSpaceDraws` is gathered on the ledger's graph rescan, which runs every 60 frames: an app sees the hint
    // within a second of compiling, a four-frame test would not, so ask for the rescan rather than render 60 frames.
    f.ledger.rescan();
    const frame = await f.frameAsync();
    return {
      after: report.after,
      hints: frame.hints.map((h) => ({ code: h.code, severity: h.severity })),
      submissions: frame.totals.sceneSubmissions,
      unattributed: frame.totals.unattributed,
    };
  });
}

for (const [kind, label] of [
  ['gradient', 'a positionLocal colour gradient (this scene: about 11.1 % of the frame)'],
  ['alphaHash', 'alphaHash (this scene: about 5.6 % of the frame)'],
  ['objectSpaceNormalMap', 'an object-space normal map (this scene: about 9.5 % of the frame)'],
] as const) {
  test(`batching changes the picture for ${label}, and the hint says so`, async ({ forge }) => {
    test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
    await forge.open('empty');
    await buildBoxes(forge, kind);
    await settle(forge.page);
    const before = await forge.page.screenshot({ type: 'png' });
    const r = await compileAndSettle(forge);
    const after = await forge.page.screenshot({ type: 'png' });
    const changedPixels = differingPixels(before, after, { threshold: TOLERANCE });
    const share = pixelDiff(before, after, { threshold: TOLERANCE });
    note(
      `[${forge.backend}] ${kind}: ${r.after.batches} batch, ${changedPixels} changed pixels, ${(share * 100).toFixed(4)}% of the frame`,
    );
    // The four boxes really did batch, and nothing else moved: the diff below is batching's.
    expect(r.after.batches, 'the four boxes did not batch').toBe(1);
    expect(r.after.baked, 'bake must stay off for this measurement').toBe(0);
    expect(r.unattributed).toBe(0);
    // Both halves of the documented claim.
    expect(
      r.hints.map((h) => h.code),
      'batch-local-space did not fire',
    ).toContain('batch-local-space');
    expect(r.hints.find((h) => h.code === 'batch-local-space')?.severity).toBe('warn');
    expect(
      changedPixels,
      'batching preserved every pixel: the hint and the documented percentage are now wrong',
    ).toBeGreaterThan(0);
  });
}

test('the same boxes with a plain material batch at parity and raise no hint', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('empty');
  await buildBoxes(forge, 'plain');
  await settle(forge.page);
  const before = await forge.page.screenshot({ type: 'png' });
  const r = await compileAndSettle(forge);
  const after = await forge.page.screenshot({ type: 'png' });
  const changedPixels = differingPixels(before, after, { threshold: TOLERANCE });
  note(`[${forge.backend}] plain control: ${r.after.batches} batch, ${changedPixels} changed pixels`);
  expect(r.after.batches).toBe(1);
  expect(r.hints.map((h) => h.code)).not.toContain('batch-local-space');
  expect(changedPixels, 'the control changed pixels, so the cases above prove nothing about their materials').toBe(0);
});
