import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Vector2,
} from 'three';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, batchedOf, sceneWithCamera } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);

function attached(options: ConstructorParameters<typeof FakeRenderer>[0] = {}) {
  const renderer = new FakeRenderer(options);
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer as never);
  const { scene, camera } = sceneWithCamera();
  return { renderer, registry, ledger, scene, camera };
}

describe('DrawCallLedger attribution', () => {
  it('records one submission per render item and separates renderer-internal work from the scene', () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(new Mesh(box, new MeshStandardMaterial()), new Mesh(box, new MeshStandardMaterial()));
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.totals.submissions).toBe(3);
    expect(frame.totals.sceneSubmissions).toBe(2);
    expect(frame.byReason['renderer-internal']?.submissions).toBe(1);
    expect(frame.items?.find((i) => i.reason === 'renderer-internal')?.name).toBe('Output Color Transform');
  });

  it('gives every submission a primary reason', () => {
    const { renderer, ledger, scene, camera } = attached();
    const untagged = new Mesh(box, new MeshStandardMaterial());
    untagged.name = 'untagged';
    const unique = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x123456 })));
    unique.name = 'unique';
    const dynamic = tag.dynamic(new Mesh(box, new MeshStandardMaterial()));
    dynamic.name = 'dynamic';
    const inDynamicGroup = new Mesh(box, new MeshStandardMaterial());
    inDynamicGroup.name = 'child-of-dynamic';
    const group = tag.dynamic(new Group());
    group.add(inDynamicGroup);
    const transparent = tag.static(new Mesh(box, new MeshStandardMaterial({ transparent: true, opacity: 0.5 })));
    transparent.name = 'transparent';
    const skinned = new SkinnedMesh(box, new MeshStandardMaterial());
    skinned.name = 'skinned';
    const shader = tag.static(new Mesh(box, new ShaderMaterial()));
    shader.name = 'shader';
    const batch = batchedOf(3, new MeshStandardMaterial(), box);
    scene.add(untagged, unique, dynamic, group, transparent, skinned, shader, batch);
    renderer.render(scene, camera);

    const reasons = Object.fromEntries((ledger.frame({ items: true }).items ?? []).map((i) => [i.name, i.reason]));
    expect(reasons).toMatchObject({
      untagged: 'untagged',
      unique: 'unique-material',
      dynamic: 'dynamic',
      'child-of-dynamic': 'dynamic',
      transparent: 'transparent',
      skinned: 'skinned',
      shader: 'unsupported-material',
      'batch-3': 'batched',
    });
  });

  it('records one submission per material group for multi-material meshes', () => {
    const { renderer, ledger, scene, camera } = attached();
    const geometry = box.clone();
    geometry.clearGroups();
    geometry.addGroup(0, 18, 0);
    geometry.addGroup(18, 18, 1);
    const mesh = tag.static(new Mesh(geometry, [new MeshStandardMaterial(), new MeshBasicMaterial()]));
    mesh.name = 'multi';
    scene.add(mesh);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.totals.sceneSubmissions).toBe(2);
    expect(frame.byReason['multi-material-group']?.submissions).toBe(2);
  });

  it('uses annotations from the compiler as reasons', () => {
    const { renderer, ledger, scene, camera } = attached();
    const mirrored = tag.static(new Mesh(box, new MeshStandardMaterial()));
    mirrored.name = 'mirrored';
    ledger.annotate(mirrored, 'excluded:mirrored');
    scene.add(mirrored);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.[0]?.reason).toBe('excluded:mirrored');
  });

  it('flags shadow casters, double-sided transparency, custom hooks, renderOrder and layers', () => {
    const { renderer, ledger, scene, camera } = attached();
    const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ transparent: true, side: DoubleSide })));
    mesh.castShadow = true;
    mesh.renderOrder = 5;
    mesh.layers.set(3);
    mesh.onBeforeRender = () => {};
    scene.add(mesh);
    camera.layers.enable(3); // the renderer skips objects the camera cannot see
    renderer.render(scene, camera);
    const item = ledger.frame({ items: true }).items?.[0];
    expect(item?.flags).toEqual(expect.arrayContaining(['shadow-caster', 'double-sided-transparent', 'custom-hook', 'render-order', 'layers']));
  });
});

