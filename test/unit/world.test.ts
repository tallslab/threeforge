import {
  AnimationClip,
  type BatchedMesh,
  Color,
  DirectionalLight,
  Group,
  type InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import { FORGE_HOOK } from '../../src/compiler/culling.js';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { attachedLedger } from './helpers/ledger.js';
import { batchesIn, box, dodeca, meshesIn, mixedScene, solid, texture } from './helpers/worldScene.js';

const OWN = (object: object, key: string): boolean => Object.hasOwn(object, key);

describe('World.compile', () => {
  it('batches statics per material variant and leaves dynamic, skinned, untagged alone', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    const report = world.compile();

    const batches = batchesIn(scene);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.instanceCount).sort()).toEqual([2, 4]);
    expect(batches.every((b) => b.parent === scene)).toBe(true);
    expect(batches.every((b) => /^forge:batch:[0-9a-f]{8}:\d+$/.test(b.name))).toBe(true);

    expect(report.before).toEqual({ meshes: 9, materials: 9 });
    expect(report.after).toEqual({ batches: 2, instanced: 0, baked: 0, spriteBatches: 0, frozen: 0, meshes: 3 });
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((g) => g.instances).sort()).toEqual([2, 4]);
    expect(report.groups.find((g) => g.instances === 4)?.geometries).toBe(2);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { name: 'dynamic', rule: 'tag:dynamic' },
        { name: 'skinned', rule: 'skinned-mesh' },
        { name: 'untagged', rule: 'untagged' },
      ]),
    );
    expect(report.registry.programs).toBeGreaterThan(0);
  });

  it('hides originals on the reserved layer with matrix updates off, keeping their parent links', () => {
    const { scene, statics, dynamic } = mixedScene();
    new World(scene).compile();
    for (const m of statics) {
      expect(m.parent).toBe(scene);
      expect(m.layers.mask).toBe((1 << FORGE_HIDDEN_LAYER) >>> 0);
      expect(m.matrixAutoUpdate).toBe(false);
      expect(m.visible).toBe(true);
    }
    expect(dynamic.layers.mask).toBe(1);
    expect(dynamic.matrixAutoUpdate).toBe(true);
  });

  it('copies per-instance transforms and colours and gives the batch a white clone', () => {
    const { scene, statics } = mixedScene();
    const world = new World(scene);
    world.compile();
    const batch = batchesIn(scene).find((b) => b.instanceCount === 4)!;
    const matrix = new Matrix4();
    const color = new Color();
    for (const m of statics) {
      const slot = world.slotOf(m)!;
      expect(slot.batch).toBe(batch);
      batch.getMatrixAt(slot.instanceId, matrix);
      // Instance matrices live in a Float32 data texture, so compare with float tolerance.
      matrix.elements.forEach((e, i) => expect(e).toBeCloseTo(m.matrixWorld.elements[i]!, 5));
      batch.getColorAt(slot.instanceId, color);
      expect(color.getHex()).toBe((m.material as MeshStandardMaterial).color.getHex());
    }
    const material = batch.material as MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0xffffff);
    expect(statics.map((m) => m.material)).not.toContain(material);
    expect(material.roughness).toBe(0.7);
  });

  it('sizes the batch buffers from the unique geometries and precomputes bounds', () => {
    const { scene } = mixedScene();
    new World(scene).compile();
    const batch = batchesIn(scene).find((b) => b.instanceCount === 4)!;
    expect(batch.maxInstanceCount).toBe(4);
    expect(batch.unusedVertexCount).toBe(0);
    expect(batch.unusedIndexCount).toBe(0);
    expect(batch.boundingSphere).not.toBeNull();
    expect(batch.boundingBox).not.toBeNull();
  });

  it('never batches a singleton but still canonicalises its material', () => {
    const scene = new Scene();
    const a = tag.static(new Mesh(box, solid(0xabcdef)));
    const b = tag.dynamic(new Mesh(box, solid(0xabcdef)));
    scene.add(a, b);
    const report = new World(scene).compile();
    expect(batchesIn(scene)).toHaveLength(0);
    expect(report.after).toEqual({ batches: 0, instanced: 0, baked: 0, spriteBatches: 0, frozen: 1, meshes: 2 });
    expect(a.matrixAutoUpdate).toBe(false);
    expect(b.matrixAutoUpdate).toBe(true);
    expect(a.material).toBe(b.material);
  });

  it('splits groups on castShadow/receiveShadow and copies the flags onto the batch', () => {
    const scene = new Scene();
    const meshes = [0, 1, 2, 3].map(() => tag.static(new Mesh(box, solid(0xffffff))));
    meshes[0]!.castShadow = meshes[1]!.castShadow = true;
    scene.add(...meshes);
    new World(scene).compile();
    const batches = batchesIn(scene);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.castShadow).sort()).toEqual([false, true]);
  });

  it('splits groups on geometry attribute signature and sorts only transparent batches', () => {
    const scene = new Scene();
    const noUv = box.clone();
    noUv.deleteAttribute('uv');
    scene.add(
      tag.static(new Mesh(box, solid(1))),
      tag.static(new Mesh(box, solid(2))),
      tag.static(new Mesh(noUv, solid(3))),
      tag.static(new Mesh(noUv, solid(4))),
      tag.static(new Mesh(box, solid(5, { transparent: true, opacity: 0.5 }))),
      tag.static(new Mesh(box, solid(6, { transparent: true, opacity: 0.5 }))),
    );
    new World(scene).compile();
    const batches = batchesIn(scene);
    expect(batches).toHaveLength(3);
    const transparent = batches.filter((b) => (b.material as MeshStandardMaterial).transparent);
    expect(transparent).toHaveLength(1);
    expect(transparent[0]!.sortObjects).toBe(true);
    expect(
      batches.filter((b) => !(b.material as MeshStandardMaterial).transparent).every((b) => b.sortObjects === false),
    ).toBe(true);
  });

  it('annotates excluded statics in the ledger so their submissions carry the rule', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mirrored = tag.static(new Mesh(box, solid(1)));
    mirrored.name = 'mirrored';
    mirrored.scale.x = -1;
    scene.add(mirrored, tag.static(new Mesh(box, solid(1))));
    new World(scene, { ledger }).compile();
    renderer.render(scene, camera);
    const item = ledger.frame({ items: true }).items?.find((i) => i.name === 'mirrored');
    expect(item?.reason).toBe('excluded:mirrored');
  });

  it("transparent: 'keep' leaves transparent statics unbatched and reports/annotates them transparent-kept", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const glassA = tag.static(new Mesh(box, solid(5, { transparent: true, opacity: 0.5 })));
    const glassB = tag.static(new Mesh(box, solid(6, { transparent: true, opacity: 0.5 })));
    glassA.name = 'glass-a';
    glassB.name = 'glass-b';
    scene.add(glassA, glassB, tag.static(new Mesh(box, solid(1))), tag.static(new Mesh(box, solid(2))));
    const report = new World(scene, { ledger, transparent: 'keep' }).compile();
    renderer.render(scene, camera);

    // Only the opaque group batches; the two transparent statics stay individual meshes.
    const batches = batchesIn(scene);
    expect(batches).toHaveLength(1);
    expect((batches[0]!.material as MeshStandardMaterial).transparent).toBe(false);
    expect(
      report.skipped
        .filter((s) => s.rule === 'transparent-kept')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['glass-a', 'glass-b']);

    const items = ledger.frame({ items: true }).items ?? [];
    expect(items.find((i) => i.name === 'glass-a')?.reason).toBe('excluded:transparent-kept');
    expect(items.find((i) => i.name === 'glass-b')?.reason).toBe('excluded:transparent-kept');
  });

  it("defaults transparent to 'batch': transparent statics still form a sorted batch", () => {
    const scene = new Scene();
    scene.add(
      tag.static(new Mesh(box, solid(5, { transparent: true, opacity: 0.5 }))),
      tag.static(new Mesh(box, solid(6, { transparent: true, opacity: 0.5 }))),
    );
    new World(scene).compile();
    const batches = batchesIn(scene);
    expect(batches).toHaveLength(1);
    expect((batches[0]!.material as MeshStandardMaterial).transparent).toBe(true);
    expect(batches[0]!.sortObjects).toBe(true);
  });
});

