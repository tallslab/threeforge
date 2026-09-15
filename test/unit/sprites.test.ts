import { describe, expect, it } from 'vitest';
import { Frustum, Group, Matrix4, Object3D, PerspectiveCamera, Scene, Sprite, SpriteMaterial, Vector2, Vector3, type Material } from 'three';
import { ClippingGroup, SpriteNodeMaterial } from 'three/webgpu';
import { float } from 'three/tsl';
import { fillSpriteInstances, groupSprites, isVisibleInGraph, spriteRule } from '../../src/compiler/sprites.js';
import { SceneSpace } from '../../src/compiler/space.js';

/** Keys the way the registry describes materials: same map and flags → same variant, colour separate. */
const describeMaterial = (m: Material) => {
  const s = m as SpriteMaterial;
  return { programHash: `p:${s.map ? 'map' : 'flat'}`, variantHash: `v:${s.map ? 'map' : 'flat'}:${s.opacity}`, colorKey: s.color.getHexString() };
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

  it("spriteRule names an invisible material, independent of the sprite's own visible flag", () => {
    const invisible = new Sprite(new SpriteMaterial({ visible: false }));
    expect(spriteRule(invisible)).toBe('material-invisible');
  });

  it('spriteRule names a node material with any node slot set (sprite-node-material) and a sprite drawing other than one instance (sprite-count)', () => {
    // three r186 NodeMaterial's slots, plus SpriteNodeMaterial's rotationNode and scaleNode.
    const slots = ['lightsNode', 'envNode', 'aoNode', 'colorNode', 'normalNode', 'opacityNode', 'backdropNode', 'backdropAlphaNode', 'alphaTestNode', 'maskNode', 'maskShadowNode', 'positionNode', 'geometryNode', 'depthNode', 'receivedShadowPositionNode', 'castShadowPositionNode', 'receivedShadowNode', 'castShadowNode', 'outputNode', 'mrtNode', 'fragmentNode', 'vertexNode', 'contextNode', 'rotationNode', 'scaleNode'];
    const unnamed = slots.filter((slot) => {
      const material = new SpriteNodeMaterial();
      (material as unknown as Record<string, unknown>)[slot] = float(1);
      return spriteRule(new Sprite(material as unknown as SpriteMaterial)) !== 'sprite-node-material';
    });
    expect(unnamed, 'slots not named').toEqual([]);
    expect(spriteRule(new Sprite(new SpriteNodeMaterial() as unknown as SpriteMaterial)), 'every slot null').toBeNull();
    for (const count of [0, 3]) {
      const sprite = new Sprite(new SpriteMaterial());
      (sprite as Sprite & { count: number }).count = count;
      expect(spriteRule(sprite), `count ${count}`).toBe('sprite-count');
    }
    expect(spriteRule(new Sprite(new SpriteMaterial())), 'count 1').toBeNull();
  });

  it('spriteRule names ancestor-scoped rules only when a root is given: a render-ordered Group and an enabled ClippingGroup', () => {
    const scene = new Scene();
    const group = new Group();
    group.renderOrder = 4;
    const ordered = new Sprite(new SpriteMaterial());
    group.add(ordered);
    scene.add(group);
    expect(spriteRule(ordered)).toBeNull();
    expect(spriteRule(ordered, scene)).toBe('group-render-order');

    const clipper = new ClippingGroup();
    const clipped = new Sprite(new SpriteMaterial());
    clipper.add(clipped);
    scene.add(clipper);
    expect(spriteRule(clipped, scene)).toBe('clipping-group');
    clipper.enabled = false;
    expect(spriteRule(clipped, scene)).toBeNull();
  });

  it('spriteRule looks only at the nearest Group ancestor for group-render-order, and ignores a non-Group renderOrder', () => {
    const scene = new Scene();
    const outer = new Group();
    outer.renderOrder = 5;
    const inner = new Group();
    inner.renderOrder = 0;
    const resetByInner = new Sprite(new SpriteMaterial());
    inner.add(resetByInner);
    outer.add(inner);
    scene.add(outer);
    expect(spriteRule(resetByInner, scene)).toBeNull();

    const nearGroup = new Group();
    nearGroup.renderOrder = 0;
    const plain = new Object3D();
    plain.renderOrder = 5;
    const ignoresPlain = new Sprite(new SpriteMaterial());
    plain.add(ignoresPlain);
    nearGroup.add(plain);
    scene.add(nearGroup);
    expect(spriteRule(ignoresPlain, scene)).toBeNull();
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
    expect(fillSpriteInstances(sprites, centers, scales, { camera: null, sorted: false, cap: Infinity, root: scene, frustum: null })).toBe(3);
    expect([...centers]).toEqual([0, 0, -10, 1, 0, -5, 2, 0, -20]);
    expect([...scales]).toEqual([2, 3, 0, 0, 1, 1]);
  });

  it('sorts back to front for the camera when asked, and a cap keeps the nearest', () => {
    const { scene, sprites, camera, centers, scales } = setup();
    expect(fillSpriteInstances(sprites, centers, scales, { camera, sorted: true, cap: Infinity, root: scene, frustum: null })).toBe(3);
    expect([...centers]).toEqual([2, 0, -20, 0, 0, -10, 1, 0, -5]);
    expect([...scales]).toEqual([1, 1, 2, 3, 0, 0]);
    expect(fillSpriteInstances(sprites, centers, scales, { camera, sorted: true, cap: 2, root: scene, frustum: null })).toBe(2);
    expect([...centers.slice(0, 6)]).toEqual([0, 0, -10, 1, 0, -5]);
    expect(fillSpriteInstances(sprites, centers, scales, { camera: null, sorted: false, cap: 1, root: scene, frustum: null })).toBe(1);
    expect([...centers.slice(0, 3)]).toEqual([0, 0, -10]);
  });

  it('culls instances outside the frustum like three culls sprites, before sorting and capping', () => {
    const { scene, sprites, camera, centers, scales } = setup();
    sprites[1]!.visible = true;
    const behind = spriteAt(0, 0, 10, m, [1, 1]);
    const farLeft = spriteAt(-100, 0, -10, m, [1, 1]);
    const edge = spriteAt(-6.5, 0, -11, m, [2, 2]); // centre just outside a 60° frustum at z = -11 (half-extent 6.35), but its quad reaches in
    scene.add(behind, farLeft, edge);
    scene.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const all = [...sprites, behind, farLeft, edge];
    expect(fillSpriteInstances(all, new Float32Array(all.length * 3), new Float32Array(all.length * 2), { camera, sorted: true, cap: Infinity, root: scene, frustum })).toBe(4);
    const out = new Float32Array(all.length * 3);
    fillSpriteInstances(all, out, new Float32Array(all.length * 2), { camera, sorted: true, cap: Infinity, root: scene, frustum });
    expect([...out.slice(0, 12)]).toEqual([2, 0, -20, -6.5, 0, -11, 0, 0, -10, 1, 0, -5]);
    expect(fillSpriteInstances(all, centers, scales, { camera: null, sorted: false, cap: Infinity, root: scene, frustum: null })).toBe(6);
    // Only the four side planes cull: a reflector's oblique projection puts the near plane on the mirror, and the far
    // plane never matters for sprites, so a drop beyond the camera's far plane stays.
    const beyond = spriteAt(0, 0, -500, m, [1, 1]);
    scene.add(beyond);
    scene.updateMatrixWorld(true);
    expect(fillSpriteInstances([...all, beyond], new Float32Array(21), new Float32Array(14), { camera, sorted: false, cap: Infinity, root: scene, frustum })).toBe(5);
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

describe('fillSpriteInstances in scene space', () => {
  it("writes centres and scales in the space's root frame, so the batch's world matrix draws each sprite where it is", () => {
    const scene = new Scene();
    scene.position.set(10, -2, 4);
    scene.rotation.y = 0.5;
    scene.scale.set(2, 3, 2);
    const material = new SpriteMaterial();
    const sprites = [spriteAt(1, 2, 3, material, [1.5, 0.5]), spriteAt(-4, 0, 2, material, [1, 2])];
    scene.add(...sprites);
    scene.updateMatrixWorld(true);
    const centers = new Float32Array(6);
    const scales = new Float32Array(4);
    expect(fillSpriteInstances(sprites, centers, scales, { camera: null, sorted: false, cap: Infinity, root: scene, frustum: null, space: new SceneSpace(scene) })).toBe(2);
    sprites.forEach((s, k) => {
      const centre = new Vector3(centers[k * 3]!, centers[k * 3 + 1]!, centers[k * 3 + 2]!).applyMatrix4(scene.matrixWorld);
      const expected = new Vector3().setFromMatrixPosition(s.matrixWorld);
      centre.toArray().forEach((v, i) => expect(v, `sprite ${k} centre [${i}]`).toBeCloseTo(expected.toArray()[i]!, 4));
      const m = s.matrixWorld.elements;
      expect(scales[k * 2]! * 2, `sprite ${k} scale x`).toBeCloseTo(Math.hypot(m[0]!, m[1]!, m[2]!), 4);
      expect(scales[k * 2 + 1]! * 3, `sprite ${k} scale y`).toBeCloseTo(Math.hypot(m[4]!, m[5]!, m[6]!), 4);
    });
  });
});
