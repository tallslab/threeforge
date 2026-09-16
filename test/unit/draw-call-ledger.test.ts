import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  Bone,
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ObjectSpaceNormalMap,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  PointLight,
  Scene,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  TangentSpaceNormalMap,
  Vector2,
  VSMShadowMap,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type CoordinateSystem,
  type Material,
  type NormalMapTypes,
  type Texture,
} from 'three';
import { color, mix, positionLocal } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { World, type WorldOptions } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import type { SubmissionRecord } from '../../src/ledger/snapshot.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { AnimatedInstances } from '../../src/skinning/AnimatedInstances.js';
import { bakeAnimationTexture } from '../../src/skinning/bakeAnimationTexture.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, batchedOf, sceneWithCamera, type FakeDraw } from './helpers/fakeRenderer.js';
import { buildRig } from './helpers/rig.js';

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

  it('files an InstancedMesh whose userData is null instead of throwing on the per-submission path', () => {
    const { renderer, ledger, scene, camera } = attached();
    const instanced = new InstancedMesh(box, new MeshStandardMaterial(), 4);
    instanced.count = 3;
    instanced.name = 'debris';
    scene.add(instanced);
    // The first frame also rescans the whole scene, which reads userData itself. Render it while userData is still an
    // object so this test exercises the per-submission read — the instance counts every submission files — alone:
    // the next periodic rescan is RESCAN_EVERY frames away, so the frame below reaches no other read.
    renderer.render(scene, camera);
    // app code and non-three loaders assign null, and Object3D.copy propagates it to every clone; three draws it fine.
    (instanced as { userData: unknown }).userData = null;
    renderer.render(scene, camera);

    const frame = ledger.frame({ items: true });
    // No `forge.instances` total to read, so the submitted count stands in for it, as it does for an untouched mesh.
    expect(frame.items?.find((i) => i.name === 'debris')).toMatchObject({ reason: 'instanced', instances: 3, instancesDrawn: 3 });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, unattributed: 0 });
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

  it('expects no GPU draw for an empty sprite batch or VAT batch: an InstancedBufferGeometry with instanceCount 0', () => {
    const { renderer, registry, ledger, scene, camera } = attached();
    const rain = new SpriteMaterial({ color: 0xffffff, transparent: true });
    for (let i = 0; i < 6; i++) {
      const sprite = new Sprite(rain);
      sprite.position.set(i - 3, 0, -5 - i);
      scene.add(sprite);
    }
    scene.updateMatrixWorld(true);
    const world = new World(scene, { registry, ledger });
    expect(world.compile().after.spriteBatches).toBe(1);
    // Added after compile, so World leaves them alone: animated instances with no characters yet.
    const { root, clip } = buildRig();
    const crowd = new AnimatedInstances({ animation: bakeAnimationTexture(root, [clip], { fps: 10 }), count: 0 });
    scene.add(...crowd.meshes);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.find((i) => i.reason === 'sprite-batch')).toMatchObject({ instancesDrawn: 6, expectedGpuDraws: 1 });
    // Turned away from the rain: the batch's hook writes instanceCount 0 inside renderObject, and three draws nothing.
    camera.lookAt(0, 0, 100);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect((world.spriteBatches[0]!.geometry as InstancedBufferGeometry).instanceCount).toBe(0);
    expect(frame.items?.find((i) => i.reason === 'sprite-batch')).toMatchObject({ instances: 0, instancesDrawn: 0, expectedGpuDraws: 0 });
    expect(frame.items?.find((i) => i.reason === 'vat-instanced')).toMatchObject({ instances: 0, instancesDrawn: 0, expectedGpuDraws: 0 });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 2, unattributed: 0 });
  });

  it('predicts each shadow pass with the material three draws (shadowSide, else the side; its own for allowOverride = false) and flags double-sided transparency per pass, under PCF and VSM', () => {
    for (const vsm of [false, true]) {
      const light = new DirectionalLight();
      light.name = 'sun';
      light.castShadow = true;
      const { renderer, ledger, scene, camera } = attached({ shadowLight: light });
      if (vsm) renderer.shadowMap.type = VSMShadowMap;
      const materials: Record<string, Material> = {
        'double-sided': new MeshStandardMaterial({ transparent: true, side: DoubleSide }),
        'shadow-side-double': Object.assign(new MeshStandardMaterial({ transparent: true, side: FrontSide }), { shadowSide: DoubleSide }),
        'shadow-side-front': Object.assign(new MeshStandardMaterial({ transparent: true, side: DoubleSide }), { shadowSide: FrontSide }),
        'no-override': Object.assign(new MeshStandardMaterial({ transparent: true, side: DoubleSide }), { allowOverride: false }),
        'opaque-double-sided': new MeshStandardMaterial({ side: DoubleSide }),
      };
      scene.add(light);
      for (const [name, material] of Object.entries(materials)) {
        const mesh = tag.static(new Mesh(box, material));
        mesh.name = name;
        mesh.castShadow = true;
        scene.add(mesh);
      }
      renderer.render(scene, camera);
      const frame = ledger.frame({ items: true });
      const seen = Object.fromEntries(frame.items!.filter((i) => i.reason !== 'renderer-internal').map((i) => [`${i.pass} ${i.name}`, [i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]]));
      expect(seen, vsm ? 'VSM' : 'PCF').toEqual({
        'shadow:sun double-sided': [2, true],
        'shadow:sun shadow-side-double': [2, true],
        'shadow:sun shadow-side-front': [1, false],
        'shadow:sun no-override': [2, true],
        'shadow:sun opaque-double-sided': [1, false],
        'main double-sided': [2, true],
        'main shadow-side-double': [1, false],
        'main shadow-side-front': [2, true],
        'main no-override': [2, true],
        'main opaque-double-sided': [1, false],
      });
      expect(frame.totals.unattributed, vsm ? 'VSM' : 'PCF').toBe(0);
    }
  });

  it('predicts a scene override material with its own side and the source transparency, and flags it per submission', () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.overrideMaterial = new MeshBasicMaterial({ side: DoubleSide });
    const materials: Record<string, Material> = {
      opaque: new MeshStandardMaterial({ side: FrontSide }),
      transparent: new MeshStandardMaterial({ transparent: true, side: FrontSide }),
      'no-override': Object.assign(new MeshStandardMaterial({ transparent: true, side: FrontSide }), { allowOverride: false }),
    };
    for (const [name, material] of Object.entries(materials)) {
      const mesh = tag.static(new Mesh(box, material));
      mesh.name = name;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    // renderer-internal items are left out: three draws the output quad on this canvas render too, the fake does not (Task 41).
    const seen = Object.fromEntries(frame.items!.filter((i) => i.reason !== 'renderer-internal').map((i) => [`${i.pass} ${i.name}`, [i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]]));
    expect(seen).toEqual({ 'override opaque': [1, false], 'override transparent': [2, true], 'override no-override': [1, false] });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 3, unattributed: 0 });
  });

  it('predicts a double-sided transmissive material as two single-draw submissions, the back-side pass then the front, in its shadow pass too', () => {
    const light = new DirectionalLight();
    light.name = 'sun';
    light.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: light });
    const glass = tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide })));
    glass.name = 'glass';
    const clear = tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, transparent: true, side: DoubleSide })));
    clear.name = 'clear-glass';
    glass.castShadow = true;
    clear.castShadow = true;
    scene.add(light, glass, clear);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    const items = frame.items!.filter((i) => i.reason !== 'renderer-internal').map((i) => [i.pass, i.name, i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]);
    expect(items).toEqual([
      ['shadow:sun', 'glass', 1, false],
      ['shadow:sun', 'clear-glass', 1, false],
      ['shadow:sun', 'glass', 1, false],
      ['shadow:sun', 'clear-glass', 1, false],
      ['main', 'glass', 1, false],
      ['main', 'clear-glass', 1, false],
      ['main', 'glass', 1, false],
      ['main', 'clear-glass', 1, false],
    ]);
    expect(frame.totals).toMatchObject({ sceneSubmissions: 8, unattributed: 0 });
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

