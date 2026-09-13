import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, type Intersection } from 'three';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

/** A row of touching unit boxes sharing one material: every pair has a seam of two contact faces. */
function wall(count: number, material = new MeshStandardMaterial({ color: 0x808080 })): { scene: Scene; boxes: Mesh[] } {
  const scene = new Scene();
  const boxes: Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const box = new Mesh(new BoxGeometry(1, 1, 1), material);
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
    expect(report.bake).toEqual(expect.objectContaining({ groups: 1, contactFaces: 12, duplicateFaces: 0, buriedFaces: 0, inputTriangles: 48, triangles: 36 }));
    expect(world.bakedMeshes.length).toBe(1);
    expect(world.bakedMeshes[0]!.geometry.index!.count / 3).toBe(36);
    expect(world.bakedMeshes[0]!.name).toMatch(/^forge:bake:/);
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
