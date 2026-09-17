import {
  BoxGeometry,
  type BufferGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type NormalMapTypes,
  ObjectSpaceNormalMap,
  PlaneGeometry,
  PointLight,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TangentSpaceNormalMap,
  type Texture,
} from 'three';
import { color, mix, positionLocal } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { hasNodeSlot } from '../../src/compiler/materialCode.js';
import { World, type WorldOptions } from '../../src/compiler/World.js';
import type { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import type { SubmissionRecord } from '../../src/ledger/snapshot.js';
import type { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { batchedOf, type FakeRenderer } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';
import { box, casting, reasonsIn } from './helpers/ledgerFixtures.js';

// How DrawCallLedger counts the objects behind its hints (shared materials, objects rather than submissions) and
// which compiled draws it names for batch-local-space. The hint wording itself is pinned in hints.test.ts.

describe('DrawCallLedger shared materials: unique-material and static-unbatched', () => {
  const named = <T extends Mesh>(mesh: T, name: string): T => {
    mesh.name = name;
    return mesh;
  };
  const indexOf = (ledger: DrawCallLedger, name: string) =>
    ledger.frame({ items: true }).items!.find((i) => i.name === name)!.material;

  it('calls two statics sharing a material static-unbatched, one alone unique-material', () => {
    // Decided from the frame's draws alone, without a World.
    const { renderer, ledger, scene, camera } = attachedLedger();
    const shared = new MeshStandardMaterial({ color: 0x336699 });
    // Equal by value, but its own instance and never registered: nothing else draws it.
    const own = new MeshStandardMaterial({ color: 0x336699 });
    scene.add(
      named(tag.static(new Mesh(box, shared)), 'a'),
      named(tag.static(new Mesh(new PlaneGeometry(1, 1), shared)), 'b'),
      named(tag.static(new Mesh(box, own)), 'alone'),
    );
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
    expect(frame.byReason['static-unbatched']).toEqual({ submissions: 2, gpuDraws: 2, top: ['a', 'b'] });
    expect(frame.byReason['unique-material']).toEqual({ submissions: 1, gpuDraws: 1, top: ['alone'] });
    expect(indexOf(ledger, 'a')).toBe(indexOf(ledger, 'b'));
    expect(indexOf(ledger, 'alone')).not.toBe(indexOf(ledger, 'a'));
  });

  it('counts uses per registry canonical, which an instance onBeforeRender splits', () => {
    const { renderer, registry, ledger, scene, camera } = attachedLedger();
    const first = new MeshStandardMaterial({ color: 0x884422 });
    const second = new MeshStandardMaterial({ color: 0x884422 });
    registry.register(first);
    registry.register(second);
    expect(registry.canonicalOf(second)).toBe(first);
    const hooked = [0, 1].map(() => {
      const material = new MeshStandardMaterial({ color: 0x224488 });
      material.onBeforeRender = () => {};
      registry.register(material);
      return material;
    });
    expect(registry.canonicalOf(hooked[1]!)).toBe(hooked[1]);
    // The meshes keep their own instances: no World swapped the canonicals in.
    scene.add(
      named(tag.static(new Mesh(box, first)), 'merged-1'),
      named(tag.static(new Mesh(box, second)), 'merged-2'),
      named(tag.static(new Mesh(box, hooked[0]!)), 'hooked-1'),
      named(tag.static(new Mesh(box, hooked[1]!)), 'hooked-2'),
    );
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({
      'merged-1': 'static-unbatched',
      'merged-2': 'static-unbatched',
      'hooked-1': 'unique-material',
      'hooked-2': 'unique-material',
    });
    expect(indexOf(ledger, 'merged-1')).toBe(indexOf(ledger, 'merged-2'));
    expect(indexOf(ledger, 'hooked-1')).not.toBe(indexOf(ledger, 'hooked-2'));
  });

  it('counts uses per object: a static drawn twice is not shared with itself', () => {
    // The back-side pass of a double-sided transmissive material draws it a second time.
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(
      named(tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }))), 'glass'),
    );
    renderer.render(scene, camera);
    const glass = ledger.frame({ items: true }).items!.filter((i) => i.pass === 'main' && i.name === 'glass');
    expect(glass).toHaveLength(2);
    expect(glass.map((i) => i.reason)).toEqual(['unique-material', 'unique-material']);
    expect(glass[0]!.material).toBe(glass[1]!.material);
  });

  it('counts main-pass uses only, and relabels a shared static in every pass it draws in', () => {
    const sun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: sun });
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const caster = named(tag.static(new Mesh(box, stone)), 'caster');
    caster.castShadow = true;
    // Drawn in the main pass and, through its hook, the only user of `paint` in the main pass: a second scene draws it too.
    const paint = new MeshStandardMaterial({ color: 0x3355ff });
    const portal = named(tag.static(new Mesh(box, paint)), 'portal');
    const room = new Scene();
    room.name = 'room';
    room.add(named(tag.static(new Mesh(box, paint)), 'far-wall'));
    let inside = false;
    portal.onBeforeRender = ((r: unknown) => {
      if (inside) return;
      inside = true;
      (r as FakeRenderer).render(room, camera);
      inside = false;
    }) as Mesh['onBeforeRender'];
    scene.add(sun, caster, named(tag.static(new Mesh(box, stone)), 'plinth'), portal);
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({
      caster: 'static-unbatched',
      plinth: 'static-unbatched',
      portal: 'unique-material',
    });
    expect(reasonsIn(ledger, 'shadow:sun')).toEqual({ caster: 'static-unbatched' });
    expect(reasonsIn(ledger, 'scene:room')).toEqual({ 'far-wall': 'unique-material' });
  });

  it("counts no use for renderer-internal work: a static sharing the output quad's material stays unique-material", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const shared = new MeshStandardMaterial({ color: 0x66aa44 });
    // three's output quad is the renderer's own object, drawn in the main pass and filed as renderer-internal.
    renderer.outputQuad.material = shared;
    scene.add(named(tag.static(new Mesh(box, shared)), 'alone'));
    renderer.render(scene, camera);

    const items = ledger.frame({ items: true }).items!;
    const quad = items.find((i) => i.name === 'Output Color Transform')!;
    const alone = items.find((i) => i.name === 'alone')!;
    expect(quad.reason).toBe('renderer-internal');
    // The quad's submission is still indexed (every record carries a material index, and it is the same canonical)
    // but it counts as no user, so the scene's static is still the only object drawing that material.
    expect(quad.material).toBe(alone.material);
    expect(reasonsIn(ledger)).toEqual({ alone: 'unique-material' });
  });

  it('counts no use from a measureOverdraw() started by a hook of the frame', async () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const a = named(tag.static(new Mesh(box, stone)), 'a');
    const b = named(tag.static(new Mesh(box, stone)), 'b');
    scene.add(a, b, named(tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x224466 }))), 'alone'));
    renderer.render(scene, camera);
    const plain = ledger.frame({ items: true });

    let pending: Promise<unknown> | null = null;
    let started = false;
    a.onBeforeRender = () => {
      // Measure once: the count render draws `a` again and calls this hook with it.
      if (started) return;
      started = true;
      pending = ledger.measureOverdraw(scene, camera);
    };
    renderer.render(scene, camera);
    const hooked = ledger.frame({ items: true });
    a.onBeforeRender = () => {};
    expect(pending).not.toBeNull();
    await pending;

    // The count renders drew every object again with the count material; none of it was filed, so the frame's
    // material indices and reasons are exactly those of the frame before it.
    const keyed = (frame: typeof plain) => frame.items!.map((i) => [i.name, i.material, i.reason]);
    expect(keyed(hooked)).toEqual(keyed(plain));
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
  });

  it('indexes materials per frame in first-draw order; held items keep their values', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff });
    const lead = named(tag.static(new Mesh(box, red)), 'lead');
    const twin = named(tag.static(new Mesh(box, blue)), 'twin');
    const other = named(tag.static(new Mesh(box, blue)), 'other');
    scene.add(lead, twin, other);
    renderer.render(scene, camera);
    const scene1 = (items: SubmissionRecord[]) =>
      items.filter((i) => i.reason !== 'renderer-internal').map((i) => [i.name, i.material, i.reason]);
    const first = ledger.frame({ items: true }).items!;
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
    lead.visible = false;
    other.visible = false;
    renderer.render(scene, camera);
    expect(scene1(ledger.frame({ items: true }).items!)).toEqual([['twin', 0, 'unique-material']]);
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
  });
});

