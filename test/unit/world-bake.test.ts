import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  DataTexture,
  DoubleSide,
  FrontSide,
  GreaterEqualDepth,
  type Intersection,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Plane,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { attribute, Discard, Fn, normalLocal, positionLocal, vec4, vertexColor } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { BakeReport } from '../../src/compiler/bake.js';
import { bakeEntriesOf } from '../../src/compiler/batchStatics.js';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

/** A row of touching unit boxes sharing one material (or one per box): every pair has a seam of two contact faces. */
function wall(
  count: number,
  material: Material | ((i: number) => Material) = new MeshStandardMaterial({ color: 0x808080 }),
  geometry: () => BufferGeometry = () => new BoxGeometry(1, 1, 1),
): { scene: Scene; boxes: Mesh[] } {
  const scene = new Scene();
  const boxes: Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const box = new Mesh(geometry(), typeof material === 'function' ? material(i) : material);
    box.name = `box-${i}`;
    box.position.x = i;
    tag.static(box);
    boxes.push(box);
    scene.add(box);
  }
  scene.updateMatrixWorld(true);
  return { scene, boxes };
}

/** Two touching boxes (one seam) and a block 5 cm inside a solid, all with one material and one `castShadow` flag. */
function sealed(material: Material, castShadow = false): Scene {
  const scene = new Scene();
  const add = (size: number, x: number, z: number): void => {
    const m = new Mesh(new BoxGeometry(size, size, size), material);
    m.position.set(x, 0, z);
    m.castShadow = castShadow;
    tag.static(m);
    scene.add(m);
  };
  add(1, 0, 0);
  add(1, 1, 0);
  add(2, 0, -5);
  add(1.9, 0, -5);
  scene.updateMatrixWorld(true);
  return scene;
}

const bakeSealed = (material: Material, castShadow = false) =>
  new World(sealed(material, castShadow), { bake: { removeBuried: true } }).compile();

