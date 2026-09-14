import { expect, test } from './fixtures.js';

/** createLoader decodes Draco and meshopt content; a tracked subtree, released, returns the renderer's counts to where they were. */
for (const asset of ['Duck-Draco', 'BrainStem-Meshopt']) {
  test(`memory: ${asset} loads through createLoader and releases without leaks`, async ({ forge }) => {
    await forge.open('empty');
    const r = await forge.page.evaluate(async (name) => {
      const f = window.__forge;
      await f.frameAsync();
      const before = f.memory.info();
      const loaded = await f.memory.load(name);
      await f.frameAsync();
      const during = f.memory.info();
      f.memory.remove(); // removed without dispose: the recount must notice
      await f.frameAsync();
      const removed = f.memory.info().unreferenced;
      f.memory.release();
      await f.frameAsync();
      const after = f.memory.info();
      return { before, loaded, during, removed, after };
    }, asset);
    console.log(`memory ${asset}:`, JSON.stringify(r));
    expect(r.loaded.geometries).toBeGreaterThan(0);
    expect(r.during.geometries).toBeGreaterThan(r.before.geometries);
    expect(r.during.unreferenced).toEqual({ geometries: 0, textures: 0 });
    expect(r.removed.geometries).toBeGreaterThan(0);
    expect(r.after.geometries).toBe(r.before.geometries);
    expect(r.after.textures).toBe(r.before.textures);
    expect(r.after.unreferenced).toEqual({ geometries: 0, textures: 0 });
  });
}
