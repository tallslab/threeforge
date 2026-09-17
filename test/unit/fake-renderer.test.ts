import {
  BackSide,
  BatchedMesh,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferGeometry,
  InstancedMesh,
  type Light,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Vector2,
  VSMShadowMap,
} from 'three';
import { describe, expect, it } from 'vitest';
import { type FakePass, FakeRenderer, type FakeRendererOptions, sceneWithCamera } from './helpers/fakeRenderer.js';

/**
 * The fake against three r186's own behaviour (node_modules/three/src), not against the ledger: Renderer._renderScene,
 * Renderer.renderObject, RenderObject.getDrawParameters, the backends' Info.update, ShadowNode and PointShadowNode.
 */

/** 12 triangles. */
const box = new BoxGeometry(1, 1, 1);

function sun(name = 'sun'): DirectionalLight {
  const light = new DirectionalLight();
  light.name = name;
  light.castShadow = true;
  return light;
}

function named<T extends Object3D>(object: T, name: string): T {
  object.name = name;
  return object;
}

const cube = (name: string, material: Material = new MeshStandardMaterial()) => named(new Mesh(box, material), name);
const shadowPasses = (renderer: FakeRenderer): FakePass[] => renderer.passes.filter((p) => p.kind === 'shadow');

describe('FakeRenderer sceneHooks', () => {
  it('calls scene.onBeforeRender at the start of every render only with sceneHooks on', () => {
    const { scene, camera } = sceneWithCamera();
    const calls: unknown[][] = [];
    const afterTargets: unknown[] = [];
    scene.onBeforeRender = (...args) => void calls.push(args);
    scene.onAfterRender = (...args) => void afterTargets.push(args[3]);
    new FakeRenderer().render(scene, camera);
    expect(calls).toHaveLength(0);
    const renderer = new FakeRenderer({ sceneHooks: true });
    renderer.render(scene, camera);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(renderer);
    expect(calls[0]![1]).toBe(scene);
    expect(calls[0]![2]).toBe(camera);
    // A canvas render draws into the renderer's frame-buffer target (Renderer._getFrameBufferTarget); both hooks get it.
    expect(calls[0]![3]).toMatchObject({ isPostProcessingRenderTarget: true });
    expect(calls[0]![3]).toBe(renderer.frameBufferTarget);
    expect(afterTargets.at(-1)).toBe(renderer.frameBufferTarget);
    // A render into an explicit target passes that target instead.
    const target = { name: 'reflection' };
    renderer.renderTarget = target;
    renderer.render(scene, camera);
    expect(calls[1]![3]).toBe(target);
    expect(afterTargets.at(-1)).toBe(target);
  });
});

describe('FakeRenderer output quad', () => {
  /** The names drawn by the outermost render() call. */
  const drawn = (renderer: FakeRenderer): string[] => renderer.passes[0]!.draws.map((d) => d.object.name);

  it('draws the output quad for every render to the output target, none into a target', () => {
    // Renderer._renderScene takes the frame-buffer target (and so calls _renderOutput) when _getFrameBufferTarget()
    // returns one: `needsFrameBufferTarget` (Renderer.js:1563, :2609) is tone mapping or colour space against the
    // working space, and both are read through `isOutputTarget` (:2686), which is `_renderTarget === null` here. So the
    // quad follows the render's target alone — not the root's type, and not the scene's override material.
    const quad = 'Output Color Transform';

    // A Scene rendered to the canvas: one quad, as before.
    const canvas = new FakeRenderer({ record: true });
    const { scene, camera } = sceneWithCamera();
    scene.add(cube('m'));
    canvas.render(scene, camera);
    expect(drawn(canvas), 'Scene to the canvas').toEqual(['m', quad]);

    // The same Scene into an explicit render target (a reflection, an overdraw count target): three converts colour
    // space only when writing the output target, so a nested render-target render draws no quad.
    const nested = new FakeRenderer({ record: true });
    nested.renderTarget = { name: 'reflection' };
    nested.render(scene, camera);
    expect(drawn(nested), 'Scene into a render target').toEqual(['m']);

    // A Group rendered to the canvas still writes the output target, so it draws one.
    const groupRenderer = new FakeRenderer({ record: true });
    const group = new Group();
    group.add(cube('in-group'));
    group.updateMatrixWorld(true);
    groupRenderer.render(group, camera);
    expect(drawn(groupRenderer), 'Group to the canvas').toEqual(['in-group', quad]);

    // An override material does not gate the quad either; and the quad itself is never drawn with that override,
    // because three renders it as its own root against its internal scene (Renderer._renderOutputLayers).
    const overridden = new FakeRenderer({ record: true });
    const override = new MeshBasicMaterial();
    scene.overrideMaterial = override;
    overridden.render(scene, camera);
    scene.overrideMaterial = null;
    expect(drawn(overridden), 'Scene with an override to the canvas').toEqual(['m', quad]);
    const quadDraw = overridden.passes[0]!.draws.find((d) => d.object.name === quad)!;
    expect(quadDraw.material, 'the output quad is not drawn with the scene override').toBe(
      overridden.outputQuad.material,
    );
  });
});