describe('World.compile that throws', () => {
  const hookRestores = (world: World): number =>
    (world as unknown as { sceneHookRestores: unknown[] }).sceneHookRestores.length;

  it('uninstalls the pass tracker hooks when compile throws, so a retry installs once', () => {
    const { scene } = mixedScene();
    const clip = new AnimationClip('broken', 1, [new NumberKeyframeTrack('.', [0, 1], [0, 1])]);
    const animations: AnimationClip[] = [clip];
    const world = new World(scene, { animations });
    expect(() => world.compile()).toThrow();
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks left installed').toBe(
      false,
    );
    expect(hookRestores(world)).toBe(0);
    animations.length = 0;
    world.compile();
    expect(OWN(scene, 'onBeforeRender') && OWN(scene, 'onAfterRender'), 'pass tracker hooks installed').toBe(true);
    expect(hookRestores(world), 'the tracker is installed once').toBe(1);
    world.decompile();
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender')).toBe(false);
  });

  it('uninstalls the pass tracker hooks when batching throws', () => {
    const { scene } = mixedScene();
    class Failing extends MaterialRegistry {
      override register(material: Material): Material {
        throw new Error(`refused ${material.type}`);
      }
    }
    const world = new World(scene, { registry: new Failing() });
    expect(() => world.compile()).toThrow('refused');
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks left installed').toBe(
      false,
    );
    expect(hookRestores(world)).toBe(0);
  });
});

