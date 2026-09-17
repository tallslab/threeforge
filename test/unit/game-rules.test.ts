import {
  AnimationClip,
  type BatchedMesh,
  Bone,
  BoxGeometry,
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  VectorKeyframeTrack,
} from 'three';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/compiler/classify.js';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

const box = new BoxGeometry();
const solid = (color: number) => new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0 });

describe('game content rules', () => {
  it('treats a mesh parented under a bone (a weapon in a hand) as dynamic even when tagged static', () => {
    const scene = new Scene();
    const root = new Bone();
    const hand = new Bone();
    root.add(hand);
    const sword = tag.static(new Mesh(box, solid(1)));
    hand.add(sword);
    scene.add(root);
    expect(classify(scene, { policy: 'auto' })[0]).toMatchObject({
      object: sword,
      kind: 'dynamic',
      rule: 'bone-parented',
    });
  });

  it('never batches a geometry whose attributes are marked for dynamic or stream updates (trails, ribbons)', () => {
    const scene = new Scene();
    const geometry = new BufferGeometry();
    const position = new Float32BufferAttribute(new Float32Array(9), 3);
    position.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', position);
    const trail = tag.static(new Mesh(geometry, solid(1)));
    scene.add(trail);
    expect(classify(scene)[0]).toMatchObject({ kind: 'excluded', rule: 'dynamic-geometry' });
  });

  it('resolves animation clips per root so several characters with the same bone names all count as animated', () => {
    const scene = new Scene();
    const makeFighter = (name: string) => {
      const fighter = new Group();
      fighter.name = name;
      const torso = new Group();
      torso.name = 'torso';
      const part = new Mesh(box, solid(1));
      part.name = `${name}-part`;
      torso.add(part);
      fighter.add(torso);
      scene.add(fighter);
      return { fighter, part };
    };
    const a = makeFighter('a');
    const b = makeFighter('b');
    const clip = new AnimationClip('attack', 1, [
      new VectorKeyframeTrack('torso.position', [0, 1], [0, 0, 0, 0, 1, 0]),
    ]);
    // Scene-wide resolution would find only the first 'torso'.
    const sceneWide = classify(scene, { policy: 'auto', animations: [clip] });
    expect(sceneWide.find((c) => c.object === a.part)?.kind).toBe('dynamic');
    expect(sceneWide.find((c) => c.object === b.part)?.kind).toBe('static');
    const perRoot = classify(scene, {
      policy: 'auto',
      animations: [
        { root: a.fighter, clips: [clip] },
        { root: b.fighter, clips: [clip] },
      ],
    });
    expect(perRoot.find((c) => c.object === a.part)).toMatchObject({ kind: 'dynamic', rule: 'animated' });
    expect(perRoot.find((c) => c.object === b.part)).toMatchObject({ kind: 'dynamic', rule: 'animated' });
    const report = new World(scene, {
      policy: 'auto',
      animations: [
        { root: a.fighter, clips: [clip] },
        { root: b.fighter, clips: [clip] },
      ],
    }).compile();
    expect(report.after.meshes).toBe(2);
  });

  it('reports an untagged mesh the compiler classified dynamic (under a bone, animated) as dynamic, not untagged', () => {
    const { scene, camera } = sceneWithCamera();
    const root = new Bone();
    const sword = new Mesh(box, solid(1));
    sword.name = 'sword';
    root.add(sword);
    scene.add(root);
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    new World(scene, { ledger, policy: 'auto' }).compile();
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.find((i) => i.name === 'sword')?.reason).toBe('dynamic');
  });

  it('gives points, sprites and lines their own ledger reasons', () => {
    const { scene, camera } = sceneWithCamera();
    const points = new Points(
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3)),
      new PointsMaterial(),
    );
    points.name = 'sparks';
    const sprite = new Sprite(new SpriteMaterial());
    sprite.name = 'health';
    const line = new Line(
      new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 1, 1], 3)),
      new LineBasicMaterial(),
    );
    line.name = 'beam';
    scene.add(points, sprite, line);
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    renderer.render(scene, camera);
    const reasons = Object.fromEntries(
      (ledger.frame({ items: true }).items ?? [])
        .filter((i) => i.reason !== 'renderer-internal')
        .map((i) => [i.name, i.reason]),
    );
    expect(reasons).toEqual({ sparks: 'points', health: 'sprite', beam: 'line' });
  });

  it('lets a batch share the canonical material when every instance is white, so runtime uniform changes propagate', () => {
    const scene = new Scene();
    const shared = new MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000 });
    const a = tag.static(new Mesh(box, shared));
    const b = tag.static(new Mesh(box, shared));
    scene.add(a, b);
    new World(scene).compile();
    const batch = scene.children.find((o) => (o as BatchedMesh).isBatchedMesh) as BatchedMesh;
    expect(batch.material).toBe(shared);
    shared.emissive.set(0xff0000);
    expect((batch.material as MeshStandardMaterial).emissive.getHex()).toBe(0xff0000);

    const coloured = new Scene();
    coloured.add(tag.static(new Mesh(box, solid(0xff0000))), tag.static(new Mesh(box, solid(0x00ff00))));
    new World(coloured).compile();
    const cb = coloured.children.find((o) => (o as BatchedMesh).isBatchedMesh) as BatchedMesh;
    expect((cb.material as MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    expect(
      coloured.children
        .filter((o) => !(o as BatchedMesh).isBatchedMesh)
        .some((o) => (o as Mesh).material === cb.material),
    ).toBe(false);
  });
});