describe("FakeRenderer shadowTrigger: 'first-receiver'", () => {
  it("renders the shadow map inside the first receiver's renderObject, after its onBeforeRender and before its draw", () => {
    const light = sun();
    const log: string[] = [];
    const run = (options: FakeRendererOptions) => {
      log.length = 0;
      const renderer = new FakeRenderer({ shadowLights: [light], ...options });
      const { scene, camera } = sceneWithCamera();
      const a = cube('a');
      const b = cube('b');
      b.receiveShadow = true;
      const c = cube('c');
      c.castShadow = true;
      for (const o of [a, b, c]) {
        o.onBeforeRender = (_r, _s, cam) => void log.push(`${o.name}:before:${cam === camera ? 'main' : 'shadow'}`);
        o.onAfterRender = (_r, _s, cam) =>
          void log.push(`${o.name}:after:${cam === camera ? 'main' : 'shadow'}:${renderer.info.render.drawCalls}`);
      }
      scene.add(light, a, b, c);
      renderer.render(scene, camera);
      return [...log];
    };
    expect(run({ shadowTrigger: 'first-receiver' })).toEqual([
      'a:before:main',
      'a:after:main:1',
      'b:before:main',
      'c:before:shadow',
      'c:after:shadow:2',
      'b:after:main:3',
      'c:before:main',
      'c:after:main:4',
    ]);
    // Unset, the map renders before the render list (the fake's previous model).
    expect(run({})).toEqual([
      'c:before:shadow',
      'c:after:shadow:1',
      'a:before:main',
      'a:after:main:2',
      'b:before:main',
      'b:after:main:3',
      'c:before:main',
      'c:after:main:4',
    ]);
  });
});

describe('FakeRenderer record', () => {
  it('records every render() call of the last frame as a pass with its draws', () => {
    const light = sun();
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster');
    caster.castShadow = true;
    scene.add(light, caster, cube('plain'));
    const quiet = new FakeRenderer({ shadowLights: [light] });
    quiet.render(scene, camera);
    expect(quiet.passes).toEqual([]);

    const renderer = new FakeRenderer({ shadowLights: [light], record: true });
    renderer.render(scene, camera);
    expect(renderer.passes).toHaveLength(2);
    const [main, shadow] = renderer.passes as [FakePass, FakePass];
    expect(main).toMatchObject({ kind: 'render', depth: 0, frameId: 1, light: null, face: null, renderTarget: null });
    expect(main.scene).toBe(scene);
    expect(main.camera).toBe(camera);
    expect(main.draws.map((d) => d.object.name)).toEqual(['caster', 'plain', 'Output Color Transform']);
    expect(shadow).toMatchObject({ kind: 'shadow', depth: 1, frameId: 1, face: null });
    expect(shadow.light).toBe(light);
    expect(shadow.camera).toBe(light.shadow.camera);
    expect(shadow.projectionMatrix.equals(light.shadow.camera.projectionMatrix)).toBe(true);
    expect(shadow.draws).toHaveLength(1);
    expect(shadow.draws[0]).toMatchObject({
      side: BackSide,
      drawCalls: 1,
      triangles: 12,
      instanceCount: 1,
      batchIds: null,
    });
    expect(shadow.draws[0]!.object).toBe(caster);
    expect((shadow.draws[0]!.material as Material & { isShadowPassMaterial?: boolean }).isShadowPassMaterial).toBe(
      true,
    );

    renderer.render(scene, camera);
    expect(renderer.passes.map((p) => [p.kind, p.frameId])).toEqual([
      ['render', 2],
      ['shadow', 2],
    ]);
  });

  it('resolves batch ids against the index texture as each backend uploads it', () => {
    // WebGL uploads it at draw time, WebGPU at the end of the render() call.
    for (const webgpu of [false, true]) {
      const light = sun();
      light.position.set(100, 10, 0);
      light.target.position.set(100, 0, 0);
      const renderer = new FakeRenderer({
        webgpu,
        shadowLights: [light],
        shadowTrigger: 'first-receiver',
        record: true,
      });
      const { scene, camera } = sceneWithCamera();
      const batch = named(
        new BatchedMesh(2, box.attributes.position!.count * 2, box.index!.count * 2, new MeshStandardMaterial()),
        'batch',
      );
      const geometryId = batch.addGeometry(box);
      batch.setMatrixAt(batch.addInstance(geometryId), new Matrix4()); // instance 0: only the main camera sees it
      batch.setMatrixAt(batch.addInstance(geometryId), new Matrix4().makeTranslation(100, 0, 0)); // instance 1: only the sun sees it
      batch.castShadow = true;
      const receiver = cube('receiver');
      receiver.receiveShadow = true;
      scene.add(light, light.target, batch, receiver);
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      const ids = (kind: FakePass['kind']) =>
        renderer.passes
          .find((p) => p.kind === kind)!
          .draws.filter((d) => d.object === batch)
          .map((d) => d.batchIds);
      expect(ids('shadow')).toEqual([[1]]);
      // The receiver's shadow render re-culls the batch after the main pass recorded its draw. WebGL has drawn already;
      // WebGPU submits the main pass after the shadow pass rewrote the shared index texture.
      expect(ids('render')).toEqual(webgpu ? [[1]] : [[0]]);
    }
  });
});

