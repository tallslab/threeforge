import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene, ShaderMaterial, SkinnedMesh } from 'three';
import { classify } from '../../src/compiler/classify.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();
const mat = () => new MeshStandardMaterial();

function one(mesh: Mesh, options?: Parameters<typeof classify>[1]) {
  const scene = new Scene();
  scene.add(mesh);
  const result = classify(scene, options);
  expect(result).toHaveLength(1);
  return result[0]!;
}

describe('classify', () => {
  it('returns one classification per mesh in traversal order and skips non-meshes', () => {
    const scene = new Scene();
    const a = tag.static(new Mesh(box, mat()));
    const g = new Group();
    const b = tag.static(new Mesh(box, mat()));
    g.add(b);
    scene.add(a, g);
    const result = classify(scene);
    expect(result.map((c) => c.object)).toEqual([a, b]);
  });

  it('classifies tagged statics as static with the rule that fired', () => {
    expect(one(tag.static(new Mesh(box, mat())))).toMatchObject({ kind: 'static', rule: 'tag:static' });
  });

  it('classifies dynamics by own tag or by an ancestor tag', () => {
    expect(one(tag.dynamic(new Mesh(box, mat())))).toMatchObject({ kind: 'dynamic', rule: 'tag:dynamic' });
    const scene = new Scene();
    const group = tag.dynamic(new Group());
    const child = new Mesh(box, mat());
    group.add(child);
    scene.add(group);
    expect(classify(scene)[0]).toMatchObject({ object: child, kind: 'dynamic', rule: 'tag:dynamic' });
  });

  it('leaves untagged meshes alone under the default tagged policy and batches them under auto', () => {
    expect(one(new Mesh(box, mat()))).toMatchObject({ kind: 'untagged', rule: 'untagged' });
    expect(one(new Mesh(box, mat()), { policy: 'auto' })).toMatchObject({ kind: 'static', rule: 'auto' });
  });

  it('never batches skinned, morphing or shader-material meshes', () => {
    expect(one(tag.static(new SkinnedMesh(box, mat())))).toMatchObject({ kind: 'skinned', rule: 'skinned-mesh' });
    const morph = tag.static(new Mesh(box, mat()));
    morph.morphTargetInfluences = [0.5];
    expect(one(morph)).toMatchObject({ kind: 'morph', rule: 'morph-targets' });
    expect(one(tag.static(new Mesh(box, new ShaderMaterial())))).toMatchObject({ kind: 'unsupported', rule: 'shader-material' });
  });

  it('excludes meshes whose rendering a batch cannot reproduce, naming the rule', () => {
    const multi = tag.static(new Mesh(box, [mat(), new MeshBasicMaterial()]));
    expect(one(multi)).toMatchObject({ kind: 'excluded', rule: 'multi-material' });

    const layered = tag.static(new Mesh(box, mat()));
    layered.layers.set(2);
    expect(one(layered)).toMatchObject({ kind: 'excluded', rule: 'layers' });

    const ordered = tag.static(new Mesh(box, mat()));
    ordered.renderOrder = 1;
    expect(one(ordered)).toMatchObject({ kind: 'excluded', rule: 'render-order' });

    const hooked = tag.static(new Mesh(box, mat()));
    hooked.onBeforeRender = () => {};
    expect(one(hooked)).toMatchObject({ kind: 'excluded', rule: 'custom-hook' });

    const ranged = tag.static(new Mesh(box.clone(), mat()));
    ranged.geometry.setDrawRange(0, 6);
    expect(one(ranged)).toMatchObject({ kind: 'excluded', rule: 'draw-range' });

    const unculled = tag.static(new Mesh(box, mat()));
    unculled.frustumCulled = false;
    expect(one(unculled)).toMatchObject({ kind: 'excluded', rule: 'frustum-culled-off' });

    const hidden = tag.static(new Mesh(box, mat()));
    hidden.visible = false;
    expect(one(hidden)).toMatchObject({ kind: 'excluded', rule: 'invisible' });
  });

  it('excludes mirrored meshes (negative world determinant) without requiring matrices to be updated first', () => {
    const mirrored = tag.static(new Mesh(box, mat()));
    mirrored.scale.x = -1;
    expect(one(mirrored)).toMatchObject({ kind: 'excluded', rule: 'mirrored' });
    const scene = new Scene();
    const parent = new Group();
    parent.scale.z = -2;
    const child = tag.static(new Mesh(box, mat()));
    parent.add(child);
    scene.add(parent);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'mirrored' });
  });

  it('lets a dynamic tag win over exclusion rules (dynamics are never batched anyway)', () => {
    const m = tag.dynamic(new Mesh(box, mat()));
    m.renderOrder = 3;
    expect(one(m)).toMatchObject({ kind: 'dynamic' });
  });
});
