/**
 * Draco through `createLoader` and the decoder files `threeforge decoders` hands out, on `test/fixtures/draco`: the
 * same torus plain and with `KHR_draco_mesh_compression`. A deployment that forgot a decoder file must end in a
 * rejection that names the file, for the model that needed it and for no other.
 */
import { expect, test } from './fixtures.js';
import { loadThrough, packagedDecoders, serveModels, servePackaged, serveWithout } from './served-decoders.js';

const decoders = packagedDecoders();
// Draco merges the coincident vertices along the seams, so the faces are what both models share.
const TRIANGLES = 32 * 16 * 2;

test('draco: the compressed torus decodes to the triangles of the plain one', async ({ forge }) => {
  await forge.open('empty');
  await serveModels(forge.page, '_draco', 'test/fixtures/draco');
  await servePackaged(forge.page, decoders());
  const models = ['/_draco/ring-draco.glb', '/_draco/ring-plain.glb'];
  expect(await loadThrough(forge.page, models, false, '/_packaged/')).toEqual([
    `loaded with 0 colour maps and ${TRIANGLES} triangles`,
    `loaded with 0 colour maps and ${TRIANGLES} triangles`,
  ]);
});

for (const file of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) {
  for (const how of ['404', 'html'] as const) {
    test(`draco: a missing ${file} (${how}) rejects the load and names the file`, async ({ forge }) => {
      await forge.open('empty');
      await serveModels(forge.page, '_draco', 'test/fixtures/draco');
      await serveWithout(forge.page, decoders(), file, how);
      const [outcome] = await loadThrough(forge.page, ['/_draco/ring-draco.glb'], false);
      expect(outcome).toMatch(/^rejected: /);
      expect(outcome).toContain(`/_partial/draco/${file}`);
      expect(outcome).toContain('threeforge decoders');
    });
  }
}

for (const together of [false, true]) {
  test(`draco: a failed Draco load leaves a plain model loadable (${together ? 'at once' : 'after'})`, async ({
    forge,
  }) => {
    await forge.open('empty');
    await serveModels(forge.page, '_draco', 'test/fixtures/draco');
    await serveWithout(forge.page, decoders(), 'draco_decoder.wasm', '404');
    const models = ['/_draco/ring-draco.glb', '/_draco/ring-plain.glb'];
    const [compressed, plain] = await loadThrough(forge.page, models, together);
    expect(compressed).toMatch(/^rejected: /);
    expect(plain).toBe(`loaded with 0 colour maps and ${TRIANGLES} triangles`);
  });
}