describe('DrawCallLedger and multi-draw slots a nested pass zeroed', () => {
  /** Two rows of 101 static cubes, one batch each; the lit row receives shadows, so its draw renders the shadow map. */
  function rows(cs: CoordinateSystem): { scene: Scene; light: DirectionalLight; camera: PerspectiveCamera } {
    const scene = new Scene();
    const light = new DirectionalLight();
    light.name = 'sun';
    light.castShadow = true;
    light.position.set(0, 60, 10);
    const shadowCamera = light.shadow.camera;
    shadowCamera.coordinateSystem = cs;
    Object.assign(shadowCamera, { left: -50, right: 50, top: 20, bottom: -20, near: 1, far: 200 });
    shadowCamera.updateProjectionMatrix();
    scene.add(light, light.target);
    const lit = new MeshStandardMaterial({ roughness: 0.8 });
    const unlit = new MeshBasicMaterial();
    for (let i = 0; i < 202; i++) {
      const receiveShadow = i >= 101;
      const mesh = tag.static(new Mesh(box, receiveShadow ? lit : unlit));
      mesh.name = `${receiveShadow ? 'lit' : 'unlit'}-${i % 101}`;
      mesh.position.set(-100 + 2 * (i % 101), 0.5, receiveShadow ? 3 : -3);
      mesh.castShadow = true;
      mesh.receiveShadow = receiveShadow;
      scene.add(mesh);
    }
    scene.updateMatrixWorld(true);
    // The main camera sees x in about [70, 110] and the shadow camera [-50, 50]: the shadow pass keeps the main list's
    // slots, zeroes their counts and appends its own ids.
    const camera = new PerspectiveCamera(60, 1, 0.1, 200);
    camera.coordinateSystem = cs;
    camera.updateProjectionMatrix();
    camera.position.set(90, 6, 35);
    camera.lookAt(90, 0, 0);
    camera.updateMatrixWorld();
    return { scene, light, camera };
  }

  it("expects every slot as a GPU draw, as three's Info counts them, and counts only slots with a non-zero index count as drawn instances and draw commands", () => {
    const variants = [
      { label: 'webgl2 multi-draw', webgpu: false, multiDraw: true },
      { label: 'webgl2', webgpu: false, multiDraw: false },
      { label: 'webgpu', webgpu: true, multiDraw: false },
    ];
    const isBatch = (draw: FakeDraw): boolean => (draw.object as { isBatchedMesh?: boolean }).isBatchedMesh === true;
    const drawn: Record<string, number[]> = {};
    for (const { label, webgpu, multiDraw } of variants) {
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const { scene, light, camera } = rows(cs);
      const ledger = new DrawCallLedger();
      new World(scene, { instanceThreshold: 1000, ledger }).compile({ coordinateSystem: cs });
      const renderer = new FakeRenderer({ webgpu, multiDraw, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: [light] });
      ledger.attach(renderer as never);
      renderer.render(scene, camera);
      const frame = ledger.frame({ items: true });
      const batches = frame.items!.filter((i) => i.kind === 'batched');
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter(isBatch));
        const items = batches.filter((i) => i.pass.startsWith('shadow:') === (kind === 'shadow'));
        expect(draws.length, `${label} ${kind}: batch draws`).toBe(2);
        expect(items.map((i) => i.expectedGpuDraws), `${label} ${kind}: GPU draws`).toEqual(draws.map((d) => d.drawCalls));
        expect(items.map((i) => i.instancesDrawn), `${label} ${kind}: drawn instances`).toEqual(draws.map((d) => d.batchIds!.length));
      }
      const commands = renderer.passes.flatMap((p) => p.draws).reduce((n, d) => n + (isBatch(d) ? d.batchIds!.length : d.drawCalls), 0);
      expect(frame.totals.drawCommands, `${label}: draw commands`).toBe(commands);
      expect(frame.totals.unattributed, `${label}: unattributed`).toBe(0);
      if (!multiDraw) {
        // One call per slot: each shadow draw issued more calls than it drew instances, so the pass did zero slots.
        const shadow = batches.filter((i) => i.pass.startsWith('shadow:'));
        expect(shadow.every((i) => i.expectedGpuDraws > i.instancesDrawn), `${label}: zeroed slots`).toBe(true);
      }
      drawn[label] = batches.map((i) => i.instancesDrawn);
    }
    // WEBGL_multi_draw packs the same slots into one call: the drawn instances do not depend on the packaging.
    expect(drawn['webgl2 multi-draw']).toEqual(drawn.webgl2);
  });

  it('predicts a compacted InstancedMesh from the count each pass draws, so a shadow pass appending only its own light stays attributed', () => {
    const isInstanced = (draw: FakeDraw): boolean => (draw.object as { isInstancedMesh?: boolean }).isInstancedMesh === true;
    for (const webgpu of [false, true]) {
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const { scene, light, camera } = rows(cs);
      const ledger = new DrawCallLedger();
      // The default instanceThreshold compacts each row of 101 repeats into a CulledInstancedMesh.
      const report = new World(scene, { ledger }).compile({ coordinateSystem: cs });
      expect(report.after, `webgpu ${webgpu}: two instanced rows`).toMatchObject({ batches: 0, instanced: 2 });
      const renderer = new FakeRenderer({ webgpu, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: [light] });
      ledger.attach(renderer as never);
      renderer.render(scene, camera);
      const frame = ledger.frame({ items: true });
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter(isInstanced));
        const items = frame.items!.filter((i) => i.reason === 'instanced' && i.pass.startsWith('shadow:') === (kind === 'shadow'));
        expect(draws.length, `webgpu ${webgpu} ${kind}: instanced draws`).toBe(2);
        // getDrawParameters takes instanceCount from object.count, which the pass's append set and its end restores
        // after the ledger has read it: the prediction is that count, whatever subset of the frame's casters it holds.
        expect(
          items.map((i) => i.expectedGpuDraws),
          `webgpu ${webgpu} ${kind}: GPU draws`,
        ).toEqual(draws.map((d) => d.drawCalls));
        expect(
          items.map((i) => i.instancesDrawn),
          `webgpu ${webgpu} ${kind}: drawn instances`,
        ).toEqual(draws.map((d) => d.instanceCount));
      }
      expect(frame.totals.unattributed, `webgpu ${webgpu}: unattributed`).toBe(0);
    }
  });

  it('predicts every pass of a frame with two shadow lights, each pass narrowed against the other', () => {
    // With one light, "the casters this light reaches" and "the casters any light of the frame reaches" are the same
    // set, so the test above would still pass against a pass that appended the frame's whole union. Two lights whose
    // shadow cameras cover different slices of the rows separate the two, so a pass narrowed relative to the other
    // light is actually exercised.
    const isInstanced = (draw: FakeDraw): boolean => (draw.object as { isInstancedMesh?: boolean }).isInstancedMesh === true;
    for (const webgpu of [false, true]) {
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const { scene, light, camera } = rows(cs);
      light.name = 'west'; // covers x in [-50, 50], away from the main camera's [70, 110]
      const east = new DirectionalLight();
      east.name = 'east';
      east.castShadow = true;
      east.position.set(60, 60, 10);
      const eastCamera = east.shadow.camera;
      eastCamera.coordinateSystem = cs;
      Object.assign(eastCamera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
      eastCamera.updateProjectionMatrix();
      east.target.position.set(60, 0, 0); // covers x in [40, 80]
      scene.add(east, east.target);
      scene.updateMatrixWorld(true);

      const ledger = new DrawCallLedger();
      const report = new World(scene, { ledger }).compile({ coordinateSystem: cs });
      expect(report.after, `webgpu ${webgpu}: two instanced rows`).toMatchObject({ batches: 0, instanced: 2 });
      const renderer = new FakeRenderer({ webgpu, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: [light, east] });
      ledger.attach(renderer as never);
      renderer.render(scene, camera);

      const frame = ledger.frame({ items: true });
      const shadowPasses = renderer.passes.filter((p) => p.kind === 'shadow');
      expect(
        shadowPasses.map((p) => p.light!.name),
        `webgpu ${webgpu}: both lights render a map`,
      ).toEqual(['west', 'east']);
      // Pass by pass, not lumped by kind: each pass's prediction has to match that pass's own draws.
      for (const pass of renderer.passes) {
        const id = pass.kind === 'shadow' ? `shadow:${pass.light!.name}` : 'main';
        const draws = pass.draws.filter(isInstanced);
        const items = frame.items!.filter((i) => i.reason === 'instanced' && i.pass === id);
        expect(draws.length, `webgpu ${webgpu} ${id}: instanced draws`).toBe(2);
        expect(
          items.map((i) => i.expectedGpuDraws),
          `webgpu ${webgpu} ${id}: GPU draws`,
        ).toEqual(draws.map((d) => d.drawCalls));
        // getDrawParameters takes instanceCount from object.count, which this pass's append set.
        expect(
          items.map((i) => i.instancesDrawn),
          `webgpu ${webgpu} ${id}: drawn instances`,
        ).toEqual(draws.map((d) => d.instanceCount));
      }
      // The two shadow passes really do append different slices, or the narrowing would go untested.
      const appended = shadowPasses.map((p) => p.draws.filter(isInstanced).reduce((n, d) => n + d.instanceCount, 0));
      expect(appended[0], `webgpu ${webgpu}: the two shadow passes append different slices`).not.toBe(appended[1]);
      expect(frame.totals.unattributed, `webgpu ${webgpu}: unattributed`).toBe(0);
    }
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
    // The mesh in both passes; the output quad only in the main one. three converts colour space when it writes the
    // output target, so the reflection's render into a target draws no "Output Color Transform" quad (Renderer.js:1563,
    // :2686) — the nested pass is the mesh alone.
    expect(frame.passes.map((p) => p.submissions)).toEqual([1, 2]);
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

/** The ledger's private render depth: 0 between frames. */
const depthOf = (ledger: DrawCallLedger): number => (ledger as unknown as { depth: number }).depth;

describe('DrawCallLedger and renderAsync', () => {
  it("relies on three's renderAsync awaiting init() and then calling this.render() (Renderer.js, r186), so it does not patch renderAsync", () => {
    const source = readFileSync(createRequire(import.meta.url).resolve('three/src/renderers/common/Renderer.js'), 'utf8');
    const start = source.indexOf('\tasync renderAsync( scene, camera ) {');
    expect(start, 'Renderer.renderAsync( scene, camera ) is defined').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n\t}\n', start));
    expect(body).toContain('this.render(');
    expect(body.indexOf('await this.init()'), 'init() is awaited before the render').toBeGreaterThan(-1);
    expect(body.indexOf('await this.init()')).toBeLessThan(body.indexOf('this.render('));
  });

  it('a frame rendered through renderAsync is one main frame: its shadow pass and skinning count as they do through render()', async () => {
    const setup = () => {
      const light = new DirectionalLight();
      light.name = 'sun';
      light.castShadow = true;
      const pair = attached({ shadowLight: light });
      const caster = tag.static(new Mesh(box, new MeshStandardMaterial()));
      caster.castShadow = true;
      const bones = [new Bone(), new Bone()];
      bones[0]!.add(bones[1]!);
      const skinned = new SkinnedMesh(box, new MeshStandardMaterial());
      skinned.name = 'skinned';
      skinned.castShadow = true;
      skinned.add(bones[0]!);
      skinned.bind(new Skeleton(bones));
      pair.scene.add(light, caster, skinned);
      return pair;
    };
    const viaRender = setup();
    viaRender.renderer.render(viaRender.scene, viaRender.camera);
    const expected = viaRender.ledger.frame();
    const viaAsync = setup();
    await viaAsync.renderer.renderAsync(viaAsync.scene, viaAsync.camera);
    const frame = viaAsync.ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['shadow:sun', 'main']);
    expect(frame.skinning).toMatchObject({ submissions: 1, bones: 2, skeletons: 1 });
    expect(frame.lighting.shadowPasses).toBe(1);
    expect(frame.passes).toEqual(expected.passes);
    expect(frame.totals).toEqual(expected.totals);
    expect(frame.skinning).toEqual(expected.skinning);
    expect(frame.lighting).toEqual(expected.lighting);
  });

  it('a render() while renderAsync awaits init() is a frame of its own, and so is the render renderAsync then makes: two main frames', async () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())), tag.static(new Mesh(box, new MeshStandardMaterial())));
    const other = new Scene();
    other.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const pending = renderer.renderAsync(scene, camera); // suspended at `await this.init()`
    // No pass kind is pending in the fake here (only a shadow or VSM pass sets one, right before its own render), so this
    // render cannot take another render's kind.
    renderer.render(other, camera);
    const between = ledger.frame();
    await pending;
    const after = ledger.frame();
    expect([between.passes.map((p) => p.id), between.totals.sceneSubmissions], 'the frame the interleaved render() completed').toEqual([['main'], 1]);
    expect([after.passes.map((p) => p.id), after.totals.sceneSubmissions], 'the frame renderAsync completed').toEqual([['main'], 2]);
  });

  it('depth is back at 0 after renderAsync, after an interleaved render() and after a render or renderAsync that throws', async () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const pending = renderer.renderAsync(scene, camera);
    expect.soft(depthOf(ledger), 'while renderAsync awaits init()').toBe(0);
    renderer.render(scene, camera);
    expect.soft(depthOf(ledger), 'after a render() interleaved with renderAsync').toBe(0);
    await pending;
    expect.soft(depthOf(ledger), 'after renderAsync').toBe(0);

    const throwing = tag.static(new Mesh(box, new MeshStandardMaterial()));
    throwing.onBeforeRender = () => {
      throw new Error('hook failed');
    };
    scene.add(throwing);
    expect(() => renderer.render(scene, camera)).toThrow('hook failed');
    expect.soft(depthOf(ledger), 'after a render() that throws').toBe(0);
    await expect(renderer.renderAsync(scene, camera)).rejects.toThrow('hook failed');
    expect.soft(depthOf(ledger), 'after a renderAsync that rejects').toBe(0);
    scene.remove(throwing);
    renderer.render(scene, camera);
    expect([ledger.frame().passes.map((p) => p.id), ledger.frame().totals.sceneSubmissions], 'the next render() is a frame of its own').toEqual([['main'], 1]);
  });

  it('attach() and detach() leave renderAsync untouched: no own property shadows the prototype method', () => {
    const renderer = new FakeRenderer();
    const original = renderer.renderAsync;
    const own = () => Object.prototype.hasOwnProperty.call(renderer, 'renderAsync');
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    expect([renderer.renderAsync === original, own()], 'attached').toEqual([true, false]);
    ledger.detach();
    expect([renderer.renderAsync === original, own()], 'detached').toEqual([true, false]);
  });

  it('attach() after a detach() from inside a draw starts from depth 0, so the next render is a main frame', () => {
    const { renderer, ledger, scene, camera } = attached();
    let detachNext = true;
    const mesh = tag.static(new Mesh(box, new MeshStandardMaterial()));
    mesh.onBeforeRender = () => {
      if (!detachNext) return;
      detachNext = false;
      ledger.detach(); // the running render wrapper still calls exit() in its finally
    };
    scene.add(mesh);
    renderer.render(scene, camera);
    ledger.attach(renderer as never);
    expect.soft(depthOf(ledger), 'depth after attach()').toBe(0);
    renderer.render(scene, camera);
    expect([ledger.frame().passes.map((p) => p.id), ledger.frame().totals.sceneSubmissions]).toEqual([['main'], 1]);
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
    expect(frame.schemaVersion).toBe(3);
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

  it('counts hidden originals on layer 31 and reports the attached scheduler\'s skipped ticks', () => {
    const { renderer, ledger, scene, camera } = attached();
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

  it('rescans a scene holding a node whose userData is null instead of throwing, and still fills the memory and hint sections', () => {
    const { renderer, ledger, scene, camera } = attached();
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
    // Collected in the same traversal, right after the read that used to throw.
    expect(first.hints.find((h) => h.code === 'static-auto-update')?.objects).toEqual(['a', 'b', 'c']);

    // And again on the periodic rescan, RESCAN_EVERY frames later.
    for (let i = 0; i < 60; i++) renderer.render(scene, camera);
    expect(ledger.frame().js.objects).toBe(4);
  });

  it('names no point light or transmissive mesh under a hidden parent, and no point-light shadow while shadow maps are off', () => {
    const { renderer, ledger, scene, camera } = attached();
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
    const { renderer, ledger, scene, camera } = attached();
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

describe('DrawCallLedger shared materials: unique-material and static-unbatched', () => {
  const named = <T extends Mesh>(mesh: T, name: string): T => {
    mesh.name = name;
    return mesh;
  };
  /** name → reason of the frame's scene items in `pass` (renderer-internal work left out). */
  const reasonsIn = (ledger: DrawCallLedger, pass = 'main') =>
    Object.fromEntries((ledger.frame({ items: true }).items ?? []).filter((i) => i.pass === pass && i.reason !== 'renderer-internal').map((i) => [i.name, i.reason]));
  const indexOf = (ledger: DrawCallLedger, name: string) => ledger.frame({ items: true }).items!.find((i) => i.name === name)!.material;

  it('calls two statics sharing one built-in material static-unbatched, without a World; a material instance drawn once stays unique-material', () => {
    const { renderer, ledger, scene, camera } = attached();
    const shared = new MeshStandardMaterial({ color: 0x336699 });
    // Equal by value, but its own instance and never registered: nothing else draws it.
    const own = new MeshStandardMaterial({ color: 0x336699 });
    scene.add(named(tag.static(new Mesh(box, shared)), 'a'), named(tag.static(new Mesh(new PlaneGeometry(1, 1), shared)), 'b'), named(tag.static(new Mesh(box, own)), 'alone'));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
    expect(frame.byReason['static-unbatched']).toEqual({ submissions: 2, gpuDraws: 2, top: ['a', 'b'] });
    expect(frame.byReason['unique-material']).toEqual({ submissions: 1, gpuDraws: 1, top: ['alone'] });
    expect(indexOf(ledger, 'a')).toBe(indexOf(ledger, 'b'));
    expect(indexOf(ledger, 'alone')).not.toBe(indexOf(ledger, 'a'));
  });

  it("counts uses per registry canonical: identical registered built-ins share one, materials differing only in an instance onBeforeRender do not", () => {
    const { renderer, registry, ledger, scene, camera } = attached();
    const first = new MeshStandardMaterial({ color: 0x884422 });
    const second = new MeshStandardMaterial({ color: 0x884422 });
    registry.register(first);
    registry.register(second);
    expect(registry.canonicalOf(second)).toBe(first);
    const hooked = [0, 1].map(() => {
      const material = new MeshStandardMaterial({ color: 0x224488 });
      material.onBeforeRender = () => {};
      registry.register(material);
      return material;
    });
    expect(registry.canonicalOf(hooked[1]!)).toBe(hooked[1]);
    // The meshes keep their own instances: no World swapped the canonicals in.
    scene.add(
      named(tag.static(new Mesh(box, first)), 'merged-1'),
      named(tag.static(new Mesh(box, second)), 'merged-2'),
      named(tag.static(new Mesh(box, hooked[0]!)), 'hooked-1'),
      named(tag.static(new Mesh(box, hooked[1]!)), 'hooked-2'),
    );
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({ 'merged-1': 'static-unbatched', 'merged-2': 'static-unbatched', 'hooked-1': 'unique-material', 'hooked-2': 'unique-material' });
    expect(indexOf(ledger, 'merged-1')).toBe(indexOf(ledger, 'merged-2'));
    expect(indexOf(ledger, 'hooked-1')).not.toBe(indexOf(ledger, 'hooked-2'));
  });

  it('counts uses per object: a static the main pass draws twice (the back-side pass of a double-sided transmissive material) is not shared with itself', () => {
    const { renderer, ledger, scene, camera } = attached();
    scene.add(named(tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }))), 'glass'));
    renderer.render(scene, camera);
    const glass = ledger.frame({ items: true }).items!.filter((i) => i.pass === 'main' && i.name === 'glass');
    expect(glass).toHaveLength(2);
    expect(glass.map((i) => i.reason)).toEqual(['unique-material', 'unique-material']);
    expect(glass[0]!.material).toBe(glass[1]!.material);
  });

  it('counts main-pass uses only, and relabels a shared static in every pass it draws in', () => {
    const sun = new DirectionalLight();
    sun.name = 'sun';
    sun.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: sun });
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const caster = named(tag.static(new Mesh(box, stone)), 'caster');
    caster.castShadow = true;
    // Drawn in the main pass and, through its hook, the only user of `paint` in the main pass: a second scene draws it too.
    const paint = new MeshStandardMaterial({ color: 0x3355ff });
    const portal = named(tag.static(new Mesh(box, paint)), 'portal');
    const room = new Scene();
    room.name = 'room';
    room.add(named(tag.static(new Mesh(box, paint)), 'far-wall'));
    let inside = false;
    portal.onBeforeRender = ((r: unknown) => {
      if (inside) return;
      inside = true;
      (r as FakeRenderer).render(room, camera);
      inside = false;
    }) as Mesh['onBeforeRender'];
    scene.add(sun, caster, named(tag.static(new Mesh(box, stone)), 'plinth'), portal);
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({ caster: 'static-unbatched', plinth: 'static-unbatched', portal: 'unique-material' });
    expect(reasonsIn(ledger, 'shadow:sun')).toEqual({ caster: 'static-unbatched' });
    expect(reasonsIn(ledger, 'scene:room')).toEqual({ 'far-wall': 'unique-material' });
  });

  it("counts no use for renderer-internal work: a static sharing the output quad's material stays unique-material", () => {
    const { renderer, ledger, scene, camera } = attached();
    const shared = new MeshStandardMaterial({ color: 0x66aa44 });
    // three's output quad is the renderer's own object, drawn in the main pass and filed as renderer-internal.
    renderer.outputQuad.material = shared;
    scene.add(named(tag.static(new Mesh(box, shared)), 'alone'));
    renderer.render(scene, camera);

    const items = ledger.frame({ items: true }).items!;
    const quad = items.find((i) => i.name === 'Output Color Transform')!;
    const alone = items.find((i) => i.name === 'alone')!;
    expect(quad.reason).toBe('renderer-internal');
    // The quad's submission is still indexed — every record carries a material index, and it is the same canonical —
    // but it counts as no user, so the scene's static is still the only object drawing that material.
    expect(quad.material).toBe(alone.material);
    expect(reasonsIn(ledger)).toEqual({ alone: 'unique-material' });
  });

  it("counts no use from a measureOverdraw() a hook of the frame starts: its count renders are not submissions", async () => {
    const { renderer, ledger, scene, camera } = attached();
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const a = named(tag.static(new Mesh(box, stone)), 'a');
    const b = named(tag.static(new Mesh(box, stone)), 'b');
    scene.add(a, b, named(tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x224466 }))), 'alone'));
    renderer.render(scene, camera);
    const plain = ledger.frame({ items: true });

    let pending: Promise<unknown> | null = null;
    let started = false;
    a.onBeforeRender = () => {
      // Measure once: the count render draws `a` again and calls this hook with it.
      if (started) return;
      started = true;
      pending = ledger.measureOverdraw(scene, camera);
    };
    renderer.render(scene, camera);
    const hooked = ledger.frame({ items: true });
    a.onBeforeRender = () => {};
    expect(pending).not.toBeNull();
    await pending;

    // The count renders drew every object again with the count material; none of it was filed, so the frame's
    // material indices and reasons are exactly those of the frame before it.
    const keyed = (frame: typeof plain) => frame.items!.map((i) => [i.name, i.material, i.reason]);
    expect(keyed(hooked)).toEqual(keyed(plain));
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
  });

  it('indexes materials per frame in first-draw order and decides shared per frame; items held from an earlier frame keep their values', () => {
    const { renderer, ledger, scene, camera } = attached();
    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff });
    const lead = named(tag.static(new Mesh(box, red)), 'lead');
    const twin = named(tag.static(new Mesh(box, blue)), 'twin');
    const other = named(tag.static(new Mesh(box, blue)), 'other');
    scene.add(lead, twin, other);
    renderer.render(scene, camera);
    const scene1 = (items: SubmissionRecord[]) => items.filter((i) => i.reason !== 'renderer-internal').map((i) => [i.name, i.material, i.reason]);
    const first = ledger.frame({ items: true }).items!;
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
    lead.visible = false;
    other.visible = false;
    renderer.render(scene, camera);
    expect(scene1(ledger.frame({ items: true }).items!)).toEqual([['twin', 0, 'unique-material']]);
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
  });
});

