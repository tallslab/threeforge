import { expect, test } from './fixtures.js';

/** The count pass must agree with geometry: one full-screen opaque quad = 1 fragment per pixel, two transparent = 2. */
test('measured overdraw: one opaque full-screen quad reads 1, two stacked transparent quads read 2', async ({ forge }) => {
  await forge.open('empty');
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const quad = (z: number, transparent: boolean) => {
      const m = new T.Mesh(new T.PlaneGeometry(2, 2), new T.MeshBasicMaterial({ transparent, opacity: 0.5 }));
      m.position.z = z;
      m.frustumCulled = false;
      return m;
    };
    const cam = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    cam.position.z = 5;
    cam.updateMatrixWorld();
    f.scene.add(quad(0, false), quad(1, true), quad(2, true));
    const measured = await f.measureOverdraw(cam);
    await f.frameAsync();
    const frame = f.frame();
    return { measured, frame: frame.overdraw, unattributed: frame.totals.unattributed, sceneSubmissions: frame.totals.sceneSubmissions };
  });
  expect(r.measured.opaque).toBeCloseTo(1, 1);
  expect(r.measured.transparent).toBeCloseTo(2, 1);
  expect(r.frame).toEqual({ opaque: r.measured.opaque, transparent: r.measured.transparent, transparentSubmissions: 2, particles: 0, pixels: 800 * 600, measured: true });
  // The measurement renders are not frames: the following real frame still attributes every draw.
  expect(r.unattributed).toBe(0);
  expect(r.sceneSubmissions).toBe(3);
});
