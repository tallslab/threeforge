import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, Scene, Sprite, SpriteMaterial, Vector2, type Material } from 'three';
import { fillSpriteInstances, groupSprites, isVisibleInGraph, spriteRule } from '../../src/compiler/sprites.js';

/** Keys the way the registry describes materials: same map and flags → same variant, colour separate. */
const describeMaterial = (m: Material) => {
  const s = m as SpriteMaterial;
  return { programHash: `p:${s.map ? 'map' : 'flat'}`, variantHash: `v:${s.map ? 'map' : 'flat'}:${s.opacity}`, colorHex: s.color.getHexString() };
};

function spriteAt(x: number, y: number, z: number, material: SpriteMaterial, scale: [number, number] = [1, 1]): Sprite {
  const s = new Sprite(material);
  s.position.set(x, y, z);
  s.scale.set(scale[0], scale[1], 1);
  s.updateMatrixWorld(true);
  return s;
}

describe('groupSprites', () => {
  it('groups by material keys (not instance), applies the threshold and names skip rules', () => {
    const shared = new SpriteMaterial({ color: 0xffffff });
    const a = [spriteAt(0, 0, 0, shared), spriteAt(1, 0, 0, shared), spriteAt(2, 0, 0, shared)];
    const b = [spriteAt(3, 0, 0, new SpriteMaterial({ color: 0xffffff })), spriteAt(4, 0, 0, new SpriteMaterial({ color: 0xffffff }))];
    const red = [spriteAt(5, 0, 0, new SpriteMaterial({ color: 0xff0000 })), spriteAt(6, 0, 0, new SpriteMaterial({ color: 0xff0000 }))];
    const offCenter = spriteAt(7, 0, 0, shared);
    offCenter.center.set(0, 0);
    const { groups, skipped } = groupSprites([...a, ...b, ...red, offCenter], 2, describeMaterial);
    expect(groups.map((g) => g.sprites.length)).toEqual([5, 2]);
    expect(groups[0]!.programHash).toBe('p:flat');
    expect(groups[0]!.material).toBe(shared);
    expect(skipped).toEqual([{ sprite: offCenter, rule: 'sprite-center' }]);
    const strict = groupSprites([...a, ...red], 4, describeMaterial);
    expect(strict.groups).toEqual([]);
    expect(strict.skipped.map((s) => s.rule)).toEqual(['sprite-threshold', 'sprite-threshold', 'sprite-threshold', 'sprite-threshold', 'sprite-threshold']);
  });

  it('spriteRule names layers, renderOrder and custom hooks', () => {
    const m = new SpriteMaterial();
    const layered = spriteAt(0, 0, 0, m);
    layered.layers.set(2);
    expect(spriteRule(layered)).toBe('layers');
    const ordered = spriteAt(0, 0, 0, m);
    ordered.renderOrder = 5;
    expect(spriteRule(ordered)).toBe('render-order');
    const hooked = spriteAt(0, 0, 0, m);
    hooked.onBeforeRender = () => {};
    expect(spriteRule(hooked)).toBe('custom-hook');
    expect(spriteRule(spriteAt(0, 0, 0, m))).toBeNull();
  });
});

describe('fillSpriteInstances', () => {
  const m = new SpriteMaterial();
  const setup = () => {
    const scene = new Scene();
    const sprites = [spriteAt(0, 0, -10, m, [2, 3]), spriteAt(1, 0, -5, m, [4, 4]), spriteAt(2, 0, -20, m, [1, 1])];
    sprites[1]!.visible = false;
    scene.add(...sprites);
    scene.updateMatrixWorld(true);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    return { scene, sprites, camera, centers: new Float32Array(9), scales: new Float32Array(6) };
  };

  it('copies world positions and scales in input order, collapsing invisible sprites', () => {
    const { scene, sprites, centers, scales } = setup();
    expect(fillSpriteInstances(sprites, centers, scales, { camera: null, sorted: false, cap: Infinity, root: scene })).toBe(3);
    expect([...centers]).toEqual([0, 0, -10, 1, 0, -5, 2, 0, -20]);
    expect([...scales]).toEqual([2, 3, 0, 0, 1, 1]);
  });

  it('sorts back to front for the camera when asked, and a cap keeps the nearest', () => {
    const { scene, sprites, camera, centers, scales } = setup();
    expect(fillSpriteInstances(sprites, centers, scales, { camera, sorted: true, cap: Infinity, root: scene })).toBe(3);
    expect([...centers]).toEqual([2, 0, -20, 0, 0, -10, 1, 0, -5]);
    expect([...scales]).toEqual([1, 1, 2, 3, 0, 0]);
    expect(fillSpriteInstances(sprites, centers, scales, { camera, sorted: true, cap: 2, root: scene })).toBe(2);
    expect([...centers.slice(0, 6)]).toEqual([0, 0, -10, 1, 0, -5]);
    expect(fillSpriteInstances(sprites, centers, scales, { camera: null, sorted: false, cap: 1, root: scene })).toBe(1);
    expect([...centers.slice(0, 3)]).toEqual([0, 0, -10]);
  });

  it('isVisibleInGraph walks the parents up to the root', () => {
    const scene = new Scene();
    const group = new Group();
    const s = new Sprite(m);
    group.add(s);
    scene.add(group);
    expect(isVisibleInGraph(s, scene)).toBe(true);
    group.visible = false;
    expect(isVisibleInGraph(s, scene)).toBe(false);
    group.visible = true;
    s.visible = false;
    expect(isVisibleInGraph(s, scene)).toBe(false);
    expect(new Vector2().x).toBe(0);
  });
});
