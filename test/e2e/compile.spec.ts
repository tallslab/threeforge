import { expect, test } from './fixtures.js';

test('world.compile() takes the naive scene from 503 to 28 submissions with identical pixels', async ({ forge }) => {
  await forge.open('naive');
  const before = await forge.page.evaluate(() => window.__forge.frame());
  expect(before.totals.sceneSubmissions).toBe(503);
  // Baseline image of the naive render; the compiled render must match it.
  await expect(forge.page).toHaveScreenshot(`naive-${forge.backend}.png`, { maxDiffPixelRatio: 0.002 });

  const { report, after, text } = await forge.page.evaluate(() => {
    const f = window.__forge;
    const report = f.compile();
    const after = f.frame();
    return { report, after, text: f.ledger.report() };
  });
  console.log(text);
  console.log(JSON.stringify({ before: report.before, after: report.after, groups: report.groups.length, skipped: report.skipped.length }));

  expect(report.after.batches).toBe(15);
  expect(after.totals.sceneSubmissions).toBe(28);
  expect(after.totals.unattributed).toBe(0);
  expect(after.byReason).toMatchObject({
    batched: { submissions: 15 },
    dynamic: { submissions: 10 },
    skinned: { submissions: 2 },
    'unique-material': { submissions: 1 },
    'renderer-internal': { submissions: 1 },
  });
  expect(after.totals.programSwitches).toBeLessThan(before.totals.programSwitches);
  await expect(forge.page).toHaveScreenshot(`naive-${forge.backend}.png`, { maxDiffPixelRatio: 0.002 });

  const restored = await forge.page.evaluate(() => {
    window.__forge.decompile();
    return window.__forge.frame().totals.sceneSubmissions;
  });
  expect(restored).toBe(503);
});

test('resolve() maps a raycast against the compiled scene back to the original prop', async ({ forge }) => {
  await forge.open('naive', { compile: '1' });
  const result = await forge.page.evaluate(() => {
    const f = window.__forge;
    // A static prop standing alone above the ground plane: pick the tallest static so nothing else is hit first.
    const target = f.naive!.props.filter((p) => p.userData.forge === 'static').sort((a, b) => b.position.y - a.position.y)[0]!;
    return { ...f.raycastDown(target.position.x, target.position.z), targetName: target.name };
  });
  expect(result.hitCount).toBeGreaterThan(0);
  expect(result.hitIsBatch).toBe(true);
  expect(result.resolvedName).toBe(result.targetName);
});