describe('World.decompile', () => {
  it('restores the original graph, materials, layers and matrix flags, and can compile again', () => {
    const { scene, statics, dynamic } = mixedScene();
    const originalMaterials = meshesIn(scene).map((m) => m.material);
    const world = new World(scene);
    world.compile();
    world.decompile();
    expect(batchesIn(scene)).toHaveLength(0);
    expect(meshesIn(scene)).toHaveLength(9);
    expect(meshesIn(scene).map((m) => m.material)).toEqual(originalMaterials);
    for (const m of [...statics, dynamic]) {
      expect(m.layers.mask).toBe(1);
      expect(m.matrixAutoUpdate).toBe(true);
    }
    const report = world.compile();
    expect(report.after.batches).toBe(2);
  });

  it('freezes all-static groups and lone statics at compile, restores them on decompile', () => {
    const { scene, statics } = mixedScene();
    const props = new Group();
    props.name = 'props';
    scene.add(props);
    props.add(statics[0]!, statics[1]!);
    // A distinct material variant so it stays a singleton (a colour-only difference would join the batch).
    const single = tag.static(
      new Mesh(box, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })),
    );
    single.name = 'single';
    scene.add(single);
    // An empty container, an anchor with no children, and a light's target: none is a static leaf, so none may be
    // frozen — freezing `light.target` would stop DayNight from ever rotating it again.
    const anchor = new Group();
    anchor.name = 'anchor';
    const light = new DirectionalLight();
    light.name = 'light';
    scene.add(anchor, light, light.target);
    const world = new World(scene);
    const report = world.compile();
    expect(report.after.frozen).toBe(2);
    expect(world.frozenObjects.map((o) => o.name).sort()).toEqual(['props', 'single']);
    expect(props.matrixAutoUpdate).toBe(false);
    expect(single.matrixAutoUpdate).toBe(false);
    expect(anchor.matrixAutoUpdate).toBe(true);
    expect(light.target.matrixAutoUpdate).toBe(true);
    world.decompile();
    expect(props.matrixAutoUpdate).toBe(true);
    expect(single.matrixAutoUpdate).toBe(true);
    expect(world.frozenObjects).toEqual([]);
    const off = new World(scene, { freeze: false }).compile();
    expect(off.after.frozen).toBe(0);
    expect(single.matrixAutoUpdate).toBe(true);
  });

  it('with originals: "detach", removes originals from the graph and reattaches them at their old index', () => {
    const { scene, statics } = mixedScene();
    const group = new Group();
    group.name = 'props';
    scene.add(group);
    group.add(statics[0]!);
    const childrenBefore = [...scene.children];
    const world = new World(scene, { originals: 'detach' });
    world.compile();
    expect(statics[0]!.parent).toBeNull();
    expect(statics[1]!.parent).toBeNull();
    world.decompile();
    expect(statics[0]!.parent).toBe(group);
    expect(scene.children).toEqual(childrenBefore);
  });

  it('leaves a hand-written matrix alone when freezing, and through markDirty', () => {
    const { scene, statics } = mixedScene();
    // Placed through `matrix` with auto-update off: position, quaternion and scale stay at identity.
    const single = tag.static(
      new Mesh(box, new MeshStandardMaterial({ color: 0x999999, roughness: 0.1, metalness: 0.9 })),
    );
    single.matrixAutoUpdate = false;
    single.matrix.makeTranslation(5, 0, 0);
    const batched = statics[0]!;
    batched.matrixAutoUpdate = false;
    batched.matrix.makeTranslation(0, 7, 0);
    scene.add(single);
    const world = new World(scene);
    world.compile();
    expect(world.frozenObjects).toContain(single);
    expect(single.matrix.elements[12]).toBe(5);
    expect(batched.matrix.elements[13]).toBe(7);
    world.markDirty(scene);
    expect(single.matrix.elements[12]).toBe(5);
    expect(batched.matrix.elements[13]).toBe(7);
    world.decompile();
    expect(single.matrix.elements[12]).toBe(5);
    expect(single.matrixAutoUpdate).toBe(false);
    expect(batched.matrixAutoUpdate).toBe(false);
  });

  it('with originals: "detach", hides a batched parent that still has a live child', () => {
    const { scene, statics, dynamic } = mixedScene();
    const parent = statics[0]!;
    parent.add(dynamic);
    const world = new World(scene, { originals: 'detach' });
    world.compile();
    let reachable = false;
    scene.traverse((o) => {
      if (o === dynamic) reachable = true;
    });
    expect(reachable).toBe(true);
    expect(parent.parent).toBe(scene);
    expect(parent.layers.mask).toBe((1 << FORGE_HIDDEN_LAYER) >>> 0);
    expect(statics[1]!.parent).toBeNull();
    parent.position.x = 4;
    world.markDirty(parent);
    scene.updateMatrixWorld();
    expect(dynamic.matrixWorld.elements[12]).toBe(4);
    world.decompile();
    expect(parent.layers.mask).toBe(1);
    expect(dynamic.parent).toBe(parent);
  });
});