describe('DrawCallLedger hints count objects, not submissions', () => {
  const hint = (ledger: DrawCallLedger, code: string) => ledger.frame().hints.find((h) => h.code === code);

  it('counts 11 shadow-casting statics under a sun as 11 meshes: no unique-materials hint below its threshold of more than 20', () => {
    const sun = new DirectionalLight();
    sun.name = 'sun';
    sun.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: sun });
    scene.add(sun);
    for (let i = 0; i < 11; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x101010 * (i + 1) })));
      mesh.name = `statue-${i}`;
      mesh.castShadow = true;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unique-material']?.submissions, 'main and shadow pass').toBe(22);
    expect(hint(ledger, 'unique-materials')).toBeUndefined();
    for (let i = 11; i < 21; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x0f0f0f * (i + 1) })));
      mesh.name = `statue-${i}`;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(hint(ledger, 'unique-materials')?.message).toBe('21 meshes each with a material used once: share materials through the registry');
  });

  it('counts one untagged caster under a point light as one untagged mesh, not seven', () => {
    const lamp = new PointLight(0xffffff, 1);
    lamp.name = 'lamp';
    lamp.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: lamp });
    const crate = new Mesh(box, new MeshStandardMaterial());
    crate.name = 'crate';
    crate.castShadow = true;
    scene.add(lamp, crate);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason.untagged?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(hint(ledger, 'untagged')?.message).toBe('1 untagged meshes: tag.static() or tag.dynamic() them');
  });

  it("counts a double-sided transmissive mesh once although the main pass draws it twice (three's back-side pass)", () => {
    const { renderer, ledger, scene, camera } = attached();
    const glass = new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }));
    glass.name = 'glass';
    scene.add(glass);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items!.filter((i) => i.name === 'glass' && i.pass === 'main')).toHaveLength(2);
    expect(hint(ledger, 'untagged')?.message).toBe('1 untagged meshes: tag.static() or tag.dynamic() them');
  });

  it('counts unsupported-material by distinct objects over every pass: one caster under a point light is one mesh, and one drawn only into its shadow map still counts', () => {
    const lamp = new PointLight(0xffffff, 1);
    lamp.name = 'lamp';
    lamp.castShadow = true;
    const { renderer, ledger, scene, camera } = attached({ shadowLight: lamp });
    const panel = tag.static(new Mesh(box, new ShaderMaterial()));
    panel.name = 'panel';
    panel.castShadow = true;
    scene.add(lamp, panel);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unsupported-material']?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(hint(ledger, 'unsupported-material')?.message).toBe('1 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
    // On a layer the main camera does not see, so only the six shadow faces draw it. Its material renders nowhere on
    // WebGPU either, so it is still a mesh this error hint names, although no main-pass record carries it.
    const offCamera = tag.static(new Mesh(box, new ShaderMaterial()));
    offCamera.name = 'off-camera';
    offCamera.castShadow = true;
    offCamera.layers.set(1);
    lamp.shadow!.camera.layers.enable(1);
    scene.add(offCamera);
    renderer.render(scene, camera);
    const drawn = ledger.frame({ items: true }).items!.filter((i) => i.name === 'off-camera');
    expect(drawn.map((i) => i.pass)).toEqual(Array(6).fill('shadow:lamp'));
    expect(ledger.frame().byReason['unsupported-material']?.submissions).toBe(13);
    expect(hint(ledger, 'unsupported-material')?.message).toBe('2 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
    ledger.rescan();
    expect(hint(ledger, 'unsupported-material')?.message).toBe('2 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
  });

  it('counts sprites drawn one by one as objects for sprites-unbatched, and keeps the counts on a rescan between frames', () => {
    const { renderer, ledger, scene, camera } = attached();
    const material = new SpriteMaterial();
    for (let i = 0; i < 8; i++) scene.add(new Sprite(material));
    renderer.render(scene, camera);
    expect(hint(ledger, 'sprites-unbatched')?.message).toBe('8 sprites drawn one by one: World batches sprites that share a material (sprites: \'batch\')');
    ledger.rescan();
    expect(hint(ledger, 'sprites-unbatched')?.message).toBe('8 sprites drawn one by one: World batches sprites that share a material (sprites: \'batch\')');
  });
});