describe('FakeRenderer shadowLights (ShadowNode.updateBefore)', () => {
  it('renders one map per shadow light only while shadowMap.enabled and castShadow', () => {
    const a = sun('a');
    const b = sun('b');
    const renderer = new FakeRenderer({ shadowLights: [a, b], record: true });
    expect(renderer.shadowMap.enabled).toBe(true);
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster');
    caster.castShadow = true;
    scene.add(a, b, caster);
    renderer.render(scene, camera);
    expect(shadowPasses(renderer).map((p) => p.light?.name)).toEqual(['a', 'b']);
    b.castShadow = false;
    renderer.render(scene, camera);
    expect(shadowPasses(renderer).map((p) => p.light?.name)).toEqual(['a']);
    renderer.shadowMap.enabled = false;
    renderer.render(scene, camera);
    expect(renderer.passes.map((p) => p.kind)).toEqual(['render']);
    expect(new FakeRenderer().shadowMap.enabled).toBe(false);
  });

  it('builds light.shadow.map on first render, none while shadow maps are disabled', () => {
    // A colour target with a depth texture, as ShadowNode.setupShadow sets it.
    const a = sun('a');
    const renderer = new FakeRenderer({ shadowLights: [a] });
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster');
    caster.castShadow = true;
    scene.add(a, caster);
    renderer.shadowMap.enabled = false;
    renderer.render(scene, camera);
    expect(a.shadow.map).toBeNull();
    renderer.shadowMap.enabled = true;
    renderer.render(scene, camera);
    const map = a.shadow.map as unknown as { textures: unknown[]; depthTexture: unknown } | null;
    expect(map?.textures).toHaveLength(1);
    expect(map?.depthTexture).toBeTruthy();
    renderer.render(scene, camera);
    expect(a.shadow.map).toBe(map);
  });

  it('renders a map only when shadow.autoUpdate or shadow.needsUpdate, and clears needsUpdate', () => {
    const light = sun();
    light.shadow.autoUpdate = false;
    const renderer = new FakeRenderer({ shadowLights: [light], record: true });
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster');
    caster.castShadow = true;
    scene.add(light, caster);
    renderer.render(scene, camera);
    expect(shadowPasses(renderer)).toHaveLength(0);
    light.shadow.needsUpdate = true;
    renderer.render(scene, camera);
    expect(shadowPasses(renderer)).toHaveLength(1);
    expect(light.shadow.needsUpdate).toBe(false);
    renderer.render(scene, camera);
    expect(shadowPasses(renderer)).toHaveLength(0);
  });

  it('renders a map once per camera per frame, again for a nested render with another camera', () => {
    const light = sun();
    const renderer = new FakeRenderer({ shadowLights: [light], shadowTrigger: 'first-receiver', record: true });
    const { scene, camera } = sceneWithCamera();
    const mirror = camera.clone();
    const first = cube('first');
    const second = cube('second');
    first.receiveShadow = second.receiveShadow = true;
    let reflected = false;
    first.onBeforeRender = (_r, _s, cam) => {
      if (cam !== camera || reflected) return;
      reflected = true;
      renderer.render(scene, mirror); // like a reflector: a nested render of the same scene from another camera
    };
    scene.add(light, first, second);
    renderer.render(scene, camera);
    expect(renderer.passes.map((p) => [p.kind, p.depth])).toEqual([
      ['render', 0],
      ['render', 1],
      ['shadow', 2],
      ['shadow', 1],
    ]);
    reflected = true;
    renderer.render(scene, camera);
    expect(renderer.passes.map((p) => p.kind)).toEqual(['render', 'shadow']);
  });

  it('renders six faces for a point light, re-aiming the same shadow camera per face', () => {
    const lamp = named(new PointLight(), 'lamp');
    lamp.castShadow = true;
    lamp.position.set(0, 5, 0);
    const renderer = new FakeRenderer({ shadowLights: [lamp], record: true });
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster');
    caster.castShadow = true;
    scene.add(lamp, caster);
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    const faces = shadowPasses(renderer);
    expect(faces.map((p) => p.face)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faces.every((p) => p.camera === lamp.shadow.camera && p.light === lamp)).toBe(true);
    expect(new Set(faces.map((p) => p.matrixWorldInverse.elements.join())).size).toBe(6);
    expect(faces.every((p) => p.draws.length === 1)).toBe(true);
  });
});

