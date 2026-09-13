import { expect, test } from './fixtures.js';

test('occlusion proxies hide chunk batches behind a wall after the query results arrive', async ({ forge }) => {
  await forge.open('naive', { compile: '1', chunk: '40', occlusion: '1', wall: '1' });
  const result = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const first = f.frame().totals;
    const proxies = f.frame().byReason['occlusion-proxy']?.submissions ?? 0;
    // Query results are resolved asynchronously; give the renderer a few frames.
    const wait = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
    let settled = first;
    for (let i = 0; i < 6; i++) {
      await wait();
      settled = f.frame().totals;
    }
    const byReason = f.frame().byReason;
    return { first, settled, proxies, batchedFirst: first.sceneSubmissions, byReason, report: f.ledger.report() };
  });
  console.log(result.report);
  expect(result.proxies).toBeGreaterThan(4);
  expect(result.settled.unattributed).toBe(0);
  expect(result.settled.sceneSubmissions).toBeLessThan(result.first.sceneSubmissions);
  expect(result.byReason['occlusion-proxy']?.submissions).toBe(result.proxies);
});