describe('World.resolve', () => {
  it('maps a raycast hit on a batch back to the original mesh', () => {
    const { scene, statics } = mixedScene();
    const world = new World(scene);
    world.compile();
    const target = statics[2]!; // box at x = 6
    const raycaster = new Raycaster(new Vector3(6, 10, 0), new Vector3(0, -1, 0));
    raycaster.layers.set(0);
    const hits = raycaster.intersectObjects([...world.batchedMeshes], false);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect((hit.object as BatchedMesh).isBatchedMesh).toBe(true);
    expect(world.resolve(hit)).toBe(target);
  });

  it('returns the hit object itself for non-batched hits', () => {
    const { scene, dynamic } = mixedScene();
    const world = new World(scene);
    world.compile();
    const hit = { object: dynamic } as unknown as Parameters<World['resolve']>[0];
    expect(world.resolve(hit)).toBe(dynamic);
  });
});

describe('World culling', () => {
  const hasForgeHook = (b: BatchedMesh) =>
    Object.hasOwn(b, 'onBeforeRender') && (b.onBeforeRender as unknown as Record<symbol, unknown>)[FORGE_HOOK] === true;

  it('installs BVH culling on every batch by default and removes it on decompile', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    world.compile();
    const batches = batchesIn(scene);
    expect(batches.length).toBe(2);
    expect(batches.every(hasForgeHook)).toBe(true);
    world.decompile();
    expect(batches.every((b) => !Object.hasOwn(b, 'onBeforeRender'))).toBe(true);
  });

  it('leaves three\'s linear culling in place with culling: "linear"', () => {
    const { scene } = mixedScene();
    new World(scene, { culling: 'linear' }).compile();
    expect(batchesIn(scene).some(hasForgeHook)).toBe(false);
  });

  it('reports the culling mode and coordinate system in the compile report', () => {
    const { scene } = mixedScene();
    const report = new World(scene).compile({ coordinateSystem: 2001 });
    expect(report.culling).toEqual({ mode: 'bvh', coordinateSystem: 2001 });
  });
});

