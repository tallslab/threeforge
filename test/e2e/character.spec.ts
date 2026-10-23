import { expect, test } from './fixtures.js';
import { pixelDiff } from './pixels.js';

test('assembleCharacter turns 5 skinned draws (body + 4 gear) into one with the same pixels', async ({ forge }) => {
  await forge.open('character');
  const naive = await forge.page.evaluate(() => window.__forge.frame().totals);
  const naiveReasons = await forge.page.evaluate(() => window.__forge.frame().byReason);
  expect(naiveReasons.skinned?.submissions).toBe(5);
  expect(naive.unattributed).toBe(0);
  if (forge.pixelChecks)
    await expect(forge.page).toHaveScreenshot(`character-${forge.backend}.png`, { maxDiffPixelRatio: 0.01 });

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
  expect(assembled.report).toMatchObject({
    parts: 5,
    wardrobe: 5,
    materials: 1,
    atlas: { textures: 5, size: 256, cells: 9 },
  });
  if (forge.pixelChecks)
    await expect(forge.page).toHaveScreenshot(`character-${forge.backend}.png`, { maxDiffPixelRatio: 0.01 });
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

test('an assembled character keeps its gear vertex colours', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'screenshots unavailable on this adapter');
  const shot = async (query: Record<string, string>) => {
    await forge.open('character', query);
    await forge.page.evaluate(async () => {
      for (let i = 0; i < 2; i++) await window.__forge.frameAsync();
    });
    return forge.page.screenshot({ type: 'png' });
  };
  const parts = await shot({ vertexColors: '1' });
  const assembled = await shot({ vertexColors: '1', assemble: '1' });
  const textured = await shot({});
  const likeness = pixelDiff(parts, assembled);
  const recoloured = pixelDiff(parts, textured);
  console.log(
    `character vertex colours: parts vs assembled ${(likeness * 100).toFixed(2)}% · vs textured gear ${(recoloured * 100).toFixed(2)}%`,
  );
  // Vertex-coloured gear looks unlike the textured gear, so losing the colours would show.
  expect(recoloured).toBeGreaterThan(0.02);
  expect(likeness).toBeLessThan(0.01);
});

test('an untextured wardrobe assembles without an atlas, pixel for pixel', async ({ forge }) => {
  const open = async (query: Record<string, string>) => {
    await forge.open('character', query);
    const memory = await forge.page.evaluate(async () => {
      for (let i = 0; i < 2; i++) await window.__forge.frameAsync();
      const frame = await window.__forge.frameAsync();
      return { textureBytes: frame.memory.textures.bytes, submissions: frame.totals.sceneSubmissions };
    });
    return { memory, shot: forge.pixelChecks ? await forge.page.screenshot({ type: 'png' }) : null };
  };
  const parts = await open({ textures: '0', vertexColors: '1' });
  const assembled = await open({ textures: '0', vertexColors: '1', assemble: '1', atlas: '1024' });
  const textured = await open({ vertexColors: '1', assemble: '1', atlas: '1024' });
  console.log(
    `untextured character: texture bytes parts ${parts.memory.textureBytes} · assembled ${assembled.memory.textureBytes} · with a textured body ${textured.memory.textureBytes}`,
  );
  expect(assembled.memory.submissions).toBe(1);
  // A 1024² atlas with mipmaps would be about 5.6 MB; an untextured wardrobe adds no texture at all.
  expect(textured.memory.textureBytes - parts.memory.textureBytes).toBeGreaterThan(4_000_000);
  expect(assembled.memory.textureBytes).toBe(parts.memory.textureBytes);
  if (parts.shot && assembled.shot) expect(pixelDiff(parts.shot, assembled.shot)).toBeLessThan(0.01);
});
