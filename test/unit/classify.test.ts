import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Scene,
  ShaderMaterial,
  SkinnedMesh,
} from 'three';
import { ClippingGroup } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { classify, exclusionRule } from '../../src/compiler/classify.js';
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
    expect(one(tag.static(new Mesh(box, new ShaderMaterial())))).toMatchObject({
      kind: 'unsupported',
      rule: 'shader-material',
    });
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

  it('excludes transmissive materials, whose thickness follows the object matrix', () => {
    // three scales volume thickness by the object matrix, which a batch cannot reproduce.
    const glass = tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 0.8 })));
    expect(one(glass)).toMatchObject({ kind: 'excluded', rule: 'transmission' });
    const solidPhysical = tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 0, clearcoat: 1 })));
    expect(one(solidPhysical)).toMatchObject({ kind: 'static' });
  });

  it('excludes a negative-determinant mesh without updating matrices first', () => {
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

  it('decides mirrored by the determinant relative to a mirrored scene root', () => {
    // three flips a batch by the scene matrix, never per instance.
    const scene = new Scene();
    scene.scale.x = -1;
    // Case A: mirrored again, so positive in the world but mirrored relative to the scene.
    const again = tag.static(new Mesh(box, mat()));
    again.scale.x = -1;
    // Case B: not mirrored relative to the scene, so negative in the world.
    const plain = tag.static(new Mesh(box, mat()));
    scene.add(again, plain);
    const [a, b] = classify(scene);
    expect(a!.object.matrixWorld.determinant()).toBeGreaterThan(0);
    expect(b!.object.matrixWorld.determinant()).toBeLessThan(0);
    expect(a).toMatchObject({ kind: 'excluded', rule: 'mirrored' });
    expect(b).toMatchObject({ kind: 'static', rule: 'tag:static' });
    expect(exclusionRule(again, scene)).toBe('mirrored');
    expect(exclusionRule(plain, scene)).toBeNull();
    // Without a root there is no scene to be relative to: the world determinant decides, as before.
    expect(exclusionRule(again)).toBeNull();
    expect(exclusionRule(plain)).toBe('mirrored');
  });

  it('lets a dynamic tag win over exclusion rules (dynamics are never batched anyway)', () => {
    const m = tag.dynamic(new Mesh(box, mat()));
    m.renderOrder = 3;
    expect(one(m)).toMatchObject({ kind: 'dynamic' });
  });

  it("excludes a mesh whose own material is invisible, distinct from the mesh's own visible flag", () => {
    const invisibleMaterial = tag.static(new Mesh(box, mat()));
    invisibleMaterial.material.visible = false;
    expect(one(invisibleMaterial)).toMatchObject({ kind: 'excluded', rule: 'material-invisible' });
  });

  it('excludes a mesh hidden by an invisible ancestor even though the mesh itself is visible', () => {
    const scene = new Scene();
    const group = new Group();
    group.visible = false;
    const child = tag.static(new Mesh(box, mat()));
    group.add(child);
    scene.add(group);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'invisible-ancestor' });
  });

  it("excludes a mesh under a Group ancestor with a non-zero renderOrder: three uses the group's renderOrder for everything inside it", () => {
    const scene = new Scene();
    const group = new Group();
    group.renderOrder = 2;
    const child = tag.static(new Mesh(box, mat()));
    group.add(child);
    scene.add(group);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'group-render-order' });
  });

  it('excludes a mesh under an enabled ClippingGroup ancestor, but not once it is disabled', () => {
    const scene = new Scene();
    const clipper = new ClippingGroup();
    const child = tag.static(new Mesh(box, mat()));
    clipper.add(child);
    scene.add(clipper);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'clipping-group' });

    clipper.enabled = false;
    expect(classify(scene)[0]).toMatchObject({ kind: 'static' });
  });

  // three's Renderer._projectObject reassigns `groupOrder = object.renderOrder` at every isGroup object on the way
  // down, so only the nearest Group ancestor's value ever reaches the mesh — a closer Group with renderOrder 0
  // resets it, whatever an outer Group says.
  it("group-render-order looks only at the nearest Group ancestor: a closer Group's 0 resets a farther Group's non-zero value", () => {
    const scene = new Scene();
    const outer = new Group();
    outer.renderOrder = 5;
    const inner = new Group();
    inner.renderOrder = 0;
    const child = tag.static(new Mesh(box, mat()));
    inner.add(child);
    outer.add(inner);
    scene.add(outer);
    expect(classify(scene)[0]).toMatchObject({ kind: 'static', rule: 'tag:static' });
  });

  it('group-render-order fires from the nearest Group even when a farther Group is 0', () => {
    const scene = new Scene();
    const outer = new Group();
    outer.renderOrder = 0;
    const inner = new Group();
    inner.renderOrder = 5;
    const child = tag.static(new Mesh(box, mat()));
    inner.add(child);
    outer.add(inner);
    scene.add(outer);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'group-render-order' });
  });

  it('ignores renderOrder on a non-Group ancestor for groupOrder', () => {
    // three reads renderOrder only off isGroup objects.
    const scene = new Scene();
    const group = new Group();
    group.renderOrder = 0;
    const plain = new Object3D();
    plain.renderOrder = 5;
    const child = tag.static(new Mesh(box, mat()));
    plain.add(child);
    group.add(plain);
    scene.add(group);
    expect(classify(scene)[0]).toMatchObject({ kind: 'static', rule: 'tag:static' });
  });

  it('excludes every mesh when the Scene root itself is invisible', () => {
    const scene = new Scene();
    scene.visible = false;
    const child = tag.static(new Mesh(box, mat()));
    scene.add(child);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'invisible-ancestor' });
  });

  it('skips the ancestor-scoped rules when exclusionRule has no root', () => {
    // Without a root there is no boundary to walk to.
    const group = new Group();
    group.visible = false;
    const child = tag.static(new Mesh(box, mat()));
    group.add(child);
    expect(exclusionRule(child)).toBeNull();
  });
});
