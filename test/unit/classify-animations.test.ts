import { describe, expect, it } from 'vitest';
import { AnimationClip, BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, NumberKeyframeTrack, Scene, VectorKeyframeTrack } from 'three';
import { classify } from '../../src/compiler/classify.js';
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
    expect(report.after).toEqual({ batches: 1, instanced: 0, meshes: 1 });
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