/**
 * `batch-local-space` (Ruling R164): three r186 gives a batched or instanced draw `positionLocal` multiplied by its
 * instance matrix (Batch.js:148, Instance.js:206-207), and a baked mesh's positions are written in scene space, so a node
 * reading `positionLocal` and `alphaHash` (which hashes it, NodeMaterial.js:893) may draw differently than the individual
 * meshes. The ledger names World's compiled draws whose material has a node in a slot (`hasNodeSlot`, the test
 * `spriteRule`'s `sprite-node-material` uses) or `alphaHash`, and nothing else.
 */
describe('DrawCallLedger batch-local-space hint', () => {
  const CODE = 'batch-local-space';
  const hint = (ledger: DrawCallLedger) => ledger.frame().hints.find((h) => h.code === CODE);
  const gradient = (): Material => Object.assign(new MeshStandardNodeMaterial(), { name: 'gradient', colorNode: mix(color(0x2040ff), color(0xff8020), positionLocal.y.add(0.5)) });
  const hashed = (): Material => new MeshStandardMaterial({ name: 'hashed', alphaHash: true, opacity: 0.5 });
  const engraved = (normalMapType: NormalMapTypes = ObjectSpaceNormalMap, normalMap: Texture | null = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1)): Material => new MeshStandardMaterial({ name: 'engraved', normalMap, normalMapType });

  /**
   * `count` transformed boxes sharing `material` (or the material `material(registry)` returns, given the ledger's registry,
   * which World uses too), tagged static (or dynamic), compiled by World, then one frame rendered (the first frame rescans).
   */
  function compiled(source: Material | ((registry: MaterialRegistry) => Material), options: { count?: number; dynamic?: boolean; world?: WorldOptions; geometry?: BufferGeometry } = {}) {
    const { renderer, registry, ledger, scene, camera } = attached();
    const material = typeof source === 'function' ? source(registry) : source;
    for (let i = 0; i < (options.count ?? 4); i++) {
      const mesh = new Mesh(options.geometry ?? box, material);
      mesh.name = `box-${i}`;
      mesh.position.set(i * 1.5 - 2, 0, 0);
      mesh.rotation.set(0.3, i * 0.2, 0.4);
      mesh.scale.set(1, 1.6, 0.8);
      scene.add(options.dynamic ? tag.dynamic(mesh) : tag.static(mesh));
    }
    scene.updateMatrixWorld(true);
    const world = new World(scene, { registry, ledger, ...options.world });
    const report = world.compile();
    renderer.render(scene, camera);
    return { renderer, ledger, scene, camera, world, report };
  }

  it('fires for a batch whose material has a node in a slot, naming the batch and the material', () => {
    const { ledger, report } = compiled(gradient());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toEqual({
      category: 'drawCalls',
      severity: 'info',
      code: CODE,
      message: "1 threeforge batched, instanced or baked draw uses a node in a material slot, alphaHash or an object-space normal map, which read mesh-local space, now the scene's: shading can change — tag those meshes dynamic to keep them individual (materials: gradient)",
      objects: [report.groups[0]!.name],
    });
    expect(report.groups[0]!.name.startsWith('forge:batch:')).toBe(true);
  });

  it('fires for a batch whose material has alphaHash', () => {
    const { ledger, report } = compiled(hashed());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toMatchObject({ severity: 'info', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: hashed)')).toBe(true);
  });

  it('fires for a batch whose material has an object-space normal map, not for a tangent-space one or the map type without a map', () => {
    const { ledger, report } = compiled(engraved());
    expect(report.after.batches).toBe(1);
    expect(hint(ledger)).toMatchObject({ severity: 'info', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: engraved)')).toBe(true);
    for (const [label, material] of [['a tangent-space normal map', engraved(TangentSpaceNormalMap)], ['ObjectSpaceNormalMap without a normalMap', engraved(ObjectSpaceNormalMap, null)]] as Array<[string, Material]>) {
      const silent = compiled(material);
      expect(silent.report.after.batches, label).toBe(1);
      expect(hint(silent.ledger), label).toBeUndefined();
    }
  });

  it('fires for instanced groups and a baked group of such materials, one name per group', () => {
    // A level attached by hand (what prepareLods stores): the group draws as two InstancedMeshes sharing its material.
    const leveled = new BoxGeometry(1, 1, 1);
    leveled.userData.forgeLods = [new BoxGeometry(1, 1, 1)];
    const node = compiled(gradient(), { geometry: leveled, world: { instanceThreshold: 4, lod: { distances: [30] } } });
    expect(node.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 2, baked: 0 }));
    expect(node.world.instancedMeshes.map((m) => m.material)).toEqual([node.world.instancedMeshes[0]!.material, node.world.instancedMeshes[0]!.material]);
    expect(hint(node.ledger)?.objects).toEqual([node.report.groups[0]!.name]);
    expect(hint(node.ledger)?.message.startsWith('1 threeforge batched, instanced or baked draw uses')).toBe(true);
    expect(node.report.groups[0]!.name.startsWith('forge:instanced:')).toBe(true);
    const hash = compiled(hashed(), { world: { instanceThreshold: 4 } });
    expect(hash.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 1, baked: 0 }));
    expect(hint(hash.ledger)?.objects).toEqual([hash.report.groups[0]!.name]);
    // The bake writes every module in scene space, so its positions are what batching would hand positionLocal. A node
    // material never bakes (bakeProvesReads); alphaHash does.
    const baked = compiled(hashed(), { world: { bake: true } });
    expect(baked.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 1 }));
    expect(hint(baked.ledger)?.objects).toEqual([baked.report.groups[0]!.name]);
    // An object-space normal map bakes too, and three transforms its normals by the baked mesh's (the scene's) matrix.
    for (const world of [{ instanceThreshold: 4 }, { bake: true }] as WorldOptions[]) {
      const normals = compiled(engraved(), { world });
      expect(normals.report.after.batches + normals.report.after.instanced + normals.report.after.baked).toBe(1);
      expect(normals.report.after.batches, JSON.stringify(world)).toBe(0);
      expect(hint(normals.ledger)?.objects, JSON.stringify(world)).toEqual([normals.report.groups[0]!.name]);
    }
  });

  it('stays silent for batches of a plain registered standard material and of a node material with every slot empty', () => {
    const plain = (registry: MaterialRegistry): Material => registry.register(new MeshStandardMaterial({ color: 0x808080 }));
    for (const [label, material] of [['registered MeshStandardMaterial', plain], ['MeshStandardNodeMaterial without nodes', new MeshStandardNodeMaterial()]] as Array<[string, Material | typeof plain]>) {
      const { ledger, report } = compiled(material);
      expect(report.after.batches, label).toBe(1);
      expect(hint(ledger), label).toBeUndefined();
      ledger.rescan();
      expect(hint(ledger), label).toBeUndefined();
    }
  });

  it('stays silent for dynamic meshes carrying such materials, which World leaves individual (it names them once batch-sync batches them)', () => {
    for (const [label, material] of [['node slot', gradient()], ['alphaHash', hashed()], ['object-space normal map', engraved()]] as Array<[string, Material]>) {
      const separate = compiled(material, { dynamic: true });
      expect(separate.report.after, label).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 0 }));
      expect(separate.ledger.frame().byReason.dynamic?.submissions, label).toBe(4);
      expect(hint(separate.ledger), label).toBeUndefined();
      const synced = compiled(material, { dynamic: true, world: { dynamics: 'batch-sync' } });
      expect(synced.report.after.batches, label).toBe(1);
      expect(hint(synced.ledger)?.objects, label).toEqual([synced.report.groups[0]!.name]);
    }
  });

  it('names only what three renders and what World compiled: no hint for a hidden batch, after decompile(), or for an app-built BatchedMesh', () => {
    const { ledger, world, scene, renderer, camera } = compiled(gradient());
    expect(hint(ledger)).toBeDefined();
    world.batchedMeshes[0]!.visible = false;
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    world.batchedMeshes[0]!.visible = true;
    ledger.rescan();
    expect(hint(ledger)).toBeDefined();
    world.decompile();
    renderer.render(scene, camera);
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    // An app's own BatchedMesh is not threeforge's to explain.
    scene.add(tag.static(batchedOf(2, gradient(), box)));
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
  });
});