describe('World instancing', () => {
  function repeatedScene(boxes: number, spheres: number) {
    const scene = new Scene();
    for (let i = 0; i < boxes; i++) {
      const m = tag.static(new Mesh(box, solid(0x2244ff)));
      m.name = `box-${i}`;
      m.position.set(i * 2, 0, 0);
      scene.add(m);
    }
    for (let i = 0; i < spheres; i++) {
      const m = tag.static(new Mesh(dodeca, solid(0xff2244)));
      m.name = `sphere-${i}`;
      m.position.set(i * 2, 5, 0);
      scene.add(m);
    }
    return scene;
  }

  it('instances a geometry repeated instanceThreshold times and batches the rest', () => {
    const scene = repeatedScene(70, 5);
    const world = new World(scene);
    const report = world.compile();
    const instanced = meshesIn(scene).filter((m): m is InstancedMesh => (m as InstancedMesh).isInstancedMesh);
    expect(instanced).toHaveLength(1);
    expect(instanced[0]!.userData.forge).toEqual({ instances: 70, lodLevel: 0 });
    expect(instanced[0]!.name).toMatch(/^forge:instanced:[0-9a-f]{8}:\d+$/);
    expect(batchesIn(scene)).toHaveLength(1);
    expect(batchesIn(scene)[0]!.instanceCount).toBe(5);
    expect(report.after).toEqual({ batches: 1, instanced: 1, baked: 0, spriteBatches: 0, frozen: 0, meshes: 0 });
  });

  it('respects instanceThreshold and never instances transparent groups', () => {
    const scene = repeatedScene(70, 0);
    new World(scene, { instanceThreshold: 100 }).compile();
    expect(meshesIn(scene).some((m) => (m as InstancedMesh).isInstancedMesh)).toBe(false);
    expect(batchesIn(scene)).toHaveLength(1);

    const transparent = new Scene();
    for (let i = 0; i < 70; i++)
      transparent.add(tag.static(new Mesh(box, solid(1, { transparent: true, opacity: 0.5 }))));
    new World(transparent).compile();
    expect(meshesIn(transparent).some((m) => (m as InstancedMesh).isInstancedMesh)).toBe(false);
    expect(batchesIn(transparent)).toHaveLength(1);
  });

  it('resolves raycast hits on an instanced mesh back to the original and decompiles cleanly', () => {
    const scene = repeatedScene(70, 0);
    const world = new World(scene);
    world.compile();
    const instanced = meshesIn(scene).find((m): m is InstancedMesh => (m as InstancedMesh).isInstancedMesh)!;
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(60, 20, 40);
    camera.lookAt(60, 0, 0);
    camera.updateMatrixWorld();
    instanced.onBeforeRender(
      { coordinateSystem: 2000 } as never,
      scene,
      camera,
      instanced.geometry,
      instanced.material as never,
      null as never,
    );
    // box-30 sits at x = 60, straight below the camera's look-at point, so it survives the cull above.
    const raycaster = new Raycaster(new Vector3(60, 10, 0), new Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(instanced, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(world.resolve(hits[0]!).name).toBe('box-30');
    world.decompile();
    expect(meshesIn(scene).some((m) => (m as InstancedMesh).isInstancedMesh)).toBe(false);
    expect(meshesIn(scene)).toHaveLength(70);
  });
});

describe('World and the ledger under policy auto', () => {
  it('annotates lone statics as unique-material so the ledger does not call them untagged', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const lonely = new Mesh(box, solid(0xabcdef));
    lonely.name = 'lonely';
    const other = new Mesh(box, new MeshStandardMaterial({ map: texture }));
    other.name = 'other';
    scene.add(lonely, other);
    new World(scene, { ledger, policy: 'auto' }).compile();
    renderer.render(scene, camera);
    const reasons = Object.fromEntries(
      (ledger.frame({ items: true }).items ?? [])
        .filter((i) => i.reason !== 'renderer-internal')
        .map((i) => [i.name, i.reason]),
    );
    expect(reasons).toEqual({ lonely: 'unique-material', other: 'unique-material' });
  });

  it('relabels lone statics sharing a canonical material as static-unbatched', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const caster = new Mesh(box, solid(0x13579b));
    caster.name = 'caster';
    caster.castShadow = true;
    const plain = new Mesh(box, solid(0x13579b));
    plain.name = 'plain';
    scene.add(caster, plain);
    const report = new World(scene, { ledger, policy: 'auto' }).compile();
    expect(report.skipped.map((s) => s.rule)).toEqual(['singleton', 'singleton']);
    expect(caster.material).toBe(plain.material);
    renderer.render(scene, camera);
    const reasons = Object.fromEntries(
      (ledger.frame({ items: true }).items ?? [])
        .filter((i) => i.reason !== 'renderer-internal')
        .map((i) => [i.name, i.reason]),
    );
    expect(reasons).toEqual({ caster: 'static-unbatched', plain: 'static-unbatched' });
  });
});