describe('FakeRenderer override material (Renderer.renderObject)', () => {
  function shadowDraws(material: Material, setup: (renderer: FakeRenderer) => void = () => {}) {
    const light = sun();
    const renderer = new FakeRenderer({ shadowLights: [light], record: true });
    setup(renderer);
    const { scene, camera } = sceneWithCamera();
    const caster = cube('caster', material);
    caster.castShadow = true;
    scene.add(light, caster);
    renderer.render(scene, camera);
    return { renderer, draws: shadowPasses(renderer)[0]!.draws };
  }

  it('resolves shadowSide ?? the flipped side, and keeps the source side under VSM', () => {
    const sides = (material: Material, setup?: (renderer: FakeRenderer) => void) =>
      shadowDraws(material, setup).draws.map((d) => d.side);
    expect(sides(new MeshStandardMaterial({ side: FrontSide }))).toEqual([BackSide]);
    expect(sides(new MeshStandardMaterial({ side: BackSide }))).toEqual([FrontSide]);
    expect(sides(new MeshStandardMaterial({ side: DoubleSide }))).toEqual([DoubleSide]);
    const explicit = new MeshStandardMaterial({ side: FrontSide });
    explicit.shadowSide = DoubleSide;
    expect(sides(explicit)).toEqual([DoubleSide]);
    expect(sides(new MeshStandardMaterial({ side: FrontSide }), (r) => (r.shadowMap.type = VSMShadowMap))).toEqual([
      FrontSide,
    ]);
  });

  it('copies transparent onto the override, draws double-sided twice, restores its side', () => {
    const material = new MeshStandardMaterial({ transparent: true, side: DoubleSide });
    const { renderer, draws } = shadowDraws(material);
    expect(draws.map((d) => [d.side, d.drawCalls])).toEqual([
      [BackSide, 1],
      [FrontSide, 1],
    ]);
    const override = draws[0]!.material;
    expect(override.transparent).toBe(true); // three copies it and never restores it
    expect(override.side).toBe(FrontSide); // restored after the call
    expect(material.side).toBe(DoubleSide);
    const main = renderer.passes[0]!.draws.filter((d) => d.object.name === 'caster');
    expect(main.map((d) => d.side)).toEqual([BackSide, FrontSide]);
    expect(renderer.info.render.drawCalls).toBe(2 + 2 + 1); // shadow, main, output quad

    const single = shadowDraws(
      new MeshStandardMaterial({ transparent: true, side: DoubleSide, forceSinglePass: true }),
    );
    expect(single.renderer.passes[0]!.draws.filter((d) => d.object.name === 'caster').map((d) => d.side)).toEqual([
      DoubleSide,
    ]);
    // renderObject reads forceSinglePass from the override material, which three never copies it onto: two shadow draws.
    expect(single.draws.map((d) => d.side)).toEqual([BackSide, FrontSide]);
  });
});

