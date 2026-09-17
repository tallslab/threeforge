import {
  AnimationClip,
  BackSide,
  type BatchedMesh,
  Box3,
  BoxGeometry,
  type Camera,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  FrontSide,
  Group,
  type InstancedBufferGeometry,
  type InstancedMesh,
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  PerspectiveCamera,
  Raycaster,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Side,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { FORGE_HOOK } from '../../src/compiler/culling.js';
import type { CulledInstancedMesh } from '../../src/compiler/instancing.js';
import type { SpriteBatch } from '../../src/compiler/spriteBatch.js';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);
const dodeca = new DodecahedronGeometry(0.5); // non-indexed
const texture = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);

function solid(color: number, extra: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) {
  return new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...extra });
}

/** 4 colour-variant statics (2 geometries), 2 textured statics, 1 dynamic, 1 skinned, 1 untagged: 9 meshes. */
function mixedScene() {
  const scene = new Scene();
  const statics = [
    tag.static(new Mesh(box, solid(0xff0000))),
    tag.static(new Mesh(dodeca, solid(0x00ff00))),
    tag.static(new Mesh(box, solid(0x0000ff))),
    tag.static(new Mesh(dodeca, solid(0xffff00))),
  ];
  statics.forEach((m, i) => {
    m.name = `static-${i}`;
    m.position.set(i * 3, 0, 0);
    m.rotation.y = i;
  });
  const textured = [
    tag.static(new Mesh(box, new MeshStandardMaterial({ map: texture }))),
    tag.static(new Mesh(box, new MeshStandardMaterial({ map: texture }))),
  ];
  textured.forEach((m, i) => {
    m.name = `textured-${i}`;
    m.position.set(0, 0, 5 + i * 3);
  });
  const dynamic = tag.dynamic(new Mesh(box, solid(0xff0000)));
  dynamic.name = 'dynamic';
  const skinned = new SkinnedMesh(box, solid(0x123456));
  skinned.name = 'skinned';
  const untagged = new Mesh(box, solid(0x654321));
  untagged.name = 'untagged';
  scene.add(...statics, ...textured, dynamic, skinned, untagged);
  return { scene, statics, textured, dynamic, skinned, untagged };
}

