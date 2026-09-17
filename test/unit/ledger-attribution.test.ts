import {
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  type InstancedBufferGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SkinnedMesh,
  Sprite,
  SpriteMaterial,
  VSMShadowMap,
} from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { AnimatedInstances } from '../../src/skinning/AnimatedInstances.js';
import { bakeAnimationTexture } from '../../src/skinning/bakeAnimationTexture.js';
import { tag } from '../../src/tags.js';
import { batchedOf } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';
import { box, casting } from './helpers/ledgerFixtures.js';
import { buildRig } from './helpers/rig.js';

describe('DrawCallLedger attribution', () => {
  it('records one submission per render item and separates renderer-internal work from the scene', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(new Mesh(box, new MeshStandardMaterial()), new Mesh(box, new MeshStandardMaterial()));
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.totals.submissions).toBe(3);
    expect(frame.totals.sceneSubmissions).toBe(2);
    expect(frame.byReason['renderer-internal']?.submissions).toBe(1);
    expect(frame.items?.find((i) => i.reason === 'renderer-internal')?.name).toBe('Output Color Transform');
  });

  it('gives every submission a primary reason', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
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
    const { renderer, ledger, scene, camera } = attachedLedger();
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
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mirrored = tag.static(new Mesh(box, new MeshStandardMaterial()));
    mirrored.name = 'mirrored';
    ledger.annotate(mirrored, 'excluded:mirrored');
    scene.add(mirrored);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items?.[0]?.reason).toBe('excluded:mirrored');
  });

  it('flags shadow casters, double-sided transparency, custom hooks, renderOrder and layers', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ transparent: true, side: DoubleSide })));
    mesh.castShadow = true;
    mesh.renderOrder = 5;
    mesh.layers.set(3);
    mesh.onBeforeRender = () => {};
    scene.add(mesh);
    camera.layers.enable(3); // the renderer skips objects the camera cannot see
    renderer.render(scene, camera);
    const item = ledger.frame({ items: true }).items?.[0];
    expect(item?.flags).toEqual(
      expect.arrayContaining(['shadow-caster', 'double-sided-transparent', 'custom-hook', 'render-order', 'layers']),
    );
  });
});