describe('DrawCallLedger hints count objects, not submissions', () => {
  /** The object count the hint with `code` opens its message with; undefined without the hint. The wording is pinned above. */
  const countOf = (ledger: DrawCallLedger, code: string): number | undefined => {
    const hint = ledger.frame().hints.find((h) => h.code === code);
    return hint && Number(/^\d+/.exec(hint.message)?.[0]);
  };

  it('counts 11 casting statics under a sun as 11 meshes, below the unique-materials threshold', () => {
    const sun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: sun });
    scene.add(sun);
    for (let i = 0; i < 11; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x101010 * (i + 1) })));
      mesh.name = `statue-${i}`;
      mesh.castShadow = true;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unique-material']?.submissions, 'main and shadow pass').toBe(22);
    expect(countOf(ledger, 'unique-materials')).toBeUndefined();
    for (let i = 11; i < 21; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x0f0f0f * (i + 1) })));
      mesh.name = `statue-${i}`;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(countOf(ledger, 'unique-materials')).toBe(21);
  });

  it('counts one untagged caster under a point light as one untagged mesh, not seven', () => {
    const lamp = casting(new PointLight(0xffffff, 1), 'lamp');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: lamp });
    const crate = new Mesh(box, new MeshStandardMaterial());
    crate.name = 'crate';
    crate.castShadow = true;
    scene.add(lamp, crate);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason.untagged?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(countOf(ledger, 'untagged')).toBe(1);
  });

  it("counts a double-sided transmissive mesh once although the main pass draws it twice (three's back-side pass)", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const glass = new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }));
    glass.name = 'glass';
    scene.add(glass);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items!.filter((i) => i.name === 'glass' && i.pass === 'main')).toHaveLength(2);
    expect(countOf(ledger, 'untagged')).toBe(1);
  });

  it('counts unsupported-material by distinct objects over every pass', () => {
    const lamp = casting(new PointLight(0xffffff, 1), 'lamp');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: lamp });
    const panel = tag.static(new Mesh(box, new ShaderMaterial()));
    panel.name = 'panel';
    panel.castShadow = true;
    scene.add(lamp, panel);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unsupported-material']?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(countOf(ledger, 'unsupported-material')).toBe(1);
    // On a layer the main camera does not see, so only the six shadow faces draw it. Its material renders nowhere on
    // WebGPU either, so it is still a mesh this error hint names, although no main-pass record carries it.
    const offCamera = tag.static(new Mesh(box, new ShaderMaterial()));
    offCamera.name = 'off-camera';
    offCamera.castShadow = true;
    offCamera.layers.set(1);
    lamp.shadow.camera.layers.enable(1);
    scene.add(offCamera);
    renderer.render(scene, camera);
    const drawn = ledger.frame({ items: true }).items!.filter((i) => i.name === 'off-camera');
    expect(drawn.map((i) => i.pass)).toEqual(Array(6).fill('shadow:lamp'));
    expect(ledger.frame().byReason['unsupported-material']?.submissions).toBe(13);
    expect(countOf(ledger, 'unsupported-material')).toBe(2);
    ledger.rescan();
    expect(countOf(ledger, 'unsupported-material')).toBe(2);
  });

  it('counts sprites drawn one by one as objects, kept on a rescan between frames', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const material = new SpriteMaterial();
    for (let i = 0; i < 8; i++) scene.add(new Sprite(material));
    renderer.render(scene, camera);
    expect(countOf(ledger, 'sprites-unbatched')).toBe(8);
    ledger.rescan();
    expect(countOf(ledger, 'sprites-unbatched')).toBe(8);
  });
});