function meshesIn(scene: Scene): Mesh[] {
  const out: Mesh[] = [];
  scene.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

function batchesIn(scene: Scene): BatchedMesh[] {
  return meshesIn(scene).filter((m): m is BatchedMesh => (m as BatchedMesh).isBatchedMesh);
}

describe('World.compile', () => {
  it('batches statics per material variant, leaves dynamic, skinned and untagged meshes alone, and reports it', () => {
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

  it('copies world transforms and colours per instance and gives the batch a white clone of the canonical material', () => {
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

  it('never batches a singleton (nothing to share a draw with) but still canonicalises its material', () => {
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
    const meshes = [0, 1, 2, 3].map((i) => tag.static(new Mesh(box, solid(0xffffff))));
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
    const { scene, camera } = sceneWithCamera();
    const mirrored = tag.static(new Mesh(box, solid(1)));
    mirrored.name = 'mirrored';
    mirrored.scale.x = -1;
    scene.add(mirrored, tag.static(new Mesh(box, solid(1))));
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    new World(scene, { ledger }).compile();
    renderer.render(scene, camera);
    const item = ledger.frame({ items: true }).items?.find((i) => i.name === 'mirrored');
    expect(item?.reason).toBe('excluded:mirrored');
  });

  it("transparent: 'keep' leaves transparent statics unbatched and reports/annotates them transparent-kept", () => {
    const { scene, camera } = sceneWithCamera();
    const glassA = tag.static(new Mesh(box, solid(5, { transparent: true, opacity: 0.5 })));
    const glassB = tag.static(new Mesh(box, solid(6, { transparent: true, opacity: 0.5 })));
    glassA.name = 'glass-a';
    glassB.name = 'glass-b';
    scene.add(glassA, glassB, tag.static(new Mesh(box, solid(1))), tag.static(new Mesh(box, solid(2))));
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
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

  it('uninstalls the pass tracker hooks when resolving the animations throws, so a retry installs them once', () => {
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

  it('freezes all-static groups and unbatched statics at compile, restores them on decompile, and can be turned off', () => {
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

  it('turns a geometry repeated at least instanceThreshold times into one culled InstancedMesh, batching the rest', () => {
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

describe('World in a transformed scene', () => {
  const cylinder = new CylinderGeometry(0.5, 0.5, 2, 8);
  const renderer = { coordinateSystem: WebGLCoordinateSystem };
  const _row = new Matrix4();

  /**
   * Under a translated, turned and non-uniformly scaled scene: three batched boxes in a rotated group plus a
   * batch-synced dynamic box, six instanced dodecahedra, two baked cylinders and four sprites.
   */
  function transformedScene() {
    const scene = new Scene();
    scene.position.set(30, -4, 12);
    scene.rotation.y = 0.7;
    scene.scale.set(2, 3, 2);
    const props = new Group();
    props.name = 'props';
    props.position.set(-3, 1, 2);
    props.rotation.x = 0.2;
    scene.add(props);
    const batched = [0, 1, 2].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x110000 * (i + 1))));
      m.name = `batched-${i}`;
      m.position.set(i * 3, 0.5 * i, -i);
      m.rotation.z = 0.3 * i;
      props.add(m);
      return m;
    });
    const mover = tag.dynamic(new Mesh(box, solid(0xff8800)));
    mover.name = 'mover';
    mover.position.set(0, 2, 6);
    scene.add(mover);
    const instanced = Array.from({ length: 6 }, (_, i) => {
      const m = tag.static(new Mesh(dodeca, solid(0x2244ff)));
      m.name = `instanced-${i}`;
      m.position.set(i * 2, 4, 0);
      m.rotation.y = i * 0.4;
      scene.add(m);
      return m;
    });
    const bakedMaterial = new MeshStandardMaterial({ color: 0x777777, roughness: 0.2, metalness: 0.5 });
    const baked = [0, 1].map((i) => {
      const m = tag.static(new Mesh(cylinder, bakedMaterial));
      m.name = `baked-${i}`;
      m.position.set(-10 + i * 4, 0, 5);
      m.rotation.x = 0.5 * i;
      scene.add(m);
      return m;
    });
    const spriteMaterial = new SpriteMaterial({ color: 0xffffff, transparent: false });
    const sprites = Array.from({ length: 4 }, (_, i) => {
      const s = new Sprite(spriteMaterial);
      s.name = `sprite-${i}`;
      s.position.set(i * 2, 8, -2);
      s.scale.set(1 + i * 0.5, 2, 1);
      scene.add(s);
      return s;
    });
    scene.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    camera.position.set(30, 40, 260);
    camera.lookAt(30, 0, 12);
    camera.updateMatrixWorld();
    return { scene, props, batched, mover, instanced, baked, sprites, camera };
  }
  type Fixture = ReturnType<typeof transformedScene>;

  /** The first element where `actual` differs from `expected` by 5e-4 or more (what `toBeCloseTo(x, 3)` rejects), or null. */
  function offBy(actual: ArrayLike<number>, expected: ArrayLike<number>): string | null {
    for (let i = 0; i < expected.length; i++) {
      if (!(Math.abs(actual[i]! - expected[i]!) < 5e-4)) return `[${i}] ${actual[i]} instead of ${expected[i]}`;
    }
    return null;
  }

  /** Compacts an instanced group for `camera` and returns what three draws for master instance `id`, or null when it is not drawn. */
  function instancedWorld(mesh: CulledInstancedMesh, id: number, scene: Scene, camera: Camera): Matrix4 | null {
    mesh.onBeforeRender(renderer as never, scene, camera, mesh.geometry, mesh.material as never, null as never);
    const k = mesh.visibleIds.indexOf(id);
    if (k < 0) return null;
    mesh.getMatrixAt(k, _row);
    return new Matrix4().multiplyMatrices(mesh.matrixWorld, _row);
  }

  type Category = 'batched' | 'synced' | 'instanced' | 'baked' | 'sprites';

  /**
   * Runs every compiled object's hooks for the fixture's camera and compares what three would draw with the originals.
   * The first element off per object is collected per category and asserted once, so a failure names every category
   * that is wrong.
   */
  function expectCompiled(world: World, f: Fixture, label: string): void {
    f.scene.updateMatrixWorld();
    const off: Record<Category, string[]> = { batched: [], synced: [], instanced: [], baked: [], sprites: [] };
    const note = (category: Category, name: string, what: string | null): void => {
      if (what !== null) off[category].push(`${name} ${what}`);
    };
    const batch = world.slotOf(f.mover)!.batch as BatchedMesh;
    // The batch hook runs the matrix sync of the mover first.
    batch.onBeforeRender(renderer as never, f.scene, f.camera, batch.geometry, batch.material as never, null as never);
    for (const m of [...f.batched, f.mover]) {
      batch.getMatrixAt(world.slotOf(m)!.instanceId, _row);
      note(
        m === f.mover ? 'synced' : 'batched',
        m.name,
        offBy(new Matrix4().multiplyMatrices(batch.matrixWorld, _row).elements, m.matrixWorld.elements),
      );
    }
    const instanced = world.slotOf(f.instanced[0]!)!.batch as CulledInstancedMesh;
    for (const m of f.instanced) {
      const drawn = instancedWorld(instanced, world.slotOf(m)!.instanceId, f.scene, f.camera);
      note('instanced', m.name, drawn === null ? 'is not drawn' : offBy(drawn.elements, m.matrixWorld.elements));
    }
    const bakedMesh = world.slotOf(f.baked[0]!)!.batch as Mesh;
    const originals = new Box3();
    for (const m of f.baked) originals.expandByObject(m, true);
    const vertices = new Box3().setFromObject(bakedMesh, true);
    note(
      'baked',
      'vertex box',
      offBy(
        [...vertices.min.toArray(), ...vertices.max.toArray()],
        [...originals.min.toArray(), ...originals.max.toArray()],
      ),
    );
    const sprites = (world as unknown as { spriteBatchList: SpriteBatch[] }).spriteBatchList[0]!;
    const mesh = sprites.mesh;
    mesh.onBeforeRender(renderer as never, f.scene, f.camera, mesh.geometry, mesh.material as never, null as never);
    const drawnSprites = (mesh.geometry as InstancedBufferGeometry).instanceCount;
    if (drawnSprites !== f.sprites.length)
      note('sprites', 'instanceCount', `${drawnSprites} instead of ${f.sprites.length}`);
    const e = mesh.matrixWorld.elements;
    const batchScaleX = Math.hypot(e[0]!, e[1]!, e[2]!);
    const batchScaleY = Math.hypot(e[4]!, e[5]!, e[6]!);
    const c = sprites.centers.array;
    const s = sprites.scales.array;
    f.sprites.forEach((sprite, k) => {
      const centre = new Vector3(c[k * 3]!, c[k * 3 + 1]!, c[k * 3 + 2]!).applyMatrix4(mesh.matrixWorld);
      note(
        'sprites',
        `${sprite.name} centre`,
        offBy(centre.toArray(), new Vector3().setFromMatrixPosition(sprite.matrixWorld).toArray()),
      );
      const m = sprite.matrixWorld.elements;
      note(
        'sprites',
        `${sprite.name} scale`,
        offBy(
          [batchScaleX * s[k * 2]!, batchScaleY * s[k * 2 + 1]!],
          [Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!)],
        ),
      );
    });
    expect(off, label).toEqual({ batched: [], synced: [], instanced: [], baked: [], sprites: [] });
  }

  /**
   * Triangles whose front face, oriented as three r186 orients it (counter-clockwise; clockwise when the object's own
   * world matrix mirrors, `object.isMesh && matrixWorld.determinantAffine() < 0`), points against its vertex normal.
   */
  function inwardFaces(mesh: Mesh): number {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
    const flip = mesh.matrixWorld.determinant() < 0 ? -1 : 1;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const n = new Vector3();
    let inward = 0;
    for (let t = 0; t < count; t += 3) {
      const ia = index ? index.getX(t) : t;
      const ib = index ? index.getX(t + 1) : t + 1;
      const ic = index ? index.getX(t + 2) : t + 2;
      a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld).sub(a);
      c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld).sub(a);
      n.fromBufferAttribute(normal, ia).applyMatrix3(normalMatrix);
      if (b.cross(c).multiplyScalar(flip).dot(n) <= 0) inward++;
    }
    return inward;
  }

  /** A mirrored scene holding two plain boxes (not mirrored relative to it) and two boxes mirrored again. */
  function mirroredScene() {
    const scene = new Scene();
    scene.position.set(5, 0, 0);
    scene.scale.set(-1, 1, 1);
    const plain = [0, 1].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x808080)));
      m.name = `plain-${i}`;
      m.position.set(i * 3, 0, 0);
      m.rotation.y = 0.4 * i;
      scene.add(m);
      return m;
    });
    const again = [0, 1].map((i) => {
      const m = tag.static(new Mesh(box, solid(0x808080)));
      m.name = `again-${i}`;
      m.position.set(i * 3, 3, 0);
      m.scale.x = -1;
      scene.add(m);
      return m;
    });
    scene.updateMatrixWorld(true);
    return { scene, plain, again };
  }

  it('writes instance data in scene space: batched, instanced, baked, sprite and synced results draw at each original', () => {
    const f = transformedScene();
    const world = new World(f.scene, { instanceThreshold: 6, dynamics: 'batch-sync', bake: true });
    const report = world.compile();
    expect(report.after).toMatchObject({ batches: 1, instanced: 1, baked: 1, spriteBatches: 1 });
    expect(report.synced).toBe(1);
    expectCompiled(world, f, 'after compile');
    f.mover.position.set(-5, 1, 9);
    expectCompiled(world, f, 'after the mover moved');
  });

  it('uses the scene matrix of the moment: after the scene moves, synced movers, sprites and markDirty still land on the originals', () => {
    const f = transformedScene();
    const world = new World(f.scene, { instanceThreshold: 6, dynamics: 'batch-sync', bake: true });
    world.compile();
    expectCompiled(world, f, 'after compile');
    f.scene.position.set(-12, 6, 3);
    f.scene.rotation.y = -0.4;
    f.scene.scale.set(0.5, 0.75, 1.5);
    f.mover.position.set(2, -1, 4);
    expectCompiled(world, f, 'after the scene moved');
    f.batched[1]!.position.x += 5;
    f.instanced[2]!.position.y += 3;
    f.baked[0]!.position.z -= 2;
    expect(world.markDirty(f.batched[1]!)).toBe(1);
    expect(world.markDirty(f.instanced[2]!)).toBe(1);
    expect(world.markDirty(f.baked[0]!)).toBe(1);
    expectCompiled(world, f, 'after markDirty in the moved scene');
  });

  it('rewrites synced movers when only the scene moves: a world-anchored mover whose world matrix never changes stays where it is', () => {
    const scene = new Scene();
    scene.position.set(10, 0, -5);
    scene.rotation.y = 0.3;
    for (let i = 0; i < 2; i++) {
      const m = tag.static(new Mesh(box, solid(0x223344)));
      m.position.set(i * 3, 0, 0);
      scene.add(m);
    }
    for (let i = 0; i < 3; i++) {
      const m = tag.static(new Mesh(dodeca, solid(0x223344)));
      m.position.set(i * 3, 4, 0);
      scene.add(m);
    }
    // World-anchored movers (a physics body at rest, a floating-origin anchor): their world matrices are written directly.
    const anchored = [box, dodeca].map((geometry, i) => {
      const m = tag.dynamic(new Mesh(geometry, solid(0x223344)));
      m.name = `anchored-${i}`;
      m.matrixAutoUpdate = false;
      m.matrixWorldAutoUpdate = false;
      m.matrixWorld.makeTranslation(-4, 1 + i * 4, 6);
      scene.add(m);
      return m;
    });
    const world = new World(scene, { instanceThreshold: 4, dynamics: 'batch-sync' });
    expect(world.compile().synced).toBe(2);
    const batch = world.slotOf(anchored[0]!)!.batch as BatchedMesh;
    const instanced = world.slotOf(anchored[1]!)!.batch as CulledInstancedMesh;
    expect(batch.isBatchedMesh).toBe(true);
    expect(instanced.isInstancedMesh).toBe(true);
    const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
    camera.position.set(0, 60, 250);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const expectAnchored = (label: string): void => {
      scene.updateMatrixWorld();
      batch.onBeforeRender(renderer as never, scene, camera, batch.geometry, batch.material as never, null as never);
      batch.getMatrixAt(world.slotOf(anchored[0]!)!.instanceId, _row);
      const batched = offBy(
        new Matrix4().multiplyMatrices(batch.matrixWorld, _row).elements,
        anchored[0]!.matrixWorld.elements,
      );
      const drawn = instancedWorld(instanced, world.slotOf(anchored[1]!)!.instanceId, scene, camera);
      expect(
        {
          batched,
          instanced: drawn === null ? 'is not drawn' : offBy(drawn.elements, anchored[1]!.matrixWorld.elements),
        },
        label,
      ).toEqual({ batched: null, instanced: null });
    };
    expectAnchored('after compile');
    const before = anchored.map((m) => Array.from(m.matrixWorld.elements));
    scene.position.set(-20, 3, 8);
    scene.rotation.y = -0.5;
    scene.scale.setScalar(1.5);
    expectAnchored('after only the scene moved');
    expect(
      anchored.map((m) => Array.from(m.matrixWorld.elements)),
      'the movers never moved in the world',
    ).toEqual(before);
  });

  it('under a mirrored scene, batches children not mirrored relative to it and leaves children mirrored again unbatched', () => {
    const f = mirroredScene();
    const world = new World(f.scene);
    const report = world.compile();
    expect(
      report.skipped
        .filter((s) => s.rule === 'mirrored')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['again-0', 'again-1']);
    for (const m of f.plain) {
      const slot = world.slotOf(m);
      expect((slot?.batch as BatchedMesh | undefined)?.isBatchedMesh, `${m.name} is batched`).toBe(true);
      // three flips a batch's front face by its own world matrix (the scene's), never per instance.
      (slot!.batch as BatchedMesh).getMatrixAt(slot!.instanceId, _row);
      expect(_row.determinant(), `${m.name} instance matrix`).toBeGreaterThan(0);
    }
  });

  it('under a mirrored scene, instances children not mirrored relative to it, with a positive instance determinant', () => {
    // Regression guard: a repeated, non-mirrored-relative-to-root child must still compile into
    // an InstancedMesh under a mirrored scene, and its instance matrix (three flips the mesh's front face by the
    // group's own world determinant, never per instance) must keep a positive determinant, like a batched one.
    const scene = new Scene();
    scene.position.set(5, 0, 0);
    scene.scale.set(-1, 1, 1);
    const plain = Array.from({ length: 4 }, (_, i) => {
      const m = tag.static(new Mesh(dodeca, solid(0x808080)));
      m.name = `plain-${i}`;
      m.position.set(i * 2, 0, 0);
      m.rotation.y = 0.3 * i;
      scene.add(m);
      return m;
    });
    scene.updateMatrixWorld(true);
    const world = new World(scene, { instanceThreshold: 4 });
    const report = world.compile();
    expect(report.after.instanced).toBe(1);
    const instanced = world.slotOf(plain[0]!)!.batch as CulledInstancedMesh;
    expect(instanced.isInstancedMesh).toBe(true);
    const camera = new PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.set(5, 30, 20);
    camera.lookAt(5, 0, 0);
    camera.updateMatrixWorld();
    instanced.onBeforeRender(
      renderer as never,
      scene,
      camera,
      instanced.geometry,
      instanced.material as never,
      null as never,
    );
    const row = new Matrix4();
    for (const m of plain) {
      const slot = world.slotOf(m)!;
      expect(slot.batch).toBe(instanced);
      const k = instanced.visibleIds.indexOf(slot.instanceId);
      expect(k, `${m.name} is drawn`).toBeGreaterThanOrEqual(0);
      instanced.getMatrixAt(k, row);
      expect(row.determinant(), `${m.name} instance matrix`).toBeGreaterThan(0);
    }
  });

  it('under a mirrored scene, bakes children not mirrored relative to it with every front face outward, like the originals', () => {
    const f = mirroredScene();
    for (const m of [...f.plain, ...f.again]) expect(inwardFaces(m), `${m.name} (naive)`).toBe(0);
    const world = new World(f.scene, { bake: true });
    expect(world.compile().after.baked).toBe(1);
    expect(world.slotOf(f.plain[0]!)?.batch).toBe(world.bakedMeshes[0]);
    f.scene.updateMatrixWorld();
    expect(inwardFaces(world.bakedMeshes[0]!), 'baked triangles facing inward').toBe(0);
  });

  it("swaps a sprite batch's FrontSide and BackSide while the scene is mirrored, so three culls the quads the way it culls the sprites", () => {
    const scene = new Scene();
    const materials = [
      new SpriteMaterial({ color: 0xff0000, transparent: false }),
      new SpriteMaterial({ color: 0x00ff00, transparent: false, side: DoubleSide }),
    ];
    materials.forEach((material, g) => {
      for (let i = 0; i < 4; i++) {
        const s = new Sprite(material);
        s.position.set(i * 2, g * 3, 0);
        scene.add(s);
      }
    });
    scene.scale.x = -1;
    scene.updateMatrixWorld(true);
    const world = new World(scene);
    expect(world.compile().after.spriteBatches).toBe(2);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const batches = (world as unknown as { spriteBatchList: SpriteBatch[] }).spriteBatchList;
    // three r186 flips a Mesh's front face when its own world matrix mirrors (WebGPUPipelineUtils._getPrimitiveState,
    // WebGLState.setMaterial); a Sprite is not a Mesh and never flips. The side three effectively culls by:
    const effectiveSide = (side: Side, flipped: boolean): Side =>
      side === DoubleSide ? DoubleSide : (side === BackSide) !== flipped ? BackSide : FrontSide;
    const expectSides = (label: string): void => {
      scene.updateMatrixWorld();
      for (const b of batches) {
        b.mesh.onBeforeRender(
          renderer as never,
          scene,
          camera,
          b.mesh.geometry,
          b.mesh.material as never,
          null as never,
        );
        expect(effectiveSide(b.material.side, b.mesh.matrixWorld.determinant() < 0), `${label}: ${b.mesh.name}`).toBe(
          effectiveSide(b.group.material.side, false),
        );
      }
    };
    expectSides('mirrored at compile');
    scene.scale.x = 1;
    expectSides('unmirrored after compile');
    scene.scale.x = -1;
    expectSides('mirrored again');
  });
});

describe('World and the ledger under policy auto', () => {
  it('annotates lone statics as unique-material so the ledger does not call them untagged', () => {
    const { scene, camera } = sceneWithCamera();
    const lonely = new Mesh(box, solid(0xabcdef));
    lonely.name = 'lonely';
    const other = new Mesh(box, new MeshStandardMaterial({ map: texture }));
    other.name = 'other';
    scene.add(lonely, other);
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    new World(scene, { ledger, policy: 'auto' }).compile();
    renderer.render(scene, camera);
    const reasons = Object.fromEntries(
      (ledger.frame({ items: true }).items ?? [])
        .filter((i) => i.reason !== 'renderer-internal')
        .map((i) => [i.name, i.reason]),
    );
    expect(reasons).toEqual({ lonely: 'unique-material', other: 'unique-material' });
  });

  it('relabels lone statics static-unbatched when their canonical material is shared: same material, groups split by castShadow', () => {
    const { scene, camera } = sceneWithCamera();
    const caster = new Mesh(box, solid(0x13579b));
    caster.name = 'caster';
    caster.castShadow = true;
    const plain = new Mesh(box, solid(0x13579b));
    plain.name = 'plain';
    scene.add(caster, plain);
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
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

describe('World materials option', () => {
  it("keeps every mesh's own material instance with materials: 'keep'", () => {
    const scene = new Scene();
    const a = tag.dynamic(new Mesh(box, solid(0xabcdef)));
    const b = tag.dynamic(new Mesh(box, solid(0xabcdef)));
    scene.add(a, b);
    const materialB = b.material;
    new World(scene, { materials: 'keep' }).compile();
    expect(b.material).toBe(materialB);
    expect(a.material).not.toBe(b.material);
  });
});

const OWN = (object: object, key: string): boolean => Object.hasOwn(object, key);

describe('World material ownership', () => {
  /** Counts the `dispose` events three's `Material.dispose()` dispatches, per material. */
  function disposeCounts(materials: Material[]): Map<Material, number> {
    const counts = new Map<Material, number>();
    for (const material of materials) {
      counts.set(material, 0);
      material.addEventListener('dispose', () => counts.set(material, counts.get(material)! + 1));
    }
    return counts;
  }

  it('never disposes a registered material the compiler shared with a batch or an instanced group (decompile, dispose); it disposes the clones it made', () => {
    const registry = new MaterialRegistry();
    // App code registers its materials. Every instance white: the batch and the instanced group draw with these very objects.
    const sharedBatch = registry.register(solid(0xffffff, { roughness: 0.3 }));
    const sharedInstanced = registry.register(solid(0xffffff, { roughness: 0.5 }));
    const scene = new Scene();
    const add = (
      material: Material,
      geometry: BoxGeometry | DodecahedronGeometry | CylinderGeometry,
      n: number,
      z: number,
    ): Mesh[] =>
      Array.from({ length: n }, (_, i) => {
        const mesh = tag.static(new Mesh(geometry, material));
        mesh.position.set(i * 2, 0, z);
        scene.add(mesh);
        return mesh;
      });
    const batchOriginals = add(sharedBatch, box, 2, 0);
    const instancedOriginals = add(sharedInstanced, dodeca, 4, 4);
    // Tinted groups: a white clone carries the per-instance colours, owned by the World.
    const cylinder = new CylinderGeometry(0.4, 0.4, 1, 8);
    add(registry.register(solid(0xff0000, { roughness: 0.9 })), cylinder, 1, 8);
    add(registry.register(solid(0x00ff00, { roughness: 0.9 })), cylinder, 1, 10);
    for (const color of [0x0000ff, 0xffff00])
      add(registry.register(solid(color, { roughness: 0.1 })), box, 2, color === 0x0000ff ? 12 : 14);
    const world = new World(scene, { registry, instanceThreshold: 4 });
    world.compile();
    const drawn = [...world.batchedMeshes, ...world.instancedMeshes].map((m) => m.material as Material);
    expect(world.batchedMeshes.map((b) => b.material)).toContain(sharedBatch);
    expect(world.instancedMeshes.map((m) => m.material)).toContain(sharedInstanced);
    const clones = drawn.filter((m) => m !== sharedBatch && m !== sharedInstanced);
    expect(clones, 'one batch clone and one instanced clone').toHaveLength(2);
    const counts = disposeCounts([sharedBatch, sharedInstanced, ...clones]);

    world.decompile();
    expect([counts.get(sharedBatch), counts.get(sharedInstanced)], 'shared materials disposed on decompile').toEqual([
      0, 0,
    ]);
    expect(
      clones.map((m) => counts.get(m)! > 0),
      'clones disposed on decompile',
    ).toEqual([true, true]);
    expect(
      batchOriginals.every((m) => m.material === sharedBatch) &&
        instancedOriginals.every((m) => m.material === sharedInstanced),
    ).toBe(true);

    // Still usable: the next compile shares them again, and dispose() leaves them alone but frees that compile's clones.
    world.compile();
    expect(world.batchedMeshes.map((b) => b.material)).toContain(sharedBatch);
    expect(world.instancedMeshes.map((m) => m.material)).toContain(sharedInstanced);
    const secondClones = [...world.batchedMeshes, ...world.instancedMeshes]
      .map((m) => m.material as Material)
      .filter((m) => m !== sharedBatch && m !== sharedInstanced);
    expect(secondClones, 'the second compile made its own clones').toHaveLength(2);
    expect(secondClones.some((m) => clones.includes(m))).toBe(false);
    const secondCounts = disposeCounts(secondClones);
    world.dispose();
    expect([counts.get(sharedBatch), counts.get(sharedInstanced)], 'shared materials disposed on dispose').toEqual([
      0, 0,
    ]);
    expect(
      secondClones.map((m) => secondCounts.get(m)! > 0),
      "the second compile's clones disposed on dispose",
    ).toEqual([true, true]);
  });

  it("never disposes the originals' own material: materials: 'keep' batches with it, and an unsupported ShaderMaterial is never batched", () => {
    for (const mode of ['unsupported', 'keep'] as const) {
      const scene = new Scene();
      const material: Material = mode === 'unsupported' ? new ShaderMaterial() : solid(0xffffff, { roughness: 0.4 });
      for (let i = 0; i < 3; i++) {
        const mesh = tag.static(new Mesh(box, material));
        mesh.position.set(i * 2, 0, 0);
        scene.add(mesh);
      }
      const world = new World(scene, mode === 'keep' ? { materials: 'keep' } : {});
      const report = world.compile();
      if (mode === 'keep') {
        expect(
          world.batchedMeshes.map((b) => b.material),
          "keep: the batch draws with the originals' material",
        ).toEqual([material]);
      } else {
        // classify excludes ShaderMaterial and RawShaderMaterial, the only materials the registry marks unsupported, so the
        // ownership pass's `o.material === material` branch is defensive: no World batch can draw with such a material.
        expect(world.batchedMeshes, 'unsupported: batches').toHaveLength(0);
        expect(new Set(report.skipped.map((s) => s.rule)), 'unsupported: rule').toEqual(new Set(['shader-material']));
      }
      const counts = disposeCounts([material]);
      world.decompile();
      expect(counts.get(material), `${mode}: disposed on decompile`).toBe(0);
      world.compile();
      world.dispose();
      expect(counts.get(material), `${mode}: disposed on dispose`).toBe(0);
    }
  });
});

describe('World.dispose', () => {
  it('decompiles first (listeners hear it), clears the dirty listeners, uninstalls the pass tracker hooks, and is safe to call twice', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    const events: string[] = [];
    const off = world.onDirty((e) => events.push(e.kind));
    world.compile();
    expect(OWN(scene, 'onBeforeRender') && OWN(scene, 'onAfterRender'), 'pass tracker hooks installed').toBe(true);
    world.dispose();
    expect(events).toEqual(['compile', 'decompile']);
    expect(batchesIn(scene)).toHaveLength(0);
    expect(meshesIn(scene)).toHaveLength(9);
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks removed').toBe(false);
    expect((world as unknown as { dirtyListeners: Set<unknown> }).dirtyListeners.size).toBe(0);
    expect(world.mainCamera).toBeNull();
    world.dispose();
    world.decompile();
    off();
    expect(events).toEqual(['compile', 'decompile']);
  });

  it('refuses a recompile from a decompile listener while disposing: no scene hook or batch is left behind', () => {
    const { scene } = mixedScene();
    const world = new World(scene);
    const errors: string[] = [];
    world.onDirty((e) => {
      if (e.kind !== 'decompile') return;
      try {
        world.compile();
      } catch (error) {
        errors.push((error as Error).message);
      }
    });
    world.compile();
    world.dispose();
    expect(OWN(scene, 'onBeforeRender') || OWN(scene, 'onAfterRender'), 'pass tracker hooks left installed').toBe(
      false,
    );
    expect(batchesIn(scene)).toHaveLength(0);
    expect(errors).toEqual([expect.stringContaining('World is disposed')]);
    expect(() => world.compile()).toThrow('World is disposed');
  });

  it('throws a clear error on compile, markDirty, setVisible, onDirty and warmup after dispose', async () => {
    const { scene, statics } = mixedScene();
    const world = new World(scene);
    world.dispose(); // never compiled: nothing to decompile
    expect(() => world.compile()).toThrow('World is disposed');
    expect(() => world.markDirty(statics[0]!)).toThrow('World is disposed');
    expect(() => world.setVisible(statics[0]!, false)).toThrow('World is disposed');
    expect(() => world.onDirty(() => {})).toThrow('World is disposed');
    await expect(world.warmup(new FakeRenderer() as never, new PerspectiveCamera())).rejects.toThrow(
      'World is disposed',
    );
    expect(statics[0]!.visible).toBe(true);
  });
});

describe('World and the material registry on decompile', () => {
  /** Counts the `dispose` events three's `Material.dispose()` dispatches for one material. */
  function disposes(material: Material): () => number {
    let n = 0;
    material.addEventListener('dispose', () => n++);
    return () => n;
  }

  /** Three tinted statics of one variant: the batch draws with a white clone the World owns and disposes. */
  function tintedBatch(registry: MaterialRegistry) {
    const scene = new Scene();
    [0xff0000, 0x00ff00, 0x0000ff].forEach((color, i) => {
      const mesh = tag.static(new Mesh(box, registry.register(solid(color))));
      mesh.position.set(i * 2, 0, 0);
      scene.add(mesh);
    });
    const world = new World(scene, { registry });
    world.compile();
    return { world, clone: world.batchedMeshes[0]!.material as MeshStandardMaterial };
  }

  it('forgets a material it disposes, so the registry never hands out a disposed one', () => {
    const registry = new MaterialRegistry();
    const { world, clone } = tintedBatch(registry);
    // The batch material is reachable through `world.batchedMeshes`, so app code can register it.
    expect(registry.register(clone)).toBe(clone);
    expect(registry.describe(clone).outcome).not.toBe('unregistered');
    const count = disposes(clone);
    world.decompile();
    expect(count(), 'still disposed, as the World created it').toBe(1);
    expect(registry.describe(clone).outcome, 'and forgotten first').toBe('unregistered');
    expect(registry.canonicalOf(clone)).toBeUndefined();
  });

  it('keeps and never disposes a material a live registered material still merges into', () => {
    const registry = new MaterialRegistry();
    const { world, clone } = tintedBatch(registry);
    expect(registry.register(clone)).toBe(clone);
    const twin = clone.clone();
    expect(registry.register(twin), 'an identical material merges into the clone').toBe(clone);
    const count = disposes(clone);
    world.decompile();
    expect(count(), 'disposing it would break every mesh drawn with the twin').toBe(0);
    expect(registry.canonicalOf(twin), 'which still resolves to it').toBe(clone);
    expect(registry.describe(clone).outcome).not.toBe('unregistered');
  });
});
