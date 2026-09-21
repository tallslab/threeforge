import { expect, test } from './fixtures.js';

// @adapter: the one test a leg with advisory failures still has to pass (scripts/advisory-report.mjs). It opens the
// page on the project's backend, which fails under FORGE_REQUIRE_WEBGPU=1 when there is no adapter, and draws a frame.
test('an empty scene costs exactly one renderer-internal draw (output colour transform)', {
  tag: '@adapter',
}, async ({ forge }) => {
  await forge.open('empty');
  const result = await forge.page.evaluate(() => window.__forge.renderOnce());
  expect(result.backend).toBe(forge.backend);
  // three r186 renders through an internal target and blits with a QuadMesh named "Output Color Transform".
  // That quad is not part of the user's scene; the ledger classifies it as renderer-internal.
  //
  // Asserted on the ledger's totals rather than on `renderOnce().drawCalls` (CONTRIBUTING.md rule 5). The raw count only
  // reads 1 on both backends because a fullscreen quad is one draw either way; it stops being the scene's cost the
  // moment anything is batched, so a spec written against it can only ever be right by accident. The claim worth
  // pinning is the attribution: nothing of the app's was submitted, and the single draw that happened belongs to the
  // renderer rather than being unexplained.
  expect(result.sceneSubmissions, 'an empty scene submits nothing of its own').toBe(0);
  expect(result.rendererInternal, "three's output colour-transform quad").toBe(1);
  expect(result.submissions).toBe(1);
  // Nothing the backend issued went uncosted, which is what makes the three counts above a complete account of the
  // frame rather than a lower bound on it.
  expect(result.unattributed).toBe(0);
});
