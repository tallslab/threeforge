/**
 * Task 18: static meshes under an invisible ancestor Group used to be classified `static` and folded into a
 * `BatchedMesh` at the scene root, which is visible by default. Three's own traversal never draws them (a Group's
 * `visible = false` short-circuits its whole subtree in `Renderer.js`'s `_projectObject`), so a naive render and a
 * pre-fix compiled render disagreed on pixels. `exclusionRule`'s `invisible-ancestor` rule (reusing
 * `isVisibleInGraph`) keeps them classified `excluded` and left exactly where they were, under the still-invisible
 * Group, so compiling changes nothing about what is drawn.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';
import { pixelDiff, settle } from './pixels.js';

const OUT = 'test-results/hidden-group';

test('static meshes under an invisible ancestor Group stay excluded from batching: naive and compiled render the same pixels', async ({ forge }) => {
  test.skip(!forge.pixelChecks, 'pixel checks need a native WebGPU adapter');
  await forge.open('empty');

  const built = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const T = f.three;
    const { scene, camera } = f;
    scene.add(new T.AmbientLight(0xffffff, 0.6));
    const sun = new T.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 6, 5);
    scene.add(sun);

    const geometry = new T.BoxGeometry(1, 1, 1);
    const material = new T.MeshStandardMaterial({ color: 0x66aaff, roughness: 0.6 });

    // Five boxes, visible, tagged static, sharing one material: batches into one BatchedMesh.
    const visible: InstanceType<typeof T.Mesh>[] = [];
    for (let i = 0; i < 5; i++) {
      const box = new T.Mesh(geometry, material);
      box.name = `visible-${i}`;
      box.position.set(-4 + i * 2, 0, 0);
      box.userData.forge = 'static';
      visible.push(box);
      scene.add(box);
    }
    // Five more of the same geometry and material, so a pre-fix compile would merge them into the same batch, but
    // parented under a Group whose own `visible` is false: three's renderer skips the whole subtree, so they never
    // appear in the naive render either.
    const hiddenGroup = new T.Group();
    hiddenGroup.name = 'hidden-group';
    hiddenGroup.visible = false;
    const hidden: InstanceType<typeof T.Mesh>[] = [];
    for (let i = 0; i < 5; i++) {
      const box = new T.Mesh(geometry, material);
      box.name = `hidden-${i}`;
      box.position.set(-4 + i * 2, 2.2, 0);
      box.userData.forge = 'static';
      hidden.push(box);
      hiddenGroup.add(box);
    }
    scene.add(hiddenGroup);

    camera.position.set(0, 3, 12);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld();
    scene.updateMatrixWorld(true);
    return { visible: visible.length, hidden: hidden.length };
  });
  expect(built).toEqual({ visible: 5, hidden: 5 });

  const naive = await forge.page.evaluate(() => window.__forge.frame({ items: true }));
  // Three's own traversal already skips the hidden subtree entirely: only the five visible boxes submit.
  expect(naive.totals.sceneSubmissions).toBe(5);
  expect((naive.items ?? []).some((i) => i.name.startsWith('hidden-'))).toBe(false);
  await settle(forge.page, 2);
  const before = await forge.page.screenshot({ type: 'png' });

  const compiled = await forge.page.evaluate(async () => {
    const f = window.__forge;
    const report = f.compile();
    const frame = await f.frameAsync({ items: true });
    return { after: report.after, skipped: report.skipped.filter((s) => s.name.startsWith('hidden-')), totals: frame.totals, items: frame.items ?? [] };
  });
  // The classifier's new `invisible-ancestor` rule, not `static`+batched: every hidden box stays where it was.
  expect(compiled.skipped).toEqual(Array.from({ length: 5 }, (_, i) => ({ name: `hidden-${i}`, rule: 'invisible-ancestor' })));
  expect(compiled.after.batches).toBe(1);
  expect(compiled.totals.unattributed).toBe(0);
  // The compiled scene submits no draw at all for the hidden subtree.
  expect(compiled.items.some((i) => i.name.startsWith('hidden-'))).toBe(false);

  await settle(forge.page, 2);
  const after = await forge.page.screenshot({ type: 'png' });
  mkdirSync(OUT, { recursive: true });
  const tag = forge.backend;
  writeFileSync(`${OUT}/hidden-group-naive-${tag}.png`, before);
  writeFileSync(`${OUT}/hidden-group-compiled-${tag}.png`, after);
  const diff = pixelDiff(before, after, { threshold: 4, diffPath: `${OUT}/hidden-group-diff-${tag}.png` });
  await test.info().attach('hidden-group', { body: JSON.stringify({ backend: forge.backend, naive: naive.totals, compiled: { after: compiled.after, totals: compiled.totals }, diffPct: (diff * 100).toFixed(4) }), contentType: 'application/json' });
  expect(diff).toBeLessThan(0.0005);
});
