import { expect, note, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

/** The optimized zen world streams its chunks with the camera: textures leave the GPU and come back, nothing leaks, the view never changes. */
test('zen: chunks stream with the camera, free their textures, and the start frame matches naive', async ({
  forge,
}) => {
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
      return {
        chunks: frame.memory.chunks,
        unreferenced: frame.memory.unreferenced,
        textureBytes: frame.memory.textures.bytes,
        textures: f.renderer.info.memory.textures,
        unattributed: frame.totals.unattributed,
        stats: f.streamer!.stats(),
      };
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

/*
 * GLTFLoader interleaves every bufferView that has a byteStride. A box packed the same way (position, normal and uv in
 * one InterleavedBuffer) leaves with its chunk and comes back, as a static left alone, as a batch and as an instanced
 * group: no GPU or GL error, and the frame it comes back to is the one it left. In the last mode a second geometry on
 * the same buffer sits out of view in a chunk that is away from the first update on, as two glTF primitives that
 * reuse an accessor would: freeing it must not take the buffer from under the box still drawn.
 */
const INTERLEAVED_MODES: [string, Record<string, string>, number, boolean][] = [
  ['an uncompiled static', {}, 1, false],
  ['a batch', { threshold: '1000' }, 6, false],
  ['an instanced group', { threshold: '4' }, 6, false],
  ['a static sharing its buffer', {}, 1, true],
];
for (const [mode, query, count, sharedBuffer] of INTERLEAVED_MODES) {
  test(`an interleaved geometry streams out and back in as ${mode}`, async ({ forge }) => {
    await forge.open('empty', { chunk: '50', ...query });
    const setup = await forge.page.evaluate(
      async ([n, shared]) => {
        const f = window.__forge;
        const T = f.three;
        const box = new T.BoxGeometry(12, 12, 12);
        const { position, normal, uv } = box.attributes;
        const packed = new Float32Array(position!.count * 8);
        for (let i = 0; i < position!.count; i++) {
          packed.set([position!.getX(i), position!.getY(i), position!.getZ(i)], i * 8);
          packed.set([normal!.getX(i), normal!.getY(i), normal!.getZ(i)], i * 8 + 3);
          packed.set([uv!.getX(i), uv!.getY(i)], i * 8 + 6);
        }
        const buffer = new T.InterleavedBuffer(packed, 8);
        const geometry = new T.BufferGeometry();
        geometry.setIndex(box.index);
        geometry.setAttribute('position', new T.InterleavedBufferAttribute(buffer, 3, 0));
        geometry.setAttribute('normal', new T.InterleavedBufferAttribute(buffer, 3, 3));
        geometry.setAttribute('uv', new T.InterleavedBufferAttribute(buffer, 2, 6));

        const material = f.registry.register(new T.MeshStandardMaterial({ color: 0xc08040, roughness: 0.8 }));
        for (let i = 0; i < n; i++) {
          const mesh = new T.Mesh(geometry, material);
          mesh.position.set(6 + (i % 3) * 16, 6, 6 + Math.floor(i / 3) * 16);
          mesh.rotation.y = i * 0.4;
          mesh.userData.forge = 'static';
          f.scene.add(mesh);
        }
        if (shared) {
          const twin = new T.BufferGeometry();
          twin.setIndex(box.index);
          twin.setAttribute('position', new T.InterleavedBufferAttribute(buffer, 3, 0));
          twin.setAttribute('normal', new T.InterleavedBufferAttribute(buffer, 3, 3));
          const far = new T.Mesh(twin, material);
          far.position.set(606, 6, 6);
          // Out of view, but drawn: three uploads a geometry only when it draws it, and an unload frees only what is uploaded.
          far.frustumCulled = false;
          far.userData.forge = 'static';
          f.scene.add(far);
        }
        const sun = new T.DirectionalLight(0xffffff, 2.5);
        sun.position.set(40, 80, 60);
        f.scene.add(sun, new T.AmbientLight(0xffffff, 0.6));

        if (n > 1) f.compile();
        for (let i = 0; i < 3; i++) await f.frameAsync();
        return { batches: f.world.batchedMeshes.length, children: f.scene.children.map((o) => o.type) };
      },
      [count, sharedBuffer] as const,
    );
    const resident = forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null;

    const r = await forge.page.evaluate(async () => {
      const f = window.__forge;
      const errors: string[] = [];
      // Renderer.onError (r186) passes { api, type, message }; the typings still declare a string.
      f.renderer.onError = (info) => errors.push(JSON.stringify(info));
      const streamer = new f.Streamer({ world: f.world, camera: f.camera, radius: 300, margin: 0 });
      f.ledger.attachStreamer(streamer);
      const home = f.camera.position.clone();
      const at = async (x: number) => {
        f.camera.position.set(x, home.y, home.z);
        f.camera.updateMatrixWorld();
        const stats = streamer.update();
        for (let i = 0; i < 2; i++) await f.frameAsync();
        f.ledger.rescan();
        const frame = await f.frameAsync();
        // WebGL2 reports a draw from a deleted buffer only here: the submission is still counted.
        const glError = (f.renderer.backend as { gl?: WebGL2RenderingContext }).gl?.getError() ?? 0;
        if (glError !== 0) errors.push(`gl error ${glError}`);
        return { stats, submissions: frame.totals.sceneSubmissions, unreferenced: frame.memory.unreferenced };
      };
      const start = await at(home.x);
      const away = await at(5000);
      const back = await at(home.x);
      // An uncaptured error reaches the device's handler after the submit that caused it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await f.frameAsync();
      return { start, away, back, errors };
    });
    note('interleaved-streaming', JSON.stringify({ mode, setup, ...r }));

    expect(r.start.stats.resident).toBe(1);
    expect(r.away.stats.resident).toBe(0);
    expect(r.away.submissions).toBe(0);
    expect(r.back.stats.resident).toBe(1);
    expect(r.back.submissions).toBe(r.start.submissions);
    expect(r.errors).toEqual([]);
    // Freed for real while away, and what an unload does leave uploaded is the streamer's, not a leak.
    for (const s of [r.start, r.away, r.back]) expect(s.unreferenced).toEqual({ geometries: 0, textures: 0 });
    if (resident) expect(pixelDiff(resident, await forge.page.screenshot({ type: 'png' }))).toBeLessThan(0.0005);
  });
}
