import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
  type Vector2,
} from 'three';
import { describe, expect, it } from 'vitest';
import { tag } from '../../src/tags.js';
import { attachedLedger } from './helpers/ledger.js';
import { box } from './helpers/ledgerFixtures.js';

describe('DrawCallLedger snapshot, report and budget', () => {
  it('produces a deterministic JSON snapshot without uuids or object ids', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mesh = tag.static(new Mesh(box, new MeshStandardMaterial()));
    mesh.name = 'crate';
    scene.add(mesh);
    renderer.render(scene, camera);
    const json = JSON.stringify(ledger.frame({ items: true }));
    expect(json).not.toContain(mesh.uuid);
    expect(json).not.toContain(mesh.material.uuid);
    expect(json).not.toContain(`"id":${mesh.id}`);
    const frame = ledger.frame();
    expect(frame.schemaVersion).toBe(3);
    expect(Object.keys(frame.totals).sort()).toEqual([
      'drawCommands',
      'gpuDraws',
      'instances',
      'instancesDrawn',
      'programSwitches',
      'programs',
      'reportedDrawCalls',
      'sceneSubmissions',
      'submissions',
      'triangles',
      'unattributed',
    ]);
  });

  it('names unnamed objects by their scene path', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const group = new Group();
    group.name = 'props';
    group.add(new Mesh(box, new MeshStandardMaterial()));
    scene.add(group);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.[0]?.name).toBe('props/Mesh[0]');
  });

  it('report() groups submissions by reason with the top offenders', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    for (let i = 0; i < 3; i++) {
      const m = tag.dynamic(new Mesh(box, new MeshStandardMaterial()));
      m.name = `mover-${i}`;
      scene.add(m);
    }
    renderer.render(scene, camera);
    const text = ledger.report();
    expect(text).toContain('dynamic');
    expect(text).toContain('3');
    expect(text).toContain('mover-0');
  });

  it('budget() passes at or under the limit and lists offenders when over', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    for (let i = 0; i < 4; i++) scene.add(tag.dynamic(new Mesh(box, new MeshStandardMaterial())));
    renderer.render(scene, camera);
    expect(ledger.budget({ maxSubmissions: 4 })).toMatchObject({ pass: true, actual: 4, max: 4 });
    const over = ledger.budget({ maxSubmissions: 2 });
    expect(over.pass).toBe(false);
    expect(over.offenders[0]).toMatchObject({ reason: 'dynamic', submissions: 4 });
  });

  it('counts points by drawRange, sprites, sprite batches and drawing-buffer pixels', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    (renderer as unknown as { getDrawingBufferSize: (t: Vector2) => Vector2 }).getDrawingBufferSize = (t: Vector2) =>
      t.set(800, 600);
    const cloud = new BufferGeometry();
    cloud.setAttribute('position', new Float32BufferAttribute(new Float32Array(1000 * 3), 3));
    cloud.setDrawRange(0, 250);
    const points = new Points(cloud, new PointsMaterial({ size: 2, transparent: true }));
    points.name = 'smoke';
    const sprite = new Sprite(new SpriteMaterial({ transparent: true }));
    sprite.name = 'hit';
    const quad = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    quad.setIndex(plane.getIndex());
    quad.setAttribute('position', plane.getAttribute('position'));
    quad.instanceCount = 40;
    const batch = new Mesh(quad, new MeshBasicMaterial({ transparent: true }));
    batch.name = 'forge:sprites:abcd:0';
    batch.userData.forge = { kind: 'sprites' };
    scene.add(points, sprite, batch);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.overdraw.particles).toBe(250 + 1 + 40);
    expect(frame.overdraw.pixels).toBe(480_000);
    expect(frame.byReason['sprite-batch']?.submissions).toBe(1);
    expect(frame.items?.find((i) => i.name === 'smoke')?.vertices).toBe(250);
    expect(frame.items?.find((i) => i.name === 'forge:sprites:abcd:0')).toMatchObject({
      instances: 40,
      instancesDrawn: 40,
      expectedGpuDraws: 1,
    });
    expect(frame.totals.unattributed).toBe(0);
  });

  it("counts hidden originals on layer 31 and reports the attached scheduler's skipped ticks", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const a = new Mesh(box, new MeshStandardMaterial());
    const b = new Mesh(box, new MeshStandardMaterial());
    const c = new Mesh(box, new MeshStandardMaterial());
    b.layers.set(31);
    c.layers.set(31);
    scene.add(a, b, c);
    renderer.render(scene, camera);
    ledger.rescan();
    expect(ledger.frame().js.hiddenOriginals).toBe(2);
    expect(ledger.frame().js.skipped).toBe(0);
    ledger.attachScheduler({ skippedRecently: () => 7 });
    renderer.render(scene, camera);
    expect(ledger.frame().js.skipped).toBe(7);
    ledger.attachScheduler(null);
    renderer.render(scene, camera);
    expect(ledger.frame().js.skipped).toBe(0);
  });

  it('rescans past a null userData and still fills the memory and hint sections', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const statics = ['a', 'b', 'c'].map((name) => {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial()));
      mesh.name = name;
      return mesh;
    });
    const stray = new Mesh(box, new MeshStandardMaterial());
    stray.name = 'stray';
    // The rescan walks every object in the scene, not only the drawn ones, so one such node anywhere throws it.
    (stray as { userData: unknown }).userData = null;
    scene.add(...statics, stray);

    renderer.render(scene, camera); // the first frame rescans
    const first = ledger.frame();
    expect(first.js.objects).toBe(4);
    expect(first.memory.geometries.bytes).toBeGreaterThan(0);
    // Collected in the same traversal, right after the userData read.
    expect(first.hints.find((h) => h.code === 'static-auto-update')?.objects).toEqual(['a', 'b', 'c']);

    // And again on the periodic rescan, RESCAN_EVERY frames later.
    for (let i = 0; i < 60; i++) renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(4);
  });

  it('names nothing under a hidden parent and no point-light shadow with shadow maps off', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const hidden = new Group();
    hidden.name = 'hidden';
    hidden.visible = false;
    const lamp = new PointLight(0xffffff, 1);
    lamp.name = 'lamp';
    lamp.castShadow = true;
    const glass = new Mesh(box, new MeshPhysicalMaterial({ transmission: 1 }));
    glass.name = 'glass';
    hidden.add(lamp, glass);
    scene.add(hidden);
    (renderer.shadowMap as { enabled: boolean }).enabled = true;
    const codes = (): string[] => ledger.frame().hints.map((h) => h.code);
    renderer.render(scene, camera); // the first frame rescans
    // three's render lists skip a hidden subtree (Renderer._projectObject returns at visible === false): no shadow
    // faces render for the lamp and the glass draws in no pass.
    expect(codes()).not.toContain('point-light-shadow');
    expect(codes()).not.toContain('transmission');
    hidden.visible = true;
    ledger.rescan();
    expect(codes()).toEqual(expect.arrayContaining(['point-light-shadow', 'transmission']));
    // With shadow maps off, ShadowNode builds no map and renders none of the six faces.
    (renderer.shadowMap as { enabled: boolean }).enabled = false;
    ledger.rescan();
    expect(codes()).not.toContain('point-light-shadow');
    expect(codes()).toContain('transmission');
  });

  it("reports the attached streamer's chunks in the memory section", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    renderer.render(scene, camera);
    expect(ledger.frame().memory.chunks).toEqual({ total: 0, resident: 0 });
    ledger.attachStreamer({ stats: () => ({ chunks: 64, resident: 20, loads: 0, unloads: 0 }) });
    ledger.rescan();
    renderer.render(scene, camera);
    expect(ledger.frame().memory.chunks).toEqual({ total: 64, resident: 20 });
    ledger.attachStreamer(null);
    ledger.rescan();
    renderer.render(scene, camera);
    expect(ledger.frame().memory.chunks).toEqual({ total: 0, resident: 0 });
  });
});
