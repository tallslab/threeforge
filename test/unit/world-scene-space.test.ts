import {
  BackSide,
  type BatchedMesh,
  Box3,
  type Camera,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Group,
  type InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  type Side,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import type { CulledInstancedMesh } from '../../src/compiler/instancing.js';
import type { SpriteBatch } from '../../src/compiler/spriteBatch.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';
import { webglRenderer } from './helpers/renderers.js';
import { box, dodeca, solid } from './helpers/worldScene.js';

describe('World in a transformed scene', () => {
  const cylinder = new CylinderGeometry(0.5, 0.5, 2, 8);
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
    mesh.onBeforeRender(webglRenderer as never, scene, camera, mesh.geometry, mesh.material as never, null as never);
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
    batch.onBeforeRender(
      webglRenderer as never,
      f.scene,
      f.camera,
      batch.geometry,
      batch.material as never,
      null as never,
    );
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
    mesh.onBeforeRender(
      webglRenderer as never,
      f.scene,
      f.camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
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

  it('writes instance data in scene space, so every compiled result draws at its original', () => {
    const f = transformedScene();
    const world = new World(f.scene, { instanceThreshold: 6, dynamics: 'batch-sync', bake: true });
    const report = world.compile();
    expect(report.after).toMatchObject({ batches: 1, instanced: 1, baked: 1, spriteBatches: 1 });
    expect(report.synced).toBe(1);
    expectCompiled(world, f, 'after compile');
    f.mover.position.set(-5, 1, 9);
    expectCompiled(world, f, 'after the mover moved');
  });

  it('keeps landing on the originals after the scene itself moves', () => {
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

  it('rewrites synced movers when only the scene moves; a world-anchored one stays put', () => {
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
      batch.onBeforeRender(
        webglRenderer as never,
        scene,
        camera,
        batch.geometry,
        batch.material as never,
        null as never,
      );
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

  it('under a mirrored scene, batches unmirrored children and skips ones mirrored again', () => {
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

  it('under a mirrored scene, instances unmirrored children with a positive determinant', () => {
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
      webglRenderer as never,
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

  it('under a mirrored scene, bakes unmirrored children with every front face outward', () => {
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
          webglRenderer as never,
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