describe('DrawCallLedger reconciliation with renderer.info', () => {
  it('expects one GPU draw per BatchedMesh on WebGL with multi-draw and reconciles to zero unattributed', () => {
    const { renderer, ledger, scene, camera } = attached({ webgpu: false, multiDraw: true });
    scene.add(batchedOf(5, new MeshStandardMaterial(), box));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.env).toMatchObject({ backend: 'webgl2', multiDraw: true });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 2, reportedDrawCalls: 2, unattributed: 0 });
  });

  it('expects N GPU draws per BatchedMesh on WebGPU and on WebGL without multi-draw', () => {
    for (const options of [{ webgpu: true }, { webgpu: false, multiDraw: false }]) {
      const { renderer, ledger, scene, camera } = attached(options);
      scene.add(batchedOf(5, new MeshStandardMaterial(), box));
      renderer.render(scene, camera);
      const frame = ledger.frame();
      expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 6, reportedDrawCalls: 6, unattributed: 0 });
    }
  });

  it('expects no GPU draw for an InstancedMesh whose count is zero (the renderer skips it)', () => {
    const { renderer, ledger, scene, camera } = attached();
    const instanced = new InstancedMesh(box, new MeshStandardMaterial(), 8);
    instanced.count = 0;
    instanced.name = 'empty-instanced';
    scene.add(instanced);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.items?.find((i) => i.name === 'empty-instanced')).toMatchObject({ expectedGpuDraws: 0, instancesDrawn: 0 });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 1, reportedDrawCalls: 1, unattributed: 0 });
  });

  it('expects two GPU draws for double-sided transparent materials', () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ transparent: true, side: DoubleSide }))));
    renderer.render(scene, camera);
    expect(ledger.frame().totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 3, reportedDrawCalls: 3, unattributed: 0 });
  });

  it('reports a non-zero unattributed count when the renderer draws more than expected', () => {
    const renderer = new FakeRenderer();
    const original = renderer.renderObject.bind(renderer);
    // Simulate a backend quirk the ledger does not model: an extra draw per object.
    (renderer as { renderObject: typeof renderer.renderObject }).renderObject = function (...args) {
      original(...args);
      renderer.info.render.drawCalls += 1;
    };
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    renderer.render(scene, camera);
    expect(ledger.frame().totals.unattributed).toBe(2);
  });
});

describe('DrawCallLedger culling stats', () => {
  it('reports instances submitted versus instances drawn after per-instance culling', () => {
    const { renderer, ledger, scene, camera } = attached();
    const batch = batchedOf(5, new MeshStandardMaterial(), box);
    const far = new Matrix4().makeTranslation(1000, 0, 0);
    batch.setMatrixAt(3, far);
    batch.setMatrixAt(4, far);
    scene.add(batch, tag.static(new Mesh(box, new MeshStandardMaterial())));
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.totals.instances).toBe(6);
    expect(frame.totals.instancesDrawn).toBe(4);
    expect(frame.totals.drawCommands).toBe(5); // 3 ranges of the batch + 1 mesh + 1 output quad
    const item = frame.items?.find((i) => i.kind === 'batched');
    expect(item).toMatchObject({ instances: 5, instancesDrawn: 3, expectedGpuDraws: 1 });
  });
});

