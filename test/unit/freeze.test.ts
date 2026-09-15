import { describe, expect, it } from 'vitest';
import { BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial, Object3D, Scene, SkinnedMesh, Sprite, SpriteMaterial } from 'three';
import { freezableObjects } from '../../src/compiler/freeze.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry(1, 1, 1);
const mesh = (name: string): Mesh => {
  const m = new Mesh(box, new MeshStandardMaterial());
  m.name = name;
  return m;
};
const names = (objects: Object3D[]): string[] => objects.map((o) => o.name);

describe('freezableObjects', () => {
  it('freezes an all-static group at the group and a lone unbatched static by itself', () => {
    const scene = new Scene();
    const props = new Group();
    props.name = 'props';
    const h1 = tag.static(mesh('h1'));
    const h2 = tag.static(mesh('h2'));
    const single = tag.static(mesh('single'));
    props.add(h1, h2, single);
    const loner = tag.static(mesh('loner'));
    scene.add(props, loner);
    const out = freezableObjects(scene, { hidden: new Set([h1, h2]), synced: new Set(), animated: new Set() });
    expect(names(out)).toEqual(['props', 'loner']);
  });

  it('does not freeze a container with a dynamic, animated, synced, light or sprite descendant, but still freezes its static leaves', () => {
    const scene = new Scene();
    const withDynamic = new Group();
    withDynamic.name = 'withDynamic';
    withDynamic.add(tag.static(mesh('s1')), tag.dynamic(mesh('d1')));
    const withAnimated = new Group();
    withAnimated.name = 'withAnimated';
    const animated = mesh('animated');
    withAnimated.add(tag.static(mesh('s2')), animated);
    const withSynced = new Group();
    withSynced.name = 'withSynced';
    const synced = tag.dynamic(mesh('synced'));
    withSynced.add(tag.static(mesh('s3')), synced);
    const withLight = new Group();
    withLight.name = 'withLight';
    withLight.add(tag.static(mesh('s4')), new DirectionalLight());
    const withSprite = new Group();
    withSprite.name = 'withSprite';
    withSprite.add(tag.static(mesh('s5')), new Sprite(new SpriteMaterial()));
    scene.add(withDynamic, withAnimated, withSynced, withLight, withSprite);
    const out = freezableObjects(scene, { hidden: new Set([synced]), synced: new Set([synced]), animated: new Set([animated]) });
    expect(names(out).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('never freezes the scene, skinned meshes, untagged meshes, bones, or an animated ancestor chain', () => {
    const scene = new Scene();
    const rig = new Group();
    rig.name = 'rig';
    const skinned = new SkinnedMesh(box, new MeshStandardMaterial());
    skinned.name = 'skinned';
    const untagged = mesh('untagged');
    rig.add(skinned, untagged);
    const animatedGroup = new Group();
    animatedGroup.name = 'animatedGroup';
    const inner = new Group();
    inner.name = 'inner';
    inner.add(tag.static(mesh('deep')));
    animatedGroup.add(inner);
    scene.add(rig, animatedGroup);
    const out = freezableObjects(scene, { hidden: new Set(), synced: new Set(), animated: new Set([animatedGroup]) });
    // `inner` is all-static and its parent is animated: freeze at `inner`, never at the animated ancestor.
    expect(names(out)).toEqual(['inner']);
    const empty = new Scene();
    expect(freezableObjects(empty, { hidden: new Set(), synced: new Set(), animated: new Set() })).toEqual([]);
  });

  it('excludes hidden originals from the output (World freezes them itself) even when they are the only children', () => {
    const scene = new Scene();
    const h = tag.static(mesh('h'));
    scene.add(h);
    expect(freezableObjects(scene, { hidden: new Set([h]), synced: new Set(), animated: new Set() })).toEqual([]);
  });

  it('does not freeze an empty container, an anchor with no children, a light target, or a container whose only static descendant is an empty container', () => {
    const scene = new Scene();
    const emptyGroup = new Group();
    emptyGroup.name = 'emptyGroup';
    const anchor = new Object3D();
    anchor.name = 'anchor';
    const light = new DirectionalLight();
    light.name = 'light';
    light.target.name = 'light-target';
    const onlyEmptyDescendant = new Group();
    onlyEmptyDescendant.name = 'onlyEmptyDescendant';
    const innerEmpty = new Group();
    innerEmpty.name = 'innerEmpty';
    onlyEmptyDescendant.add(innerEmpty);
    scene.add(emptyGroup, anchor, light, light.target, onlyEmptyDescendant);
    const out = freezableObjects(scene, { hidden: new Set(), synced: new Set(), animated: new Set() });
    expect(out).toEqual([]);
  });

  it('still freezes a container whose only child is a single static mesh leaf', () => {
    const scene = new Scene();
    const leaf = new Group();
    leaf.name = 'leaf';
    leaf.add(tag.static(mesh('m')));
    scene.add(leaf);
    const out = freezableObjects(scene, { hidden: new Set(), synced: new Set(), animated: new Set() });
    expect(names(out)).toEqual(['leaf']);
  });
});
