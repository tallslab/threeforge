import { expect, test } from './fixtures.js';

test('an empty scene costs exactly one renderer-internal draw (output colour transform)', async ({ forge }) => {
  await forge.open('empty');
  const result = await forge.page.evaluate(() => window.__forge.renderOnce());
  expect(result.backend).toBe(forge.backend);
  // three r186 renders through an internal target and blits with a QuadMesh named "Output Color Transform".
  // That quad is not part of the user's scene; the ledger classifies it as renderer-internal.
  expect(result.drawCalls).toBe(1);
});