describe('DrawCallLedger reconciliation with renderer.info', () => {
  it('expects one GPU draw per BatchedMesh on WebGL with multi-draw', () => {
    const { renderer, ledger, scene, camera } = attachedLedger({ webgpu: false, multiDraw: true });
    scene.add(batchedOf(5, new MeshStandardMaterial(), box));
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(frame.env).toMatchObject({ backend: 'webgl2', multiDraw: true });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 2, reportedDrawCalls: 2, unattributed: 0 });
  });

  it('expects N GPU draws per BatchedMesh on WebGPU and on WebGL without multi-draw', () => {
    for (const options of [{ webgpu: true }, { webgpu: false, multiDraw: false }]) {
      const { renderer, ledger, scene, camera } = attachedLedger(options);
      scene.add(batchedOf(5, new MeshStandardMaterial(), box));
      renderer.render(scene, camera);
      const frame = ledger.frame();
      expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 6, reportedDrawCalls: 6, unattributed: 0 });
    }
  });

  it('expects no GPU draw for an InstancedMesh whose count is zero (the renderer skips it)', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const instanced = new InstancedMesh(box, new MeshStandardMaterial(), 8);
    instanced.count = 0;
    instanced.name = 'empty-instanced';
    scene.add(instanced);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.items?.find((i) => i.name === 'empty-instanced')).toMatchObject({
      expectedGpuDraws: 0,
      instancesDrawn: 0,
    });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, gpuDraws: 1, reportedDrawCalls: 1, unattributed: 0 });
  });

  it('files an InstancedMesh whose userData is null on the per-submission path', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const instanced = new InstancedMesh(box, new MeshStandardMaterial(), 4);
    instanced.count = 3;
    instanced.name = 'debris';
    scene.add(instanced);
    // The first frame also rescans the whole scene, which reads userData itself; the next periodic rescan is
    // RESCAN_EVERY frames away, so the second frame below reaches the per-submission read alone.
    renderer.render(scene, camera);
    // App code and non-three loaders assign null, and Object3D.copy propagates it to every clone; three draws it fine.
    (instanced as { userData: unknown }).userData = null;
    renderer.render(scene, camera);

    const frame = ledger.frame({ items: true });
    // No `forge.instances` total to read, so the submitted count stands in for it, as it does for an untouched mesh.
    expect(frame.items?.find((i) => i.name === 'debris')).toMatchObject({
      reason: 'instanced',
      instances: 3,
      instancesDrawn: 3,
    });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 1, unattributed: 0 });
  });

  /**
   * three r186 `RenderObject.getDrawParameters()` returns null, and the backend draws nothing, whenever
   * `count < 0 || count === Infinity` (RenderObject.js:671), not only when the instance count is zero:
   * `count = min(lastVertex, itemCount) - max(firstVertex, 0)`, with `itemCount = Infinity` when the geometry has
   * neither an index nor a `position` attribute (:653-663). Predicting a draw for any of these drives
   * `totals.unattributed` negative. The FakeRenderer follows three's rule (`helpers/fakeRendererRules.ts`), so these
   * scenes are a parity check.
   */
  it('expects no GPU draw for the drawRanges under which three draws nothing', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    // (a) A geometry whose vertices come from somewhere else (storage buffers) and whose author forgot setDrawRange:
    // itemCount is Infinity, drawRange.count is Infinity, so count is Infinity and three draws nothing.
    const headless = new BufferGeometry();
    headless.setAttribute('shade', new Float32BufferAttribute([0.1, 0.2, 0.3], 1));
    const ghost = new Mesh(headless, new MeshStandardMaterial());
    ghost.name = 'ghost';
    // The same geometry with a finite drawRange does draw: the null is the infinite range, not the missing position.
    const ranged = new BufferGeometry();
    ranged.setAttribute('shade', new Float32BufferAttribute([0.1, 0.2, 0.3], 1));
    ranged.setDrawRange(0, 3);
    const spectre = new Mesh(ranged, new MeshStandardMaterial());
    spectre.name = 'spectre';
    // (b) The golden scene's panel pattern, two groups over 36 vertices, with a drawRange over the first group only:
    // group 1 gets firstVertex 18 and lastVertex 10, so count is -8.
    const panel = new BufferGeometry();
    panel.setAttribute(
      'position',
      new Float32BufferAttribute(
        new Float32Array(36 * 3).map((_, i) => (i % 7) * 0.1),
        3,
      ),
    );
    panel.addGroup(0, 18, 0);
    panel.addGroup(18, 18, 1);
    panel.setDrawRange(0, 10);
    const split = new Mesh(panel, [
      new MeshStandardMaterial({ name: 'front' }),
      new MeshStandardMaterial({ name: 'back' }),
    ]);
    split.name = 'panel';
    // (c) A drawRange that starts past the last vertex: firstVertex 100, lastVertex clamped to 36.
    const beyond = new BufferGeometry();
    beyond.setAttribute('position', new Float32BufferAttribute(new Float32Array(36 * 3), 3));
    beyond.setDrawRange(100, 10);
    const gone = new Mesh(beyond, new MeshStandardMaterial());
    gone.name = 'gone';
    scene.add(ghost, spectre, split, gone);
    renderer.render(scene, camera);

    const frame = ledger.frame({ items: true });
    const draws = (name: string): number[] =>
      frame.items!.filter((i) => i.name === name).map((i) => i.expectedGpuDraws);
    expect(draws('ghost'), 'no index, no position, infinite drawRange').toEqual([0]);
    expect(draws('spectre'), 'no position but a finite drawRange: three draws it').toEqual([1]);
    expect(draws('panel'), 'the second group lies outside the drawRange').toEqual([1, 0]);
    expect(draws('gone'), 'the drawRange starts past the last vertex').toEqual([0]);
    // An instance nothing drew is not a drawn instance: `instancesDrawn` follows the same rule; `instances` (what the
    // submission covers) is unchanged.
    const drawn = (name: string): number[] => frame.items!.filter((i) => i.name === name).map((i) => i.instancesDrawn);
    expect(drawn('ghost')).toEqual([0]);
    expect(drawn('spectre'), 'a finite drawRange draws, so its instance is drawn').toEqual([1]);
    expect(drawn('panel')).toEqual([1, 0]);
    expect(drawn('gone')).toEqual([0]);
    expect(
      frame.items!.filter((i) => i.name === 'ghost').map((i) => i.instances),
      'the submission still covers its mesh',
    ).toEqual([1]);
    // The parity assertion: predicting a draw three never makes takes this below zero.
    expect(frame.totals.unattributed).toBe(0);
    expect(frame.totals.gpuDraws).toBe(frame.totals.reportedDrawCalls);
  });

  it('expects two GPU draws for double-sided transparent materials', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial({ transparent: true, side: DoubleSide }))));
    renderer.render(scene, camera);
    expect(ledger.frame().totals).toMatchObject({
      sceneSubmissions: 1,
      gpuDraws: 3,
      reportedDrawCalls: 3,
      unattributed: 0,
    });
  });

  it('reports a non-zero unattributed count when the renderer draws more than expected', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    // A backend quirk the ledger does not model: an extra draw per object, counted before the frame closes.
    const original = renderer.renderObject.bind(renderer);
    (renderer as { renderObject: typeof renderer.renderObject }).renderObject = (...args) => {
      original(...args);
      renderer.info.render.drawCalls += 1;
    };
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    renderer.render(scene, camera);
    expect(ledger.frame().totals.unattributed).toBe(2);
  });

  it('expects no GPU draw for a sprite or VAT batch with instanceCount 0', () => {
    const { renderer, registry, ledger, scene, camera } = attachedLedger();
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
    expect(ledger.frame({ items: true }).items?.find((i) => i.reason === 'sprite-batch')).toMatchObject({
      instancesDrawn: 6,
      expectedGpuDraws: 1,
    });
    // Turned away from the rain: the batch's hook writes instanceCount 0 inside renderObject, and three draws nothing.
    camera.lookAt(0, 0, 100);
    camera.updateMatrixWorld();
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect((world.spriteBatches[0]!.geometry as InstancedBufferGeometry).instanceCount).toBe(0);
    expect(frame.items?.find((i) => i.reason === 'sprite-batch')).toMatchObject({
      instances: 0,
      instancesDrawn: 0,
      expectedGpuDraws: 0,
    });
    expect(frame.items?.find((i) => i.reason === 'vat-instanced')).toMatchObject({
      instances: 0,
      instancesDrawn: 0,
      expectedGpuDraws: 0,
    });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 2, unattributed: 0 });
  });

  it('predicts each shadow pass with the material and side three draws, under PCF and VSM', () => {
    // Three draws a shadow pass with shadowSide, else the material's side, and the material's own when allowOverride
    // is false; double-sided transparency is flagged per pass.
    for (const vsm of [false, true]) {
      const light = casting(new DirectionalLight(), 'sun');
      const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: light });
      if (vsm) renderer.shadowMap.type = VSMShadowMap;
      const materials: Record<string, Material> = {
        'double-sided': new MeshStandardMaterial({ transparent: true, side: DoubleSide }),
        'shadow-side-double': Object.assign(new MeshStandardMaterial({ transparent: true, side: FrontSide }), {
          shadowSide: DoubleSide,
        }),
        'shadow-side-front': Object.assign(new MeshStandardMaterial({ transparent: true, side: DoubleSide }), {
          shadowSide: FrontSide,
        }),
        'no-override': Object.assign(new MeshStandardMaterial({ transparent: true, side: DoubleSide }), {
          allowOverride: false,
        }),
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
      const seen = Object.fromEntries(
        frame
          .items!.filter((i) => i.reason !== 'renderer-internal')
          .map((i) => [`${i.pass} ${i.name}`, [i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]]),
      );
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

  it('predicts a scene override with its own side and the source transparency', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.overrideMaterial = new MeshBasicMaterial({ side: DoubleSide });
    const materials: Record<string, Material> = {
      opaque: new MeshStandardMaterial({ side: FrontSide }),
      transparent: new MeshStandardMaterial({ transparent: true, side: FrontSide }),
      'no-override': Object.assign(new MeshStandardMaterial({ transparent: true, side: FrontSide }), {
        allowOverride: false,
      }),
    };
    for (const [name, material] of Object.entries(materials)) {
      const mesh = tag.static(new Mesh(box, material));
      mesh.name = name;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    // renderer-internal items are left out: three draws the output quad on this canvas render too, the fake does not.
    const seen = Object.fromEntries(
      frame
        .items!.filter((i) => i.reason !== 'renderer-internal')
        .map((i) => [`${i.pass} ${i.name}`, [i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]]),
    );
    expect(seen).toEqual({
      'override opaque': [1, false],
      'override transparent': [2, true],
      'override no-override': [1, false],
    });
    expect(frame.totals).toMatchObject({ sceneSubmissions: 3, unattributed: 0 });
  });

  it('predicts double-sided transmission as a back then a front submission per pass', () => {
    const light = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: light });
    const glass = tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide })));
    glass.name = 'glass';
    const clear = tag.static(
      new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, transparent: true, side: DoubleSide })),
    );
    clear.name = 'clear-glass';
    glass.castShadow = true;
    clear.castShadow = true;
    scene.add(light, glass, clear);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    const items = frame
      .items!.filter((i) => i.reason !== 'renderer-internal')
      .map((i) => [i.pass, i.name, i.expectedGpuDraws, i.flags.includes('double-sided-transparent')]);
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