describe('DrawCallLedger frames and passes', () => {
  it('treats nested render() calls as passes of one frame and names shadow passes after their light', () => {
    const light = new DirectionalLight();
    light.name = 'sun';
    light.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: light });
    const caster = tag.static(new Mesh(box, new MeshStandardMaterial()));
    caster.castShadow = true;
    const nonCaster = tag.static(new Mesh(box, new MeshStandardMaterial()));
    scene.add(light, caster, nonCaster);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['shadow:sun', 'main']);
    expect(frame.passes[0]?.submissions).toBe(1);
    expect(frame.passes[1]?.submissions).toBe(3);
    expect(frame.totals.sceneSubmissions).toBe(3);
    expect(frame.totals.reportedDrawCalls).toBe(4);
    expect(frame.totals.unattributed).toBe(0);
  });

  it('names nested renders of the same scene (reflections, portals) as separate passes', () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    // Like ReflectorNode: a nested render of the same scene into a target, from a virtual camera, during the frame.
    // The wrapper is installed before the ledger attaches, so the ledger wraps it.
    const mirror = camera.clone();
    const original = renderer.render.bind(renderer);
    let nested = false;
    (renderer as { render: typeof renderer.render }).render = function (s, c) {
      if (!nested) {
        nested = true;
        renderer.renderTarget = { name: 'reflection' };
        renderer.render(s, mirror);
        renderer.renderTarget = null;
        nested = false;
      }
      original(s, c);
    };
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['nested:reflection', 'main']);
    expect(frame.passes.map((p) => p.submissions)).toEqual([2, 2]);
    expect(frame.totals.sceneSubmissions).toBe(2);
  });

  it('counts program switches over scene submissions in submission order', () => {
    const { renderer, ledger, scene, camera } = attached();
    const a = new MeshStandardMaterial();
    const b = new MeshBasicMaterial();
    scene.add(tag.static(new Mesh(box, a)), tag.static(new Mesh(box, b)), tag.static(new Mesh(box, a)));
    renderer.render(scene, camera);
    expect(ledger.frame().totals.programSwitches).toBe(2);
  });

  it('ignores renderObject calls that happen outside a frame', () => {
    const { renderer, ledger, scene, camera } = attached();
    const mesh = new Mesh(box, new MeshStandardMaterial());
    renderer.renderObject(mesh, scene, camera, box, mesh.material, null, null, null, null);
    expect(ledger.frame().totals.submissions).toBe(0);
  });

  it('keeps the last completed frame until the next render finishes', () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(new Mesh(box, new MeshStandardMaterial()));
    renderer.render(scene, camera);
    scene.add(new Mesh(box, new MeshStandardMaterial()));
    expect(ledger.frame().totals.sceneSubmissions).toBe(1);
    renderer.render(scene, camera);
    expect(ledger.frame().totals.sceneSubmissions).toBe(2);
  });

  it('detach restores the renderer and stops recording', () => {
    const renderer = new FakeRenderer();
    const originalRender = renderer.render;
    const originalRenderObject = renderer.renderObject;
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    expect(renderer.render).not.toBe(originalRender);
    ledger.detach();
    expect(renderer.render).toBe(originalRender);
    expect(renderer.renderObject).toBe(originalRenderObject);
    const { scene, camera } = sceneWithCamera();
    scene.add(new Mesh(box, new MeshStandardMaterial()));
    renderer.render(scene, camera);
    expect(ledger.frame().totals.submissions).toBe(0);
  });
});

describe('DrawCallLedger snapshot, report and budget', () => {
  it('produces a deterministic JSON snapshot without uuids or object ids', () => {
    const { renderer, ledger, scene, camera } = attached();
    const mesh = tag.static(new Mesh(box, new MeshStandardMaterial()));
    mesh.name = 'crate';
    scene.add(mesh);
    renderer.render(scene, camera);
    const json = JSON.stringify(ledger.frame({ items: true }));
    expect(json).not.toContain(mesh.uuid);
    expect(json).not.toContain(mesh.material.uuid);
    expect(json).not.toContain(`"id":${mesh.id}`);
    const frame = ledger.frame();
    expect(frame.schemaVersion).toBe(2);
    expect(Object.keys(frame.totals).sort()).toEqual(['drawCommands', 'gpuDraws', 'instances', 'instancesDrawn', 'programSwitches', 'programs', 'reportedDrawCalls', 'sceneSubmissions', 'submissions', 'triangles', 'unattributed']);
  });

  it('names unnamed objects by their scene path', () => {
    const { renderer, ledger, scene, camera } = attached();
    const group = new Group();
    group.name = 'props';
    group.add(new Mesh(box, new MeshStandardMaterial()));
    scene.add(group);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.[0]?.name).toBe('props/Mesh[0]');
  });

  it('report() groups submissions by reason with the top offenders', () => {
    const { renderer, ledger, scene, camera } = attached();
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
    const { renderer, ledger, scene, camera } = attached();
    for (let i = 0; i < 4; i++) scene.add(tag.dynamic(new Mesh(box, new MeshStandardMaterial())));
    renderer.render(scene, camera);
    expect(ledger.budget({ maxSubmissions: 4 })).toMatchObject({ pass: true, actual: 4, max: 4 });
    const over = ledger.budget({ maxSubmissions: 2 });
    expect(over.pass).toBe(false);
    expect(over.offenders[0]).toMatchObject({ reason: 'dynamic', submissions: 4 });
  });

  it('counts particles (points honouring drawRange, sprites, sprite batches) and drawing-buffer pixels', () => {
    const { renderer, ledger, scene, camera } = attached();
    (renderer as unknown as { getDrawingBufferSize: (t: Vector2) => Vector2 }).getDrawingBufferSize = (t: Vector2) => t.set(800, 600);
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
    expect(frame.items?.find((i) => i.name === 'forge:sprites:abcd:0')).toMatchObject({ instances: 40, instancesDrawn: 40, expectedGpuDraws: 1 });
    expect(frame.totals.unattributed).toBe(0);
  });
});
