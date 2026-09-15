import { describe, expect, it } from 'vitest';
import { Group, InstancedBufferGeometry, Scene, Sprite, SpriteMaterial } from 'three';
import { ClippingGroup } from 'three/webgpu';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { FORGE_HOOK } from '../../src/compiler/culling.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

function sprites(scene: Scene, n: number, material: SpriteMaterial, prefix: string): Sprite[] {
  const out: Sprite[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Sprite(material);
    s.name = `${prefix}-${i}`;
    s.position.set(i, 0, -5 - i);
    scene.add(s);
    out.push(s);
  }
  return out;
}

function setup() {
  const renderer = new FakeRenderer();
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer as never);
  const { scene, camera } = sceneWithCamera();
  const rain = sprites(scene, 6, new SpriteMaterial({ color: 0xffffff, transparent: true, depthWrite: false }), 'rain');
  const hits = sprites(scene, 6, new SpriteMaterial({ color: 0xff4040, transparent: true }), 'hit');
  const singles = sprites(scene, 2, new SpriteMaterial({ color: 0x00ff00 }), 'bar');
  return { renderer, registry, ledger, scene, camera, rain, hits, singles };
}

describe('World sprite batching', () => {
  it('batches sprites per material, hides originals, syncs per frame and restores on decompile', () => {
    const { renderer, registry, ledger, scene, camera, rain, hits, singles } = setup();
    const world = new World(scene, { registry, ledger });
    const report = world.compile();
    expect(report.after.spriteBatches).toBe(2);
    expect(report.skipped.filter((s) => s.rule === 'sprite-threshold').map((s) => s.name)).toEqual(['bar-0', 'bar-1']);
    expect(world.spriteBatches.map((m) => m.name.startsWith('forge:sprites:'))).toEqual([true, true]);
    for (const s of [...rain, ...hits]) expect(s.layers.mask).toBe((1 << FORGE_HIDDEN_LAYER) >>> 0);
    for (const s of singles) expect(s.layers.mask).toBe(1);
    const batch = world.spriteBatches[0]!;
    expect((batch.userData.forge as { kind: string }).kind).toBe('sprites');
    expect((batch.geometry as InstancedBufferGeometry).instanceCount).toBe(6);
    expect((batch.onBeforeRender as unknown as Record<symbol, boolean>)[FORGE_HOOK]).toBe(true);
    rain[2]!.visible = false;
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.byReason['sprite-batch']?.submissions).toBe(2);
    expect(frame.byReason.sprite?.submissions).toBe(2);
    expect(frame.overdraw.particles).toBe(6 + 6 + 2);
    expect(frame.totals.unattributed).toBe(0);
    world.decompile();
    for (const s of [...rain, ...hits]) expect(s.layers.mask).toBe(1);
    expect(scene.children.some((c) => c.name.startsWith('forge:sprites:'))).toBe(false);
    renderer.render(scene, camera);
    // rain-2 was hidden above and stays hidden: 14 sprites minus one.
    expect(ledger.frame().byReason.sprite?.submissions).toBe(13);
  });

  it("leaves sprites alone with sprites: 'keep' and honours spriteThreshold", () => {
    const { registry, ledger, scene } = setup();
    expect(new World(scene, { registry, ledger, sprites: 'keep' }).compile().after.spriteBatches).toBe(0);
    const { registry: r2, ledger: l2, scene: s2 } = setup();
    const report = new World(s2, { registry: r2, ledger: l2, spriteThreshold: 2 }).compile();
    expect(report.after.spriteBatches).toBe(3);
  });

  it('skips sprites under a render-ordered Group ancestor or an enabled ClippingGroup ancestor, naming the rule (root threaded from the scene)', () => {
    const renderer = new FakeRenderer();
    const registry = new MaterialRegistry();
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer as never);
    const { scene } = sceneWithCamera();
    const shared = new SpriteMaterial({ color: 0xffffff });
    const ordered = new Group();
    ordered.renderOrder = 3;
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(shared);
      s.name = `ordered-${i}`;
      ordered.add(s);
    }
    scene.add(ordered);
    const clipper = new ClippingGroup();
    const clipped: Sprite[] = [];
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(shared);
      s.name = `clipped-${i}`;
      clipper.add(s);
      clipped.push(s);
    }
    scene.add(clipper);
    const world = new World(scene, { registry, ledger });
    const report = world.compile();
    expect(report.skipped.filter((s) => s.name.startsWith('ordered-')).map((s) => s.rule)).toEqual(Array(6).fill('group-render-order'));
    expect(report.skipped.filter((s) => s.name.startsWith('clipped-')).map((s) => s.rule)).toEqual(Array(6).fill('clipping-group'));
  });
});
