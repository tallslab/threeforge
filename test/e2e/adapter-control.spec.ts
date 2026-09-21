/**
 * A bare canvas presented through the browser's own WebGPU for three seconds: no three.js and no threeforge on the
 * page. It answers one question: can this adapter lose its device with nothing of ours running. It does not explain
 * any other test's failure; a lost device there still has to be read from that test's own record. A native adapter
 * must hold. On the software adapter the outcome is a measurement, recorded on the test and printed by
 * scripts/advisory-report.mjs.
 */
import { readFileSync } from 'node:fs';
import { expect, note, test } from './fixtures.js';

interface Control {
  frames: number;
  lost: { message: string; ms: number } | null;
  rejected: number;
}

test('a bare WebGPU canvas keeps its device while it presents', async ({ page, backend, forge }) => {
  test.skip(backend !== 'webgpu', 'WebGPU only');
  const script = readFileSync('test/e2e/adapter-control.page.js', 'utf8');
  // WebGPU needs a secure context, which the harness origin is; nothing of the harness is on this page.
  await page.route('**/adapter-control', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<canvas width="800" height="600"></canvas><script type="module">${script}</script>`,
    }),
  );
  await page.goto('/adapter-control');
  const result = (await page.evaluate('window.control')) as Control | null;
  test.skip(result === null, 'no WebGPU adapter in this browser');
  const { frames, lost, rejected } = result!;
  note(
    'adapter-control',
    lost
      ? `a bare canvas lost its device after ${lost.ms} ms and ${frames} frames (${lost.message}), ${rejected} rejected`
      : `a bare canvas kept its device through ${frames} frames`,
  );
  if (forge.pixelChecks) expect(lost, 'a native adapter lost its device on a page with nothing of ours').toBeNull();
});