/**
 * `batch-local-space`: three r186 gives a batched or instanced draw `positionLocal` multiplied by its instance matrix
 * (Batch.js:148, Instance.js:206-207), and a baked mesh's positions are written in scene space, so a node reading
 * `positionLocal` and `alphaHash` (which hashes it, NodeMaterial.js:893) may draw differently than the individual
 * meshes. The ledger names World's compiled draws whose material has a node in a slot (`hasNodeSlot`) or `alphaHash`,
 * and nothing else.
 */
describe('DrawCallLedger batch-local-space hint', () => {
  const CODE = 'batch-local-space';
  const hint = (ledger: DrawCallLedger) => ledger.frame().hints.find((h) => h.code === CODE);
  const gradient = (): Material =>
    Object.assign(new MeshStandardNodeMaterial(), {
      name: 'gradient',
      colorNode: mix(color(0x2040ff), color(0xff8020), positionLocal.y.add(0.5)),
    });
  const hashed = (): Material => new MeshStandardMaterial({ name: 'hashed', alphaHash: true, opacity: 0.5 });
  const engraved = (
    normalMapType: NormalMapTypes = ObjectSpaceNormalMap,
    normalMap: Texture | null = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
  ): Material => new MeshStandardMaterial({ name: 'engraved', normalMap, normalMapType });

  /**
   * `count` transformed boxes sharing `material` (or the material `material(registry)` returns, given the ledger's
   * registry, which World uses too), tagged static (or dynamic), compiled by World, then one frame rendered.
   */
  function compiled(
    source: Material | ((registry: MaterialRegistry) => Material),
    options: { count?: number; dynamic?: boolean; world?: WorldOptions; geometry?: BufferGeometry } = {},
  ) {
    const { renderer, registry, ledger, scene, camera } = attachedLedger();
    const material = typeof source === 'function' ? source(registry) : source;
    for (let i = 0; i < (options.count ?? 4); i++) {
      const mesh = new Mesh(options.geometry ?? box, material);
      mesh.name = `box-${i}`;
      mesh.position.set(i * 1.5 - 2, 0, 0);
      mesh.rotation.set(0.3, i * 0.2, 0.4);
      mesh.scale.set(1, 1.6, 0.8);
      scene.add(options.dynamic ? tag.dynamic(mesh) : tag.static(mesh));
    }
    scene.updateMatrixWorld(true);
    const world = new World(scene, { registry, ledger, ...options.world });
    const report = world.compile();
    renderer.render(scene, camera);
    return { renderer, ledger, scene, camera, world, report };
  }

  it('fires for a batch whose material has a node in a slot, naming the batch and the material', () => {
    const { ledger, report } = compiled(gradient());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toMatchObject({
      category: 'drawCalls',
      severity: 'warn',
      code: CODE,
      objects: [report.groups[0]!.name],
    });
    expect(hint(ledger)?.message.endsWith('(materials: gradient)')).toBe(true);
    expect(report.groups[0]!.name.startsWith('forge:batch:')).toBe(true);
  });

  it('fires for a batch whose material has alphaHash', () => {
    const { ledger, report } = compiled(hashed());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toMatchObject({ severity: 'warn', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: hashed)')).toBe(true);
  });

  it('fires for a batch with an object-space normal map, not tangent-space or mapless', () => {
    const { ledger, report } = compiled(engraved());
    expect(report.after.batches).toBe(1);
    expect(hint(ledger)).toMatchObject({ severity: 'warn', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: engraved)')).toBe(true);
    for (const [label, material] of [
      ['a tangent-space normal map', engraved(TangentSpaceNormalMap)],
      ['ObjectSpaceNormalMap without a normalMap', engraved(ObjectSpaceNormalMap, null)],
    ] as Array<[string, Material]>) {
      const silent = compiled(material);
      expect(silent.report.after.batches, label).toBe(1);
      expect(hint(silent.ledger), label).toBeUndefined();
    }
  });

  it('fires for instanced groups and a baked group of such materials, one name per group', () => {
    // A level attached by hand (what prepareLods stores): the group draws as two InstancedMeshes sharing its material.
    const leveled = new BoxGeometry(1, 1, 1);
    leveled.userData.forgeLods = [new BoxGeometry(1, 1, 1)];
    const node = compiled(gradient(), { geometry: leveled, world: { instanceThreshold: 4, lod: { distances: [30] } } });
    expect(node.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 2, baked: 0 }));
    expect(node.world.instancedMeshes.map((m) => m.material)).toEqual([
      node.world.instancedMeshes[0]!.material,
      node.world.instancedMeshes[0]!.material,
    ]);
    expect(hint(node.ledger)?.objects).toEqual([node.report.groups[0]!.name]);
    expect(hint(node.ledger)?.message.startsWith('1 threeforge batched, instanced or baked draw uses')).toBe(true);
    expect(node.report.groups[0]!.name.startsWith('forge:instanced:')).toBe(true);
    const hash = compiled(hashed(), { world: { instanceThreshold: 4 } });
    expect(hash.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 1, baked: 0 }));
    expect(hint(hash.ledger)?.objects).toEqual([hash.report.groups[0]!.name]);
    // The bake writes every module in scene space, so its positions are what batching would hand positionLocal. A node
    // material never bakes (bakeProvesReads); alphaHash does.
    const baked = compiled(hashed(), { world: { bake: true } });
    expect(baked.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 1 }));
    expect(hint(baked.ledger)?.objects).toEqual([baked.report.groups[0]!.name]);
    // An object-space normal map bakes too, and three transforms its normals by the baked mesh's (the scene's) matrix.
    for (const world of [{ instanceThreshold: 4 }, { bake: true }] as WorldOptions[]) {
      const normals = compiled(engraved(), { world });
      expect(normals.report.after.batches + normals.report.after.instanced + normals.report.after.baked).toBe(1);
      expect(normals.report.after.batches, JSON.stringify(world)).toBe(0);
      expect(hint(normals.ledger)?.objects, JSON.stringify(world)).toEqual([normals.report.groups[0]!.name]);
    }
  });

  it('fires for a subclass or own-function material even with no node slot set', () => {
    // A subclass can read `positionLocal` from an overridden `setup*` without ever assigning a `*Node` property, so
    // `hasNodeSlot` alone misses it: the same class `bakeProvesReads` (`bakeGate.ts`) refuses and `spriteRule` names
    // `sprite-custom-material`. Here `setupPosition` displaces along `positionLocal`, which batching replaces with the
    // scene-space position.
    class Ripple extends MeshStandardNodeMaterial {
      override setupPosition(
        ...args: Parameters<MeshStandardNodeMaterial['setupPosition']>
      ): ReturnType<MeshStandardNodeMaterial['setupPosition']> {
        void args;
        return positionLocal.add(positionLocal.y.mul(0.1)) as ReturnType<MeshStandardNodeMaterial['setupPosition']>;
      }
    }
    const subclass = Object.assign(new Ripple(), { name: 'ripple' }) as unknown as Material;
    expect(hasNodeSlot(subclass)).toBe(false); // no *Node own property
    const sub = compiled(subclass);
    expect(sub.report.after.batches).toBe(1);
    expect(hint(sub.ledger)?.objects).toEqual([sub.report.groups[0]!.name]);
    expect(hint(sub.ledger)?.message.endsWith('(materials: ripple)')).toBe(true);

    // An own function on a built-in instance is the same risk without a subclass: `setup` can read positionLocal.
    const own = new MeshStandardNodeMaterial();
    own.name = 'hooked';
    (own as unknown as { setup: () => unknown }).setup = () => positionLocal;
    expect(hasNodeSlot(own as unknown as Material)).toBe(false);
    const hooked = compiled(own as unknown as Material);
    expect(hooked.report.after.batches).toBe(1);
    expect(hint(hooked.ledger)?.objects).toEqual([hooked.report.groups[0]!.name]);
  });

  it('stays silent for a plain registered material and a node material with empty slots', () => {
    const plain = (registry: MaterialRegistry): Material =>
      registry.register(new MeshStandardMaterial({ color: 0x808080 }));
    for (const [label, material] of [
      ['registered MeshStandardMaterial', plain],
      ['MeshStandardNodeMaterial without nodes', new MeshStandardNodeMaterial()],
    ] as Array<[string, Material | typeof plain]>) {
      const { ledger, report } = compiled(material);
      expect(report.after.batches, label).toBe(1);
      expect(hint(ledger), label).toBeUndefined();
      ledger.rescan();
      expect(hint(ledger), label).toBeUndefined();
    }
  });

  it('stays silent for individual dynamics, fires once batch-sync batches them', () => {
    for (const [label, material] of [
      ['node slot', gradient()],
      ['alphaHash', hashed()],
      ['object-space normal map', engraved()],
    ] as Array<[string, Material]>) {
      const separate = compiled(material, { dynamic: true });
      expect(separate.report.after, label).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 0 }));
      expect(separate.ledger.frame().byReason.dynamic?.submissions, label).toBe(4);
      expect(hint(separate.ledger), label).toBeUndefined();
      const synced = compiled(material, { dynamic: true, world: { dynamics: 'batch-sync' } });
      expect(synced.report.after.batches, label).toBe(1);
      expect(hint(synced.ledger)?.objects, label).toEqual([synced.report.groups[0]!.name]);
    }
  });

  it('names only what three renders and what World compiled', () => {
    const { ledger, world, scene, renderer, camera } = compiled(gradient());
    expect(hint(ledger)).toBeDefined();
    world.batchedMeshes[0]!.visible = false;
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    world.batchedMeshes[0]!.visible = true;
    ledger.rescan();
    expect(hint(ledger)).toBeDefined();
    world.decompile();
    renderer.render(scene, camera);
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    // An app's own BatchedMesh is not threeforge's to explain.
    scene.add(tag.static(batchedOf(2, gradient(), box)));
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
  });
});