describe('FakeRenderer render list (Renderer._renderScene, _renderTransparents)', () => {
  it('passes a lights node as argument 7 whose getLights() lists the lights the camera projected', () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const key = new DirectionalLight();
    const hidden = new DirectionalLight();
    hidden.visible = false;
    const otherLayer = new DirectionalLight();
    otherLayer.layers.set(2);
    scene.add(key, hidden, otherLayer, cube('m'));
    const seen: Light[][] = [];
    const renderObject = renderer.renderObject.bind(renderer);
    renderer.renderObject = (...args: Parameters<FakeRenderer['renderObject']>) => {
      if (args[0].name === 'm') seen.push([...(args[6] as { getLights(): Light[] }).getLights()]);
      renderObject(...args);
    };
    renderer.render(scene, camera);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]![0]).toBe(key);
  });

  it('projects nothing under a hidden object, but the children of a layer-excluded one', () => {
    // As Renderer._projectObject does.
    const renderer = new FakeRenderer({ record: true });
    const { scene, camera } = sceneWithCamera();
    const key = new DirectionalLight();
    const hidden = named(new Group(), 'hidden');
    hidden.visible = false;
    hidden.add(cube('under-hidden'), new DirectionalLight());
    const otherLayer = cube('other-layer');
    otherLayer.layers.set(2);
    otherLayer.add(cube('child-of-other-layer'));
    scene.add(key, hidden, otherLayer, cube('m'));
    const seen: Light[][] = [];
    const renderObject = renderer.renderObject.bind(renderer);
    renderer.renderObject = (...args: Parameters<FakeRenderer['renderObject']>) => {
      if (args[0].name === 'm') seen.push([...(args[6] as { getLights(): Light[] }).getLights()]);
      renderObject(...args);
    };
    renderer.render(scene, camera);
    expect(renderer.passes[0]!.draws.map((d) => d.object.name)).toEqual([
      'child-of-other-layer',
      'm',
      'Output Color Transform',
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([key]);
  });

  it('renders opaque, then the transmissive back-side pass, then the transparent list', () => {
    const renderer = new FakeRenderer({ record: true });
    const { scene, camera } = sceneWithCamera();
    const glass = cube('glass', new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }));
    const veil = cube('veil', new MeshStandardMaterial({ transparent: true }));
    const wall = cube('wall');
    const sides: string[] = [];
    for (const o of [glass, veil, wall])
      o.onBeforeRender = (_r, _s, _c, _g, material) => void sides.push(`${o.name}:${material.side}`);
    scene.add(glass, veil, wall);
    renderer.render(scene, camera);
    expect(sides).toEqual([`wall:${FrontSide}`, `glass:${BackSide}`, `glass:${FrontSide}`, `veil:${FrontSide}`]);
    expect(renderer.passes[0]!.draws.map((d) => [d.object.name, d.side, d.drawCalls])).toEqual([
      ['wall', FrontSide, 1],
      ['glass', BackSide, 1],
      ['glass', FrontSide, 1],
      ['veil', FrontSide, 1],
      ['Output Color Transform', FrontSide, 1],
    ]);
    expect(glass.material.side).toBe(DoubleSide);
  });

  it('renders two VSM blur quads after each non-point shadow map under vsmQuad and VSM', () => {
    const run = (options: FakeRendererOptions, vsm: boolean) => {
      const light = sun();
      const lamp = named(new PointLight(), 'lamp');
      lamp.castShadow = true;
      const renderer = new FakeRenderer({ shadowLights: [light, lamp], record: true, ...options });
      if (vsm) renderer.shadowMap.type = VSMShadowMap;
      const { scene, camera } = sceneWithCamera();
      const receiver = cube('receiver');
      receiver.receiveShadow = true;
      scene.add(light, lamp, receiver);
      renderer.render(scene, camera);
      return renderer.passes;
    };
    const passes = run({ vsmQuad: true }, true);
    expect(
      passes.map((p) => [p.kind, p.light?.name ?? null, p.draws.map((d) => d.object.name || d.material.name)]),
    ).toEqual([
      ['render', null, ['receiver', 'Output Color Transform']],
      ['shadow', 'sun', ['receiver']], // VSM also renders receivers into the map
      ['vsm', 'sun', ['VSMVertical']],
      ['vsm', 'sun', ['VSMHorizontal']],
      ...Array.from({ length: 6 }, () => ['shadow', 'lamp', ['receiver']]),
    ]);
    const quad = passes[2]!;
    expect((quad.scene as Object3D & { isQuadMesh?: boolean }).isQuadMesh).toBe(true);
    expect(quad.draws[0]).toMatchObject({ drawCalls: 1, triangles: 1 });
    expect(run({}, true).some((p) => p.kind === 'vsm')).toBe(false);
    expect(run({ vsmQuad: true }, false).some((p) => p.kind === 'vsm')).toBe(false);
  });
});

