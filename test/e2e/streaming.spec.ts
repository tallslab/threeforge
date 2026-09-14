import { PNG } from 'pngjs';
import { expect, test } from './fixtures.js';

function pixelDiff(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let n = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    const o = i * 4;
    if (Math.max(Math.abs(pa.data[o]! - pb.data[o]!), Math.abs(pa.data[o + 1]! - pb.data[o + 1]!), Math.abs(pa.data[o + 2]! - pb.data[o + 2]!)) > 24) n++;
  }
  return n / (pa.width * pa.height);
}

/** The optimized zen world streams its chunks with the camera: textures leave the GPU and come back, nothing leaks, the view never changes. */
test('zen: chunks stream with the camera, free their textures, and the start frame matches naive', async ({ forge }) => {
  test.setTimeout(300_000);
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  await forge.open('zen', { variant: 'naive', count: '5000' });
  await forge.page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await window.__forge.frameAsync();
  });
  const naivePng = await forge.page.screenshot({ type: 'png' });
  await forge.open('zen', { variant: 'optimized', count: '5000' });
  const r = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const at = async (x: number, z: number, t: number) => {
      f.camera.position.set(x, 30, z);
      f.camera.lookAt(x + 300, 0, z + 300);
      f.camera.updateMatrixWorld();
      f.bench!.setTime!(t);
      for (let i = 0; i < 2; i++) await f.frameAsync();
      const frame = await f.frameAsync();
      return { chunks: frame.memory.chunks, unreferenced: frame.memory.unreferenced, textureBytes: frame.memory.textures.bytes, textures: f.renderer.info.memory.textures, unattributed: frame.totals.unattributed, stats: f.streamer!.stats() };
    };
    const start = await at(0, 0, 0);
    const corner = await at(-900, -900, 1);
    const back = await at(0, 0, 2);
    return { start, corner, back };
  });
  const optimizedPng = await forge.page.screenshot({ type: 'png' });
  console.log('streaming:', JSON.stringify(r));
  expect(r.start.chunks.total).toBe(64);
  expect(r.start.chunks.resident).toBeLessThan(40);
  expect(r.start.chunks.resident).toBeGreaterThan(12);
  expect(r.corner.chunks.resident).toBeLessThan(r.start.chunks.resident);
  expect(r.corner.textures).toBeLessThan(r.start.textures);
  // Hysteresis keeps a ring of corner chunks resident on the way back: at least the start set, plus a few.
  expect(r.back.chunks.resident).toBeGreaterThanOrEqual(r.start.chunks.resident);
  expect(r.back.chunks.resident).toBeLessThanOrEqual(r.start.chunks.resident + 8);
  expect(r.back.textures).toBeGreaterThan(r.corner.textures);
  for (const s of [r.start, r.corner, r.back]) {
    expect(s.unattributed).toBe(0);
    expect(s.unreferenced).toEqual({ geometries: 0, textures: 0 });
  }
  expect(r.back.stats.loads).toBeGreaterThan(0);
  expect(pixelDiff(naivePng, optimizedPng)).toBeLessThan(0.005);
});
