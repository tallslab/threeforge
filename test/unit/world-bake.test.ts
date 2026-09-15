import { describe, expect, it } from 'vitest';
import { AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, DataTexture, DoubleSide, FrontSide, GreaterEqualDepth, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Plane, Scene, ShaderMaterial, Vector3, type BufferGeometry, type Intersection, type Material } from 'three';
import { positionLocal } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { World } from '../../src/compiler/World.js';
import { bakeEntriesOf } from '../../src/compiler/batchStatics.js';
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

describe('World with bake', () => {
  it('bakes each static group into one mesh, removes the seams and reports it', () => {
    const { scene } = wall(4);
    const world = new World(scene, { bake: true });
    const report = world.compile();
    expect(report.after.batches).toBe(0);
    expect(report.after.baked).toBe(1);
    expect(report.groups[0]!.kind).toBe('baked');
    expect(report.bake).toEqual(expect.objectContaining({ groups: 1, contactFaces: 12, keptCoincidentFaces: 0, duplicateFaces: 0, buriedFaces: 0, inputTriangles: 48, triangles: 36 }));
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
      expect(report.bake, label).toEqual(expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 12, inputTriangles: 48, triangles: 48 }));
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
    /** Two touching boxes (one seam) and a block 5 cm inside a solid, all with one material. */
    const scene = (material: Material): Scene => {
      const s = new Scene();
      const add = (size: number, x: number, z: number): void => {
        const m = new Mesh(new BoxGeometry(size, size, size), material);
        m.position.set(x, 0, z);
        tag.static(m);
        s.add(m);
      };
      add(1, 0, 0);
      add(1, 1, 0);
      add(2, 0, -5);
      add(1.9, 0, -5);
      s.updateMatrixWorld(true);
      return s;
    };
    const bake = (material: Material) => new World(scene(material), { bake: { removeBuried: true } }).compile();
    expect(bake(new MeshStandardMaterial()).bake, 'control').toEqual(expect.objectContaining({ contactFaces: 4, keptCoincidentFaces: 0, buriedFaces: 12 }));
    const cases: Array<[string, () => Material]> = [
      ['BackSide', () => new MeshStandardMaterial({ side: BackSide })],
      ['displacementMap', () => new MeshStandardMaterial({ displacementMap: new DataTexture(new Uint8Array(4), 1, 1) })],
      ['positionNode', () => Object.assign(new MeshStandardNodeMaterial(), { positionNode: positionLocal })],
      ['clippingPlanes', () => new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(0, 1, 0), 0)] })],
      ['depthFunc', () => new MeshStandardMaterial({ depthFunc: GreaterEqualDepth })],
    ];
    for (const [label, material] of cases) {
      const report = bake(material());
      expect(report.after.baked, label).toBe(1);
      expect(report.bake, label).toEqual(expect.objectContaining({ contactFaces: 0, keptCoincidentFaces: 4, buriedFaces: 0 }));
    }
  });

  it('bakeEntriesOf takes opacity, sidedness and vertex colours from the material', () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    const entry = (material: Material, vertexColors?: boolean) => bakeEntriesOf([mesh], new Set(), material, undefined, vertexColors)[0]!;
    expect(entry(new MeshStandardMaterial())).toMatchObject({ opaque: true, side: FrontSide, doubleSided: false, vertexColors: false });
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
      for (let i = 0; i < color.count; i++) expect(Math.max(color.getX(i), color.getY(i), color.getZ(i)), `${label}: vertex ${i}`).toBeCloseTo(1);
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
