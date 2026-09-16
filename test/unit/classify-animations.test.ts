import { describe, expect, it, vi } from 'vitest';
import { AnimationClip, BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, NumberKeyframeTrack, PropertyBinding, Scene, VectorKeyframeTrack } from 'three';
import { animatedRoots, classify } from '../../src/compiler/classify.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();
const mat = () => new MeshStandardMaterial();

describe('classify with animation clips', () => {
  it('treats nodes targeted by clips, and their descendants, as dynamic even under policy auto', () => {
    const scene = new Scene();
    const spinner = new Group();
    spinner.name = 'spinner';
    const blade = new Mesh(box, mat());
    blade.name = 'blade';
    spinner.add(blade);
    const still = new Mesh(box, mat());
    still.name = 'still';
    scene.add(spinner, still);
    const clip = new AnimationClip('spin', 1, [new VectorKeyframeTrack('spinner.position', [0, 1], [0, 0, 0, 1, 0, 0])]);
    const result = classify(scene, { policy: 'auto', animations: [clip] });
    expect(result.find((c) => c.object === blade)).toMatchObject({ kind: 'dynamic', rule: 'animated' });
    expect(result.find((c) => c.object === still)).toMatchObject({ kind: 'static', rule: 'auto' });
  });

  it('understands uuid-addressed tracks and morph target tracks', () => {
    const scene = new Scene();
    const mesh = new Mesh(box, mat());
    mesh.name = 'cube';
    scene.add(mesh);
    const byUuid = new AnimationClip('a', 1, [new VectorKeyframeTrack(`${mesh.uuid}.scale`, [0, 1], [1, 1, 1, 2, 2, 2])]);
    expect(classify(scene, { policy: 'auto', animations: [byUuid] })[0]).toMatchObject({ kind: 'dynamic', rule: 'animated' });
    const morph = new AnimationClip('m', 1, [new NumberKeyframeTrack('cube.morphTargetInfluences[0]', [0, 1], [0, 1])]);
    expect(classify(scene, { policy: 'auto', animations: [morph] })[0]).toMatchObject({ kind: 'dynamic', rule: 'animated' });
  });

  it('flows through World options so compile leaves animated meshes alone', () => {
    const scene = new Scene();
    const a = tag.static(new Mesh(box, mat()));
    a.name = 'a';
    const b = tag.static(new Mesh(box, mat()));
    b.name = 'b';
    const c = tag.static(new Mesh(box, mat()));
    c.name = 'c';
    scene.add(a, b, c);
    const clip = new AnimationClip('x', 1, [new VectorKeyframeTrack('c.position', [0, 1], [0, 0, 0, 1, 1, 1])]);
    const report = new World(scene, { animations: [clip] }).compile();
    expect(report.after).toEqual({ batches: 1, instanced: 0, baked: 0, spriteBatches: 0, frozen: 0, meshes: 1 });
    expect(report.skipped).toContainEqual({ name: 'c', rule: 'animated' });
  });
});

describe('classify and InstancedMesh', () => {
  it('never batches a mesh that is already an InstancedMesh (EXT_mesh_gpu_instancing)', () => {
    const scene = new Scene();
    const instanced = tag.static(new InstancedMesh(box, mat(), 10));
    scene.add(instanced);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'already-instanced' });
    expect(classify(scene, { policy: 'auto' })[0]).toMatchObject({ kind: 'excluded', rule: 'already-instanced' });
  });
});

describe('World resolves animation tracks once per compile', () => {
  it('shares one animatedRoots between classify and the freeze pass', () => {
    const scene = new Scene();
    const still = tag.static(new Mesh(box, mat()));
    still.name = 'still';
    const moving = tag.static(new Mesh(box, mat()));
    moving.name = 'moving';
    const other = tag.static(new Mesh(box, mat()));
    other.name = 'other';
    scene.add(still, moving, other);
    const clip = new AnimationClip('x', 1, [
      new VectorKeyframeTrack('moving.position', [0, 1], [0, 0, 0, 1, 1, 1]),
      new VectorKeyframeTrack('moving.scale', [0, 1], [1, 1, 1, 2, 2, 2]),
    ]);
    const findNode = vi.spyOn(PropertyBinding, 'findNode');
    const report = new World(scene, { animations: [clip] }).compile();
    const calls = findNode.mock.calls.length;
    findNode.mockRestore();
    expect(calls, 'one graph search per track, not one per track per pass').toBe(2);
    expect(report.skipped).toContainEqual({ name: 'moving', rule: 'animated' });
  });
});

describe("World with originals: 'detach' and animations", () => {
  it('resolves a track to the same node before and after the batched originals leave the graph', () => {
    const scene = new Scene();
    // Two nodes share a name; PropertyBinding.findNode returns the first match in child order. The statics that are
    // batched are removed from the graph under `originals: 'detach'`, which is what could move that first match.
    const statics = [0, 1, 2].map((i) => {
      const m = tag.static(new Mesh(box, mat()));
      m.name = 'spinner';
      m.position.set(i * 2, 0, 0);
      scene.add(m);
      return m;
    });
    const group = new Group();
    group.name = 'spinner';
    // Its own material variant, so it stays a singleton: a batched leaf would be detached with the rest and leave
    // `group` holding nothing freezable, which is a rule of its own and not what this test is about.
    const leaf = tag.static(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ roughness: 0.123 })));
    leaf.name = 'leaf';
    group.add(leaf);
    scene.add(group);
    const clip = new AnimationClip('spin', 1, [new VectorKeyframeTrack('spinner.position', [0, 1], [0, 0, 0, 1, 1, 1])]);

    const before = animatedRoots(scene, [clip]);
    const world = new World(scene, { animations: [clip], originals: 'detach' });
    const report = world.compile();
    const after = animatedRoots(scene, [clip]);
    expect([...before], 'the first match is the first same-named static').toEqual([statics[0]]);
    // The resolved node is animated, so classify makes it dynamic and it is never batched, so it is never detached:
    // the freeze pass would have resolved the very same node whenever it ran.
    expect([...after], 'and it still is once the batched originals are detached').toEqual([...before]);
    expect(statics[0]!.parent, 'the animated static stays in the graph').toBe(scene);
    expect(report.skipped).toContainEqual({ name: 'spinner', rule: 'animated' });
    expect(world.frozenObjects, 'the group is all-static and holds a leaf').toContain(group);
    expect(world.frozenObjects, 'the animated static is not frozen').not.toContain(statics[0]);
  });
});
