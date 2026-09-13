import { expect, test } from './fixtures.js';

test('assembleCharacter turns body + 4 gear parts (5 skinned draws) into one skinned draw with the same pixels', async ({ forge }) => {
  await forge.open('character');
  const naive = await forge.page.evaluate(() => window.__forge.frame().totals);
  const naiveReasons = await forge.page.evaluate(() => window.__forge.frame().byReason);
  expect(naiveReasons.skinned?.submissions).toBe(5);
  expect(naive.unattributed).toBe(0);
  if (forge.pixelChecks) await expect(forge.page).toHaveScreenshot(`character-${forge.backend}.png`, { maxDiffPixelRatio: 0.01 });

  await forge.open('character', { assemble: '1' });
  const assembled = await forge.page.evaluate(() => {
    const f = window.__forge;
    const frame = f.frame();
    return { totals: frame.totals, byReason: frame.byReason, report: f.assembled!.report };
  });
  console.log(JSON.stringify(assembled.report));
  expect(assembled.byReason.skinned?.submissions).toBe(1);
  expect(assembled.totals.sceneSubmissions).toBe(1);
  expect(assembled.totals.unattributed).toBe(0);
  expect(assembled.report).toMatchObject({ parts: 5, wardrobe: 5, materials: 1, atlas: { textures: 5, size: 256, cells: 9 } });
  if (forge.pixelChecks) await expect(forge.page).toHaveScreenshot(`character-${forge.backend}.png`, { maxDiffPixelRatio: 0.01 });
});

test('equipping and unequipping through the assembled character never changes the draw count', async ({ forge }) => {
  await forge.open('character', { assemble: '1' });
  const result = await forge.page.evaluate(() => {
    const f = window.__forge;
    const c = f.assembled!;
    const sword = f.character!.gear[3]!;
    const before = f.frame().totals.sceneSubmissions;
    const verticesBefore = c.report.vertices;
    c.unequip(sword);
    const without = f.frame().totals.sceneSubmissions;
    const verticesWithout = c.report.vertices;
    c.equip(sword);
    const after = f.frame().totals.sceneSubmissions;
    return { before, without, after, verticesBefore, verticesWithout, verticesAfter: c.report.vertices };
  });
  expect(result.before).toBe(1);
  expect(result.without).toBe(1);
  expect(result.after).toBe(1);
  expect(result.verticesWithout).toBeLessThan(result.verticesBefore);
  expect(result.verticesAfter).toBe(result.verticesBefore);
});
