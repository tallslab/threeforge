import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  Bone,
  BoxGeometry,
  BufferGeometry,
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
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  Vector2,
  VSMShadowMap,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type CoordinateSystem,
  type Material,
} from 'three';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
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
    const seen = Object.fromEntries(frame.items!.map((i) => [`${i.pass} ${i.name}`, [i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]]));
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