describe('FakeRenderer draw rules (RenderObject.getDrawParameters, Info.update)', () => {
  it('draws nothing at instanceCount 0 but still runs the object hooks', () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const plane = new PlaneGeometry(1, 1);
    const quads = new InstancedBufferGeometry();
    quads.setIndex(plane.getIndex());
    quads.setAttribute('position', plane.getAttribute('position'));
    quads.instanceCount = 0;
    const sprites = named(new Mesh(quads, new MeshStandardMaterial()), 'sprites');
    let after = 0;
    sprites.onAfterRender = () => void after++;
    scene.add(sprites);
    renderer.render(scene, camera);
    expect(renderer.info.render.drawCalls).toBe(1); // the output quad only
    expect(after).toBe(1);
    quads.instanceCount = 40;
    renderer.render(scene, camera);
    expect(renderer.info.render.drawCalls).toBe(1 + 2);
    expect(renderer.info.render.triangles).toBe(1 + 40 * 2 + 1); // the output quad is one fullscreen triangle per render
  });

  it('counts triangles per draw: instanceCount x count / 3, per multi-draw slot for batches', () => {
    for (const [options, batchDraws] of [
      [{ webgpu: true }, 2],
      [{ webgpu: false, multiDraw: false }, 2],
      [{ webgpu: false, multiDraw: true }, 1],
    ] as const) {
      const renderer = new FakeRenderer({ ...options, record: true });
      const { scene, camera } = sceneWithCamera();
      const instanced = named(new InstancedMesh(box, new MeshStandardMaterial(), 5), 'instanced');
      instanced.count = 3;
      const batch = named(
        new BatchedMesh(2, box.attributes.position!.count * 2, box.index!.count * 2, new MeshStandardMaterial()),
        'batch',
      );
      const geometryId = batch.addGeometry(box);
      batch.addInstance(geometryId);
      batch.setMatrixAt(batch.addInstance(geometryId), new Matrix4().makeTranslation(1, 0, 0));
      scene.add(cube('box'), instanced, batch);
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      const rows = Object.fromEntries(
        renderer.passes[0]!.draws.map((d) => [d.object.name, [d.drawCalls, d.triangles, d.instanceCount]]),
      );
      expect(rows).toEqual({
        box: [1, 12, 1],
        instanced: [1, 36, 3],
        batch: [batchDraws, 24, 1],
        'Output Color Transform': [1, 1, 1],
      });
      expect(renderer.info.render.triangles).toBe(12 + 36 + 24 + 1);
      // Renderer._renderOutput draws a QuadMesh: the shared 3-vertex QuadGeometry, one triangle.
      expect((renderer.outputQuad as Mesh & { isQuadMesh?: boolean }).isQuadMesh).toBe(true);
      expect(renderer.outputQuad.geometry.attributes.position!.count).toBe(3);
      expect(renderer.info.render.drawCalls).toBe(1 + 1 + batchDraws + 1);
    }
  });

  it('renderAsync awaits init() and then calls this.render', async () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const calls: string[] = [];
    const init = renderer.init.bind(renderer);
    renderer.init = async () => {
      calls.push('init');
      await Promise.resolve();
      calls.push('init resolved');
      return init();
    };
    renderer.render = (s, c) => void calls.push(`render ${s === scene && c === camera}`);
    await renderer.renderAsync(scene, camera);
    expect(calls).toEqual(['init', 'init resolved', 'render true']);
  });

  it("getDrawingBufferSize reports the drawing-buffer size, three's default 300x150 canvas unless set", () => {
    const renderer = new FakeRenderer();
    expect(renderer.getDrawingBufferSize(new Vector2()).toArray()).toEqual([300, 150]);
    renderer.drawingBufferSize.set(800, 600);
    expect(renderer.getDrawingBufferSize(new Vector2()).toArray()).toEqual([800, 600]);
  });

  it("lighting.getNode(scene) is the lights node the scene's renders pass as argument 7 (Lighting.getNode)", () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const key = new DirectionalLight();
    scene.add(key, cube('m'));
    let lights: Light[] = [];
    let node: unknown = null;
    const renderObject = renderer.renderObject.bind(renderer);
    renderer.renderObject = (...args: Parameters<FakeRenderer['renderObject']>) => {
      if (args[0].name === 'm') {
        node = args[6];
        lights = [...renderer.lighting.getNode(scene).getLights()];
      }
      renderObject(...args);
    };
    renderer.render(scene, camera);
    expect(renderer.lighting.getNode(scene)).toBe(node);
    expect(lights).toEqual([key]);
  });
});