describe('World with bake', () => {
  it('bakes each static group into one mesh, removes the seams and reports it', () => {
    const { scene } = wall(4);
    const world = new World(scene, { bake: true });
    const report = world.compile();
    expect(report.after.batches).toBe(0);
    expect(report.after.baked).toBe(1);
    expect(report.groups[0]!.kind).toBe('baked');
    expect(report.bake).toEqual(
      expect.objectContaining({
        groups: 1,
        contactFaces: 12,
        keptCoincidentFaces: 0,
        duplicateFaces: 0,
        buriedFaces: 0,
        inputTriangles: 48,
        triangles: 36,
      }),
    );
    expect(report.groups[0]!.bake).toEqual(expect.objectContaining({ contactFaces: 12, keptCoincidentFaces: 0 }));
    expect(world.bakedMeshes.length).toBe(1);
    expect(world.bakedMeshes[0]!.geometry.index!.count / 3).toBe(36);
    expect(world.bakedMeshes[0]!.name).toMatch(/^forge:bake:/);
  });

  it('keeps and counts the seams of a wall whose material is not opaque or is double-sided', () => {
    const cases: Array<[string, Material]> = [
      ['transparent', new MeshStandardMaterial({ transparent: true, opacity: 0.5 })],
      ['alphaTest', new MeshStandardMaterial({ alphaTest: 0.5 })],
      ['alphaHash', new MeshStandardMaterial({ alphaHash: true })],
      ['depthWrite off', new MeshStandardMaterial({ depthWrite: false })],
      ['additive blending', new MeshStandardMaterial({ blending: AdditiveBlending })],
      ['double-sided', new MeshStandardMaterial({ side: DoubleSide })],
    ];
    for (const [label, material] of cases) {
      const { scene } = wall(4, material);
      const report = new World(scene, { bake: true }).compile();
      expect(report.after.baked, label).toBe(1);
      expect(report.bake, label).toEqual(
        expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 12, inputTriangles: 48, triangles: 48 }),
      );
    }
  });

  it('bakes a wall under a mirrored scene with its seams removed: the modules are outward shells in scene space', () => {
    const { scene } = wall(4);
    scene.scale.x = -1;
    scene.updateMatrixWorld(true);
    const report = new World(scene, { bake: true }).compile();
    expect(report.after.baked).toBe(1);
    expect(report.bake).toEqual(expect.objectContaining({ contactFaces: 12, keptCoincidentFaces: 0, triangles: 36 }));
  });

  it('keeps seams and buried faces when the material draws faces the rules assume hidden, or moves or cuts them', () => {
    const bake = (material: Material) => bakeSealed(material);
    expect(bake(new MeshStandardMaterial()).bake, 'control').toEqual(
      expect.objectContaining({ contactFaces: 4, keptCoincidentFaces: 0, buriedFaces: 12 }),
    );
    const cases: Array<[string, () => Material]> = [
      ['BackSide', () => new MeshStandardMaterial({ side: BackSide })],
      ['clippingPlanes', () => new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(0, 1, 0), 0)] })],
      ['depthFunc', () => new MeshStandardMaterial({ depthFunc: GreaterEqualDepth })],
    ];
    for (const [label, material] of cases) {
      const report = bake(material());
      expect(report.after.baked, label).toBe(1);
      expect(report.bake, label).toEqual(
        expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 4, buriedFaces: 0 }),
      );
    }
  });

  it('keeps seams and buried faces when the modules cast shadows: non-VSM shadow maps draw the back faces of a front-side material', () => {
    expect(bakeSealed(new MeshStandardMaterial()).bake, 'control').toEqual(
      expect.objectContaining({ contactFaces: 4, keptCoincidentFaces: 0, buriedFaces: 12 }),
    );
    const report = bakeSealed(new MeshStandardMaterial(), true);
    expect(report.after.baked).toBe(1);
    expect(report.bake).toEqual(expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 4, buriedFaces: 0 }));
  });

  it.each([
    [
      'a negative polygonOffset',
      () => new MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
    ],
    [
      'extra shader defines',
      () => Object.assign(new MeshStandardMaterial(), { defines: { STANDARD: '', USE_ALPHAHASH: '' } }),
    ],
  ] as Array<[string, () => Material]>)(
    'keeps seams and buried faces for a material with %s (an allowlist, not a denylist)',
    (_label, material) => {
      const report = bakeSealed(material());
      expect(report.after.baked).toBe(1);
      expect(report.bake).toEqual(expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 4, buriedFaces: 0 }));
    },
  );

  it('a rebake keeps the opacity decided at bake time: a tinted group whose material has extra defines keeps its seams after setVisible', () => {
    // A tinted group bakes with a vertex-colour clone of its material, and MeshStandardMaterial.copy() resets `defines`
    // (Material.copy() does not copy an instance `onBeforeCompile` either), so the clone alone would pass the allowlist.
    const tints = [0xff0000, 0x00ff00, 0x0000ff];
    const { scene, boxes } = wall(3, (i) =>
      Object.assign(new MeshStandardMaterial({ color: tints[i]! }), { defines: { STANDARD: '', USE_ALPHAHASH: '' } }),
    );
    const world = new World(scene, { bake: true });
    expect(world.compile().bake, 'compile').toEqual(
      expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 8 }),
    );
    world.setVisible(boxes[2]!, false);
    const report = (world.bakedMeshes[0]!.userData.forge as { report: BakeReport }).report;
    expect(report, 'after the rebake').toEqual(expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 4 }));
  });

  it('a rebake keeps the seams of shadow casters: originals that stop casting while the baked mesh still casts lose nothing', () => {
    const { scene, boxes } = wall(4);
    for (const box of boxes) box.castShadow = true;
    const world = new World(scene, { bake: true });
    expect(world.compile().bake, 'compile').toEqual(
      expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 12 }),
    );
    const baked = world.bakedMeshes[0]!;
    const reportNow = () => (baked.userData.forge as { report: BakeReport }).report;
    for (const box of boxes) box.castShadow = false;
    world.setVisible(boxes[3]!, false);
    expect(baked.castShadow, 'the baked mesh still casts').toBe(true);
    expect(reportNow(), 'rebake while the baked mesh casts').toEqual(
      expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 8 }),
    );
    // Once neither the originals nor the baked mesh cast, a rebake may remove the seams.
    baked.castShadow = false;
    world.setVisible(boxes[3]!, true);
    expect(reportNow(), 'rebake when nothing casts').toEqual(
      expect.objectContaining({ contactFaces: 12, keptCoincidentFaces: 0 }),
    );
  });

  /** A subclass of `Base` whose own prototype overrides `method` (calling the original), as an app might write it. */
  function subclassOverriding<T extends new (...args: never[]) => Material>(
    Base: T,
    method: string,
  ): new () => Material {
    const Sub = class extends (Base as unknown as new () => Material) {};
    const original = (Base.prototype as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[
      method
    ];
    Object.defineProperty(Sub.prototype, method, {
      value: function (this: unknown, ...args: unknown[]) {
        return original?.apply(this, args);
      },
      writable: true,
      configurable: true,
    });
    return Sub;
  }
  /** An instance property calling `Base.prototype[method]`: behaves the same, but is code on the instance. */
  const callThrough = (Base: { prototype: object }, method: string) =>
    function (this: unknown, ...args: unknown[]) {
      return (Base.prototype as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(this, args);
    };

  it.each([
    [
      'a MeshStandardNodeMaterial subclass overriding setupDiffuseColor',
      () => new (subclassOverriding(MeshStandardNodeMaterial, 'setupDiffuseColor'))(),
    ],
    [
      'instance setup and setupOutput on a MeshStandardNodeMaterial',
      () =>
        Object.assign(new MeshStandardNodeMaterial(), {
          setup: callThrough(MeshStandardNodeMaterial, 'setup'),
          setupOutput: callThrough(MeshStandardNodeMaterial, 'setupOutput'),
        }),
    ],
    [
      'an instance onBeforeRender on a MeshStandardMaterial',
      () => Object.assign(new MeshStandardMaterial(), { onBeforeRender: () => {} }),
    ],
    [
      'a MeshStandardMaterial subclass overriding a method',
      () => new (subclassOverriding(MeshStandardMaterial, 'onBeforeRender'))(),
    ],
  ] as Array<[string, () => Material]>)(
    "leaves the group to batching for %s: only three's own material types with no own functions bake",
    (_label, material) => {
      // These used to bake with every face kept (the opacity allowlist); the bake cannot prove what such code reads.
      const report = bakeSealed(material());
      expect(report.after.baked).toBe(0);
      expect(report.bake).toEqual(
        expect.objectContaining({ groups: 0, contactFaces: 0, buriedFaces: 0, unbakeableEntries: 4 }),
      );
    },
  );

  it('does not pair outlines shortened by an edge used three times: the top of a longer box beside a doubled box stays covered', () => {
    // The probe: above y = 0 a unit box at x in [0,1], one at [1,2] and a copy of it turned about y; below,
    // a unit box at [0,1], a 2x1x1 box at [1,3] and a 1x1x2 box turned about y into the same place.
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    const add = (geometry: BufferGeometry, x: number, y: number, turned: boolean): void => {
      const m = new Mesh(geometry, material);
      m.position.set(x, y, 0);
      if (turned) m.rotation.y = Math.PI / 2;
      tag.static(m);
      scene.add(m);
    };
    add(new BoxGeometry(1, 1, 1), 0.5, 0.5, false);
    add(new BoxGeometry(1, 1, 1), 1.5, 0.5, false);
    add(new BoxGeometry(1, 1, 1), 1.5, 0.5, true);
    add(new BoxGeometry(1, 1, 1), 0.5, -0.5, false);
    add(new BoxGeometry(2, 1, 1), 2, -0.5, false);
    add(new BoxGeometry(1, 1, 2), 2, -0.5, true);
    scene.updateMatrixWorld(true);
    const world = new World(scene, { bake: true });
    expect(world.compile().after.baked).toBe(1);
    const hit = new Raycaster(new Vector3(2.5, 5, 0.1), new Vector3(0, -1, 0)).intersectObject(
      world.bakedMeshes[0]!,
    )[0];
    expect(hit, 'the top over x in [2, 3] is open to the sky in the naive scene').toBeDefined();
    expect(hit!.point.y).toBeCloseTo(0);
  });

  it('bakeEntriesOf takes opacity, sidedness and vertex colours from the material', () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const entry = (material: Material, vertexColors?: boolean) => bakeEntriesOf([mesh], material, { vertexColors })[0]!;
    expect(entry(new MeshStandardMaterial())).toMatchObject({
      opaque: true,
      side: FrontSide,
      castShadow: false,
      doubleSided: false,
      vertexColors: false,
    });
    const caster = Object.assign(new Mesh(new BoxGeometry(), new MeshStandardMaterial()), { castShadow: true });
    expect(
      bakeEntriesOf([caster], new MeshStandardMaterial())[0]!.castShadow,
      'castShadow is copied from each module',
    ).toBe(true);
    expect(entry(new MeshStandardMaterial({ side: BackSide }))).toMatchObject({ side: BackSide, doubleSided: false });
    expect(entry(new MeshStandardNodeMaterial()).opaque, 'a node material without vertex or depth nodes').toBe(true);
    expect(entry(new MeshStandardMaterial({ clippingPlanes: [] })).opaque, 'an empty clipping plane list').toBe(true);
    expect(entry(new MeshStandardMaterial({ side: DoubleSide }))).toMatchObject({ opaque: true, doubleSided: true });
    expect(entry(new MeshStandardMaterial({ vertexColors: true })).vertexColors).toBe(true);
    // A rebake passes the flag recorded at bake time: the baked material may be a clone with vertex colours forced on.
    expect(entry(new MeshStandardMaterial({ vertexColors: true }), false).vertexColors).toBe(false);
    const notOpaque: Array<[string, Material]> = [
      ['transparent', new MeshStandardMaterial({ transparent: true })],
      ['alphaTest', new MeshStandardMaterial({ alphaTest: 0.1 })],
      ['alphaHash', new MeshStandardMaterial({ alphaHash: true })],
      ['alphaToCoverage', new MeshStandardMaterial({ alphaToCoverage: true })],
      ['transmission', new MeshPhysicalMaterial({ transmission: 1 })],
      ['depthWrite off', new MeshStandardMaterial({ depthWrite: false })],
      ['depthTest off', new MeshStandardMaterial({ depthTest: false })],
      ['additive blending', new MeshStandardMaterial({ blending: AdditiveBlending })],
      ['maskNode', Object.assign(new MeshStandardMaterial(), { maskNode: {} })],
      ['alphaTestNode', Object.assign(new MeshStandardMaterial(), { alphaTestNode: {} })],
      ['fragmentNode', Object.assign(new MeshStandardMaterial(), { fragmentNode: {} })],
      ['ShaderMaterial', new ShaderMaterial()],
      ['displacementMap', new MeshStandardMaterial({ displacementMap: new DataTexture(new Uint8Array(4), 1, 1) })],
      ['positionNode', Object.assign(new MeshStandardNodeMaterial(), { positionNode: positionLocal })],
      ['vertexNode', Object.assign(new MeshStandardNodeMaterial(), { vertexNode: positionLocal })],
      ['geometryNode', Object.assign(new MeshStandardNodeMaterial(), { geometryNode: positionLocal })],
      ['depthNode', Object.assign(new MeshStandardNodeMaterial(), { depthNode: positionLocal })],
      ['clippingPlanes', new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(0, 1, 0), 0)] })],
      ['depthFunc', new MeshStandardMaterial({ depthFunc: GreaterEqualDepth })],
      ['wireframe', new MeshStandardMaterial({ wireframe: true })],
      ['stencilWrite', new MeshStandardMaterial({ stencilWrite: true })],
      ['polygonOffset', new MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -1 })],
      ['colorNode', Object.assign(new MeshStandardNodeMaterial(), { colorNode: positionLocal })],
      ['emissiveNode', Object.assign(new MeshStandardNodeMaterial(), { emissiveNode: positionLocal })],
      ['onBeforeCompile', Object.assign(new MeshStandardMaterial(), { onBeforeCompile: () => {} })],
      ['customProgramCacheKey', Object.assign(new MeshStandardMaterial(), { customProgramCacheKey: () => 'custom' })],
      ['defines', Object.assign(new MeshStandardMaterial(), { defines: { STANDARD: '', USE_ALPHAHASH: '' } })],
    ];
    for (const [label, material] of notOpaque) expect(entry(material).opaque, label).toBe(false);
  });

  it('colours tinted modules by their tint alone when the material ignores vertex colours, also after a rebake', () => {
    const tints = [0xff0000, 0x00ff00, 0x0000ff];
    const gray = (): BufferGeometry => {
      const g = new BoxGeometry(1, 1, 1);
      g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position!.count * 3).fill(0.5), 3));
      return g;
    };
    const { scene, boxes } = wall(3, (i) => new MeshStandardMaterial({ color: tints[i]! }), gray);
    const world = new World(scene, { bake: true });
    world.compile();
    const baked = world.bakedMeshes[0]!;
    const check = (label: string): void => {
      expect((baked.material as MeshStandardMaterial).vertexColors, label).toBe(true);
      const color = baked.geometry.getAttribute('color');
      for (let i = 0; i < color.count; i++)
        expect(Math.max(color.getX(i), color.getY(i), color.getZ(i)), `${label}: vertex ${i}`).toBeCloseTo(1);
    };
    check('compile');
    world.setVisible(boxes[1]!, false);
    check('rebake');
  });

  it('carries tangents into the baked mesh', () => {
    const { scene } = wall(3, undefined, () => {
      const g = new BoxGeometry(1, 1, 1);
      g.computeTangents();
      return g;
    });
    const world = new World(scene, { bake: true });
    world.compile();
    expect(world.bakedMeshes[0]!.geometry.getAttribute('tangent')?.itemSize).toBe(4);
  });

  it('keeps meshes opted out with userData.forgeBake = false untouched inside the bake', () => {
    const { scene, boxes } = wall(3);
    boxes[1]!.userData.forgeBake = false;
    const report = new World(scene, { bake: true }).compile();
    expect(report.bake!.contactFaces).toBe(0);
    expect(report.bake!.excludedEntries).toBe(1);
  });

  it('resolves a raycast hit on a baked mesh back to the module that owns the face', () => {
    const { scene, boxes } = wall(3);
    const world = new World(scene, { bake: true });
    world.compile();
    const baked = world.bakedMeshes[0]!;
    const origins = (baked.userData.forge as { triangleOrigins: Uint32Array }).triangleOrigins;
    const lastFace = origins.length - 1;
    const hit = { object: baked, faceIndex: lastFace, distance: 1, point: baked.position } as unknown as Intersection;
    expect(world.resolve(hit)).toBe(boxes[origins[lastFace]!]);
  });

  it('setVisible on a baked module rebakes the group without it', () => {
    const { scene, boxes } = wall(3);
    const world = new World(scene, { bake: true });
    world.compile();
    const baked = world.bakedMeshes[0]!;
    expect(baked.geometry.index!.count / 3).toBe(36 - 8); // three boxes, two seams
    world.setVisible(boxes[1]!, false);
    expect(baked.geometry.index!.count / 3).toBe(24); // two separate boxes, no seam
    world.setVisible(boxes[1]!, true);
    expect(baked.geometry.index!.count / 3).toBe(28);
  });

  it('returns the removed faces as debug meshes and is fully reversible', () => {
    const { scene, boxes } = wall(2);
    const world = new World(scene, { bake: true });
    world.compile();
    const debug = world.bakeDebug();
    expect(debug.children.length).toBe(1);
    expect((debug.children[0] as Mesh).geometry.index!.count / 3).toBe(4);
    world.decompile();
    expect(world.bakedMeshes.length).toBe(0);
    expect(scene.children.filter((c) => c.name.startsWith('forge:bake'))).toEqual([]);
    expect(boxes.every((b) => b.layers.mask === 1)).toBe(true);
  });

  it("bakeDebug() returns geometry of its own: a rebake and decompile dispose the group's removed faces, never the debug copy", () => {
    const { scene, boxes } = wall(3);
    const world = new World(scene, { bake: true });
    world.compile();
    const disposed: string[] = [];
    const debugMesh = (label: string): Mesh => {
      const mesh = world.bakeDebug().children[0] as Mesh;
      mesh.geometry.addEventListener('dispose', () => disposed.push(label));
      return mesh;
    };
    const beforeRebake = debugMesh('before rebake');
    expect(beforeRebake.geometry.index!.count / 3).toBe(8); // two seams
    world.setVisible(boxes[2]!, false); // rebake: the group's removed faces are replaced and disposed
    const afterRebake = debugMesh('after rebake');
    expect(afterRebake.geometry.index!.count / 3).toBe(4);
    world.decompile(); // disposes the group's removed faces again
    expect(disposed).toEqual([]);
    expect(beforeRebake.geometry.index!.count / 3, 'the first copy still holds what it showed').toBe(8);
    expect(beforeRebake.geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('batches instead of baking a group whose geometry carries an attribute the bake drops, and counts its meshes', () => {
    const rgba = (): BufferGeometry => {
      const g = new BoxGeometry(1, 1, 1);
      g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position!.count * 4).fill(0.4), 4));
      return g;
    };
    const extra = (): BufferGeometry => {
      const g = new BoxGeometry(1, 1, 1);
      g.setAttribute('_feature_id_0', new BufferAttribute(new Float32Array(g.attributes.position!.count), 1));
      return g;
    };
    const alpha = new World(wall(3, new MeshStandardMaterial({ vertexColors: true, transparent: true }), rgba).scene, {
      bake: true,
    }).compile();
    expect(alpha.after).toEqual(expect.objectContaining({ baked: 0, batches: 1 }));
    expect(alpha.groups[0]!.kind).toBe('batched');
    expect(alpha.bake).toEqual(expect.objectContaining({ groups: 0, unbakeableEntries: 3 }));
    const custom = new World(wall(2, new MeshStandardMaterial(), extra).scene, { bake: true }).compile();
    expect(custom.after).toEqual(expect.objectContaining({ baked: 0, batches: 1 }));
    expect(custom.bake).toEqual(expect.objectContaining({ groups: 0, unbakeableEntries: 2 }));
    // The material ignores the colour attribute: nothing it reads is dropped, so the group bakes.
    const ignored = new World(wall(3, new MeshStandardMaterial({ vertexColors: false }), rgba).scene, {
      bake: true,
    }).compile();
    expect(ignored.after).toEqual(expect.objectContaining({ baked: 1, batches: 0 }));
    expect(ignored.bake).toEqual(expect.objectContaining({ groups: 1, unbakeableEntries: 0 }));
  });

  /**
   * `vertexColors: false` is what three's own code reads (NodeMaterial.setupDiffuseColor, the only
   * reader of the attribute in r186), but a node graph, an instance function or a subclass can read `color` anyway, and
   * the bake drops a colour the flag ignores: the baked mesh drew the default white. Only a material whose attribute reads
   * are all three's own may lose the attribute; any other goes to batching, which keeps every attribute, and is counted.
   */
  it('batches instead of baking a group whose material may read a colour attribute its vertexColors flag ignores, and counts it', () => {
    const rgb = (): BufferGeometry => {
      const g = new BoxGeometry(1, 1, 1);
      g.setAttribute('color', new BufferAttribute(new Float32Array(g.attributes.position!.count * 3).fill(0.25), 3));
      return g;
    };
    const readers: Array<[string, () => Material]> = [
      [
        'colorNode = vertexColor()',
        () => Object.assign(new MeshStandardNodeMaterial({ vertexColors: false }), { colorNode: vertexColor() }),
      ],
      [
        'colorNode = attribute("color")',
        () =>
          Object.assign(new MeshStandardNodeMaterial({ vertexColors: false }), {
            colorNode: attribute('color', 'vec3'),
          }),
      ],
      [
        'a node in an unrelated slot',
        () => Object.assign(new MeshStandardNodeMaterial({ vertexColors: false }), { emissiveNode: vertexColor() }),
      ],
      [
        'an instance setupDiffuseColor',
        () =>
          Object.assign(new MeshStandardNodeMaterial({ vertexColors: false }), {
            setupDiffuseColor: callThrough(MeshStandardNodeMaterial, 'setupDiffuseColor'),
          }),
      ],
      [
        'a subclass overriding setupDiffuseColor',
        () => new (subclassOverriding(MeshStandardNodeMaterial, 'setupDiffuseColor'))(),
      ],
    ];
    for (const [label, material] of readers) {
      const report = new World(wall(3, material(), rgb).scene, { bake: true }).compile();
      expect(report.after, label).toEqual(expect.objectContaining({ baked: 0, batches: 1 }));
      expect(report.bake, label).toEqual(expect.objectContaining({ groups: 0, unbakeableEntries: 3 }));
    }
    // three's own code alone reads the geometry: vertexColors false provably ignores the attribute, so the group bakes.
    for (const [label, material] of [
      ['MeshStandardMaterial', new MeshStandardMaterial({ vertexColors: false })],
      ['MeshStandardNodeMaterial without nodes', new MeshStandardNodeMaterial({ vertexColors: false })],
    ] as Array<[string, Material]>) {
      const report = new World(wall(3, material, rgb).scene, { bake: true }).compile();
      expect(report.after, label).toEqual(expect.objectContaining({ baked: 1, batches: 0 }));
      expect(report.bake, label).toEqual(expect.objectContaining({ groups: 1, unbakeableEntries: 0 }));
    }
  });

  /**
   * CONTRIBUTING.md rule 6: the bake writes every module's geometry in scene space. three's own node-free
   * materials read it in ways that survive that (model-view and normal matrices, world normals, uvs), except a
   * `displacementMap`, which displaces along the local normal in local units (NodeMaterial.setupPosition). A node in any
   * slot, an instance function or a subclass may read `positionLocal`, `normalLocal` or `positionGeometry` inside a
   * `Fn` closure the bake cannot inspect. Such a group is batched, which keeps each geometry in its own space, and counted.
   */
  it("batches instead of baking a group whose material may read geometry in the module's own space, and counts it", () => {
    const readers: Array<[string, () => Material]> = [
      ['colorNode = normalLocal', () => Object.assign(new MeshStandardNodeMaterial(), { colorNode: normalLocal })],
      [
        'positionNode = positionLocal',
        () => Object.assign(new MeshStandardNodeMaterial(), { positionNode: positionLocal }),
      ],
      [
        'Discard() in a colorNode',
        () =>
          Object.assign(new MeshStandardNodeMaterial(), {
            colorNode: Fn(() => {
              Discard();
              return vec4(1, 1, 1, 1);
            })(),
          }),
      ],
      [
        'a displacementMap',
        () => new MeshStandardMaterial({ displacementMap: new DataTexture(new Uint8Array(4), 1, 1) }),
      ],
      [
        'an instance setupPosition',
        () =>
          Object.assign(new MeshStandardNodeMaterial(), {
            setupPosition: callThrough(MeshStandardNodeMaterial, 'setupPosition'),
          }),
      ],
      [
        'a subclass overriding setupPosition',
        () => new (subclassOverriding(MeshStandardNodeMaterial, 'setupPosition'))(),
      ],
      [
        'an instance onBeforeCompile on a MeshStandardMaterial',
        () => Object.assign(new MeshStandardMaterial(), { onBeforeCompile: () => {} }),
      ],
      [
        'a customProgramCacheKey override on a MeshStandardMaterial',
        () => Object.assign(new MeshStandardMaterial(), { customProgramCacheKey: () => 'custom' }),
      ],
    ];
    for (const [label, material] of readers) {
      const report = new World(wall(3, material()).scene, { bake: true }).compile();
      expect(report.after, label).toEqual(expect.objectContaining({ baked: 0, batches: 1 }));
      expect(report.bake, label).toEqual(expect.objectContaining({ groups: 0, unbakeableEntries: 3 }));
    }
    for (const [label, material] of [
      ['MeshStandardMaterial', new MeshStandardMaterial()],
      ['MeshStandardNodeMaterial without nodes', new MeshStandardNodeMaterial()],
      ['a null displacementMap', new MeshStandardMaterial({ displacementMap: null })],
    ] as Array<[string, Material]>) {
      const report = new World(wall(3, material).scene, { bake: true }).compile();
      expect(report.after, label).toEqual(expect.objectContaining({ baked: 1, batches: 0 }));
      expect(report.bake, label).toEqual(expect.objectContaining({ groups: 1, unbakeableEntries: 0 }));
    }
  });

  it('keeps batch-synced dynamics in a BatchedMesh, never in a bake', () => {
    const { scene, boxes } = wall(3);
    tag.dynamic(boxes[2]!);
    const report = new World(scene, { bake: true, dynamics: 'batch-sync' }).compile();
    expect(report.after.baked).toBe(0);
    expect(report.after.batches).toBe(1);
  });

  it('the ledger attributes a baked mesh to the reason "baked"', () => {
    const { scene: base } = wall(2);
    const { camera } = sceneWithCamera();
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const world = new World(base, { bake: true, ledger });
    world.compile();
    renderer.render(base, camera);
    const frame = ledger.frame();
    expect(frame.byReason.baked?.submissions).toBe(1);
    expect(frame.totals.sceneSubmissions).toBe(1);
  });
});
