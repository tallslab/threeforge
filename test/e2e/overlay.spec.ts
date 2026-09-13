import { expect, test } from './fixtures.js';

test('the dev overlay shows the live budget line', async ({ forge }) => {
  await forge.open('naive', { compile: '1', overlay: '1', budget: '30' });
  await forge.page.evaluate(() => window.__forge.frame());
  const overlay = forge.page.locator('#threeforge-overlay');
  await expect(overlay).toContainText('28 / 30');
  await expect(overlay).toContainText('PASS');
  await expect(overlay).toContainText('batched');
});