describe('FakeRenderer instance matrices', () => {
  // Models nodes/accessors/Instance.js, NodeMaterialObserver and Geometries.
  const at = (x: number): Matrix4 => new Matrix4().makeTranslation(x, 0, 0);
  /** The x translation of every row a draw read. */
  const xs = (rows: Float32Array | null): number[] | null =>
    rows === null ? null : Array.from({ length: rows.length / 16 }, (_, k) => rows[k * 16 + 12]!);
  function instanced(n: number): InstancedMesh {
    const mesh = named(new InstancedMesh(box, new MeshStandardMaterial(), n), 'instanced');
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, at(i));
    return mesh;
  }
  const drawn = (renderer: FakeRenderer, mesh: InstancedMesh): (number[] | null)[][] =>
    renderer.passes.map((p) => p.draws.filter((d) => d.object === mesh).map((d) => xs(d.instanceRows)));

  it('reads a uniform buffer per render object, written only on a new instanceMatrix.version', () => {
    for (const webgpu of [false, true]) {
      const renderer = new FakeRenderer({ webgpu, record: true });
      const { scene, camera } = sceneWithCamera();
      const mesh = instanced(4);
      mesh.count = 2;
      scene.add(mesh);
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      expect(drawn(renderer, mesh), 'first draw').toEqual([[[0, 1]]]);
      mesh.setMatrixAt(0, at(9)); // no needsUpdate: the render object keeps its buffer
      renderer.render(scene, camera);
      expect(drawn(renderer, mesh), 'same version').toEqual([[[0, 1]]]);
      mesh.instanceMatrix.needsUpdate = true;
      renderer.render(scene, camera);
      expect(drawn(renderer, mesh), 'new version').toEqual([[[9, 1]]]);
      expect(
        renderer.passes[0]!.draws.find((d) => d.object.name === 'Output Color Transform')!.instanceRows,
      ).toBeNull();
    }
  });

  it('shares one vertex buffer above uniformBufferLimit, synced once per frame per object', () => {
    // Uploaded with its update ranges; WebGPU reads it when the render() call ends.
    for (const webgpu of [false, true]) {
      // 4 instances x 64 bytes > 64: the InstancedInterleavedBuffer path.
      const renderer = new FakeRenderer({ webgpu, record: true, uniformBufferLimit: 64 });
      const { scene, camera } = sceneWithCamera();
      const mesh = instanced(4);
      mesh.count = 2;
      const reflection = camera.clone();
      let next = 5;
      // Row 1 changes in every reflection render, before the mesh draws in it (an update range, as the interleaved sync copies).
      mesh.onBeforeRender = (_r, _s, c) => {
        if (c !== reflection) return;
        mesh.setMatrixAt(1, at(next++));
        mesh.instanceMatrix.addUpdateRange(16, 16);
        mesh.instanceMatrix.needsUpdate = true;
      };
      // Drawn after the mesh: renders the scene twice with the same camera, at the same depth (one render object).
      const mirror = cube('mirror', new MeshBasicMaterial());
      let reflecting = false;
      mirror.onBeforeRender = () => {
        if (reflecting) return;
        reflecting = true;
        renderer.render(scene, reflection);
        renderer.render(scene, reflection);
        reflecting = false;
      };
      scene.add(mesh, mirror);
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      expect(passKinds(renderer)).toEqual(['render:0', 'render:1', 'render:1']);
      // Frame 1. Reflection 1 is a new render object: its frame event syncs the version, the range uploads (row 1 = 5).
      // Reflection 2 writes 6, but its node already synced this frame: no upload, it draws 5. WebGL drew the main pass
      // before the upload; WebGPU submits it at the end of the call and reads the buffer as uploaded by then.
      expect(drawn(renderer, mesh), 'frame 1').toEqual([[webgpu ? [0, 5] : [0, 1]], [[0, 5]], [[0, 5]]]);
      renderer.render(scene, camera);
      // Frame 2. The main render object refreshes (version changed), syncs and uploads the pending range (6); reflection
      // 1 syncs 7; reflection 2 draws 7 again.
      expect(drawn(renderer, mesh), 'frame 2').toEqual([[webgpu ? [0, 7] : [0, 6]], [[0, 7]], [[0, 7]]]);
    }
  });

  it("runs an instanced receiver's frame event before the shadow render it triggers: the shadow pass's sync replaces the main pass's synced ranges before their upload, so both draws read the stale main row", () => {
    const red = (rows: Float32Array | null): number[] | null =>
      rows === null ? null : Array.from({ length: rows.length / 3 }, (_, k) => Math.round(rows[k * 3]! * 100));
    for (const webgpu of [false, true]) {
      const light = sun();
      light.position.set(0, 10, 0);
      // 4 instances x 64 bytes > 64: the matrices use the shared vertex buffer; the colours always use a shared attribute.
      const renderer = new FakeRenderer({
        webgpu,
        record: true,
        uniformBufferLimit: 64,
        shadowLights: [light],
        shadowTrigger: 'first-receiver',
      });
      const { scene, camera } = sceneWithCamera();
      const mesh = instanced(4);
      for (let i = 0; i < 4; i++) mesh.setColorAt(i, new Color(i / 100, 0, 0));
      mesh.count = 2;
      mesh.castShadow = mesh.receiveShadow = true;
      let frame = 0;
      // The main pass rewrites row 0, the shadow pass row 1, each with its own update range.
      mesh.onBeforeRender = (_r, _s, c) => {
        const row = c === camera ? 0 : 1;
        const value = (c === camera ? 10 : 20) + frame;
        mesh.setMatrixAt(row, at(value));
        mesh.setColorAt(row, new Color(value / 100, 0, 0));
        mesh.instanceMatrix.addUpdateRange(row * 16, 16);
        mesh.instanceColor!.addUpdateRange(row * 3, 3);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      };
      scene.add(light, light.target, mesh);
      scene.updateMatrixWorld();
      const drawnColors = () =>
        renderer.passes.map((p) => p.draws.filter((d) => d.object === mesh).map((d) => red(d.instanceColorRows)));
      frame = 1;
      renderer.render(scene, camera);
      expect(passKinds(renderer)).toEqual(['render:0', 'shadow:1']);
      // Frame 1 creates both buffers with the whole arrays.
      expect(drawn(renderer, mesh), 'frame 1').toEqual([[[11, 21]], [[11, 21]]]);
      expect(drawnColors(), 'frame 1 colours').toEqual([[[11, 21]], [[11, 21]]]);
      frame = 2;
      renderer.render(scene, camera);
      // Frame 2. The main render object's event syncs row 0's range; the shadow render's event replaces it with row 1's
      // and uploads only that; back in the main pass the buffer was already checked in this call count: row 0 stays 11.
      expect(drawn(renderer, mesh), 'frame 2').toEqual([[[11, 22]], [[11, 22]]]);
      expect(drawnColors(), 'frame 2 colours').toEqual([[[11, 22]], [[11, 22]]]);
    }
  });

  it('checks a shared vertex buffer at most once per render() call', () => {
    // Drawn after a nested render that checked it, a render object cannot upload what changed since:
    // Geometries.updateAttribute keys the check by info.render.calls.
    for (const webgpu of [false, true]) {
      const renderer = new FakeRenderer({ webgpu, record: true, uniformBufferLimit: 64 });
      const { scene, camera } = sceneWithCamera();
      const mesh = instanced(4);
      mesh.count = 2;
      const reflection = camera.clone();
      // Drawn before the mesh: renders the scene once per frame, with the mesh in it.
      const mirror = cube('mirror', new MeshBasicMaterial());
      let reflecting = false;
      mirror.onBeforeRender = () => {
        if (reflecting) return;
        reflecting = true;
        renderer.render(scene, reflection);
        reflecting = false;
      };
      // The main pass writes row 0 every frame, after the reflection has drawn the mesh.
      let next = 5;
      mesh.onBeforeRender = (_r, _s, c) => {
        if (c !== camera) return;
        mesh.setMatrixAt(0, at(next++));
        mesh.instanceMatrix.needsUpdate = true;
      };
      scene.add(mirror, mesh);
      scene.updateMatrixWorld();
      renderer.render(scene, camera);
      // Frame 1: both render objects are new; their first check is not keyed by the call, the main one uploads 5.
      expect(drawn(renderer, mesh), 'frame 1').toEqual([[[5, 1]], [[0, 1]]]);
      renderer.render(scene, camera);
      // Frame 2: the reflection checked the buffer in its call (nothing new); the main pass writes 6 in that same call
      // count and cannot upload it: both draw 5.
      expect(drawn(renderer, mesh), 'frame 2').toEqual([[[5, 1]], [[5, 1]]]);
      renderer.render(scene, camera);
      // Frame 3: the reflection's call uploads 6; the main pass's 7 waits again.
      expect(drawn(renderer, mesh), 'frame 3').toEqual([[[6, 1]], [[6, 1]]]);
    }
  });
});

const passKinds = (renderer: FakeRenderer): string[] => renderer.passes.map((p) => `${p.kind}:${p.depth}`);
