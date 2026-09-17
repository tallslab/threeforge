import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  Bone,
  type CoordinateSystem,
  DirectionalLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { tag } from '../../src/tags.js';
import { batchedOf, type FakeDraw, FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';
import { box, caster, casting } from './helpers/ledgerFixtures.js';

describe('DrawCallLedger culling stats', () => {
  it('reports instances submitted versus instances drawn after per-instance culling', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
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
    const light = casting(new DirectionalLight(), 'sun');
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
      const { renderer, ledger } = attachedLedger({
        webgpu,
        multiDraw,
        sceneHooks: true,
        shadowTrigger: 'first-receiver',
        record: true,
        shadowLights: [light],
      });
      new World(scene, { instanceThreshold: 1000, ledger }).compile({ coordinateSystem: cs });
      renderer.render(scene, camera);
      const frame = ledger.frame({ items: true });
      const batches = frame.items!.filter((i) => i.kind === 'batched');
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter(isBatch));
        const items = batches.filter((i) => i.pass.startsWith('shadow:') === (kind === 'shadow'));
        expect(draws.length, `${label} ${kind}: batch draws`).toBe(2);
        expect(
          items.map((i) => i.expectedGpuDraws),
          `${label} ${kind}: GPU draws`,
        ).toEqual(draws.map((d) => d.drawCalls));
        expect(
          items.map((i) => i.instancesDrawn),
          `${label} ${kind}: drawn instances`,
        ).toEqual(draws.map((d) => d.batchIds!.length));
      }
      const commands = renderer.passes
        .flatMap((p) => p.draws)
        .reduce((n, d) => n + (isBatch(d) ? d.batchIds!.length : d.drawCalls), 0);
      expect(frame.totals.drawCommands, `${label}: draw commands`).toBe(commands);
      expect(frame.totals.unattributed, `${label}: unattributed`).toBe(0);
      if (!multiDraw) {
        // One call per slot: each shadow draw issued more calls than it drew instances, so the pass did zero slots.
        const shadow = batches.filter((i) => i.pass.startsWith('shadow:'));
        expect(
          shadow.every((i) => i.expectedGpuDraws > i.instancesDrawn),
          `${label}: zeroed slots`,
        ).toBe(true);
      }
      drawn[label] = batches.map((i) => i.instancesDrawn);
    }
    // WEBGL_multi_draw packs the same slots into one call: the drawn instances do not depend on the packaging.
    expect(drawn['webgl2 multi-draw']).toEqual(drawn.webgl2);
  });

  it('predicts a compacted InstancedMesh from the count each pass draws, so a shadow pass appending only its own light stays attributed', () => {
    const isInstanced = (draw: FakeDraw): boolean =>
      (draw.object as { isInstancedMesh?: boolean }).isInstancedMesh === true;
    for (const webgpu of [false, true]) {
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const { scene, light, camera } = rows(cs);
      const { renderer, ledger } = attachedLedger({
        webgpu,
        sceneHooks: true,
        shadowTrigger: 'first-receiver',
        record: true,
        shadowLights: [light],
      });
      // The default instanceThreshold compacts each row of 101 repeats into a CulledInstancedMesh.
      const report = new World(scene, { ledger }).compile({ coordinateSystem: cs });
      expect(report.after, `webgpu ${webgpu}: two instanced rows`).toMatchObject({ batches: 0, instanced: 2 });
      renderer.render(scene, camera);
      const frame = ledger.frame({ items: true });
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter(isInstanced));
        const items = frame.items!.filter(
          (i) => i.reason === 'instanced' && i.pass.startsWith('shadow:') === (kind === 'shadow'),
        );
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
    // With one light, the casters it reaches and the casters any light of the frame reaches are the same set. Two
    // lights whose shadow cameras cover different slices of the rows tell a pass narrowed to its own light from one
    // that appended the frame's whole union.
    const isInstanced = (draw: FakeDraw): boolean =>
      (draw.object as { isInstancedMesh?: boolean }).isInstancedMesh === true;
    for (const webgpu of [false, true]) {
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const { scene, light, camera } = rows(cs);
      light.name = 'west'; // covers x in [-50, 50], away from the main camera's [70, 110]
      const east = casting(new DirectionalLight(), 'east');
      east.position.set(60, 60, 10);
      const eastCamera = east.shadow.camera;
      eastCamera.coordinateSystem = cs;
      Object.assign(eastCamera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
      eastCamera.updateProjectionMatrix();
      east.target.position.set(60, 0, 0); // covers x in [40, 80]
      scene.add(east, east.target);
      scene.updateMatrixWorld(true);

      const { renderer, ledger } = attachedLedger({
        webgpu,
        sceneHooks: true,
        shadowTrigger: 'first-receiver',
        record: true,
        shadowLights: [light, east],
      });
      const report = new World(scene, { ledger }).compile({ coordinateSystem: cs });
      expect(report.after, `webgpu ${webgpu}: two instanced rows`).toMatchObject({ batches: 0, instanced: 2 });
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
    const light = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: light });
    const nonCaster = tag.static(new Mesh(box, new MeshStandardMaterial()));
    scene.add(light, caster('caster'), nonCaster);
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
    (renderer as { render: typeof renderer.render }).render = (s, c) => {
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
    // :2686): the nested pass is the mesh alone.
    expect(frame.passes.map((p) => p.submissions)).toEqual([1, 2]);
    expect(frame.totals.sceneSubmissions).toBe(2);
  });

  it('disambiguates two nested passes of the same target name, and two scenes of the same name', () => {
    // `shadowPasses.ts` numbers two lights of one name against a frame-wide `taken` set; the `nested:` and `scene:`
    // ids draw on the same set, so two reflectors whose targets are both named `reflection` (or two portal Scenes both
    // named `portal`) keep their own row of `frame().passes` and their own `pass` string on every record.
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    scene.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const portalA = new Scene();
    portalA.name = 'portal';
    portalA.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const portalB = new Scene();
    portalB.name = 'portal';
    portalB.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const mirror = camera.clone();
    const original = renderer.render.bind(renderer);
    let nested = false;
    (renderer as { render: typeof renderer.render }).render = (s, c) => {
      if (!nested) {
        nested = true;
        // Two water reflectors, each with its own render target, both named `reflection`.
        for (let i = 0; i < 2; i++) {
          renderer.renderTarget = { name: 'reflection' };
          renderer.render(s, mirror);
          renderer.renderTarget = null;
        }
        for (const portal of [portalA, portalB]) renderer.render(portal, mirror);
        nested = false;
      }
      original(s, c);
    };
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.passes.map((p) => p.id)).toEqual([
      'nested:reflection',
      'nested:reflection#2',
      'scene:portal',
      'scene:portal#2',
      'main',
    ]);
    // One row each, and every record carries its own pass, so per-pass submissions are not summed under one label.
    // A reflector's render into a target draws no "Output Color Transform" quad; a portal Scene rendered to the default
    // target does, so those passes are the mesh plus the quad.
    expect(frame.passes.map((p) => p.submissions)).toEqual([1, 1, 2, 2, 2]);
    expect(new Set(frame.items!.map((i) => i.pass)).size).toBe(5);
    expect(frame.totals.unattributed).toBe(0);
  });

  it('counts program switches over scene submissions in submission order', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const a = new MeshStandardMaterial();
    const b = new MeshBasicMaterial();
    scene.add(tag.static(new Mesh(box, a)), tag.static(new Mesh(box, b)), tag.static(new Mesh(box, a)));
    renderer.render(scene, camera);
    expect(ledger.frame().totals.programSwitches).toBe(2);
  });

  it('ignores renderObject calls that happen outside a frame', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mesh = new Mesh(box, new MeshStandardMaterial());
    renderer.renderObject(mesh, scene, camera, box, mesh.material, null, null, null, null);
    expect(ledger.frame().totals.submissions).toBe(0);
  });

  it('keeps the last completed frame until the next render finishes', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
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
    const source = readFileSync(
      createRequire(import.meta.url).resolve('three/src/renderers/common/Renderer.js'),
      'utf8',
    );
    const start = source.indexOf('\tasync renderAsync( scene, camera ) {');
    expect(start, 'Renderer.renderAsync( scene, camera ) is defined').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n\t}\n', start));
    expect(body).toContain('this.render(');
    expect(body.indexOf('await this.init()'), 'init() is awaited before the render').toBeGreaterThan(-1);
    expect(body.indexOf('await this.init()')).toBeLessThan(body.indexOf('this.render('));
  });

  it('a frame rendered through renderAsync is one main frame: its shadow pass and skinning count as they do through render()', async () => {
    const setup = () => {
      const light = casting(new DirectionalLight(), 'sun');
      const pair = attachedLedger({ shadowLight: light });
      const bones = [new Bone(), new Bone()];
      bones[0]!.add(bones[1]!);
      const skinned = new SkinnedMesh(box, new MeshStandardMaterial());
      skinned.name = 'skinned';
      skinned.castShadow = true;
      skinned.add(bones[0]!);
      skinned.bind(new Skeleton(bones));
      pair.scene.add(light, caster('caster'), skinned);
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
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(
      tag.static(new Mesh(box, new MeshStandardMaterial())),
      tag.static(new Mesh(box, new MeshStandardMaterial())),
    );
    const other = new Scene();
    other.add(tag.static(new Mesh(box, new MeshStandardMaterial())));
    const pending = renderer.renderAsync(scene, camera); // suspended at `await this.init()`
    // No pass kind is pending in the fake here (only a shadow or VSM pass sets one, right before its own render), so this
    // render cannot take another render's kind.
    renderer.render(other, camera);
    const between = ledger.frame();
    await pending;
    const after = ledger.frame();
    expect(
      [between.passes.map((p) => p.id), between.totals.sceneSubmissions],
      'the frame the interleaved render() completed',
    ).toEqual([['main'], 1]);
    expect([after.passes.map((p) => p.id), after.totals.sceneSubmissions], 'the frame renderAsync completed').toEqual([
      ['main'],
      2,
    ]);
  });

  it('depth is back at 0 after renderAsync, after an interleaved render() and after a render or renderAsync that throws', async () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
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
    expect(
      [ledger.frame().passes.map((p) => p.id), ledger.frame().totals.sceneSubmissions],
      'the next render() is a frame of its own',
    ).toEqual([['main'], 1]);
  });

  it('attach() and detach() leave renderAsync untouched: no own property shadows the prototype method', () => {
    const renderer = new FakeRenderer();
    const original = renderer.renderAsync;
    const own = () => Object.hasOwn(renderer, 'renderAsync');
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    expect([renderer.renderAsync === original, own()], 'attached').toEqual([true, false]);
    ledger.detach();
    expect([renderer.renderAsync === original, own()], 'detached').toEqual([true, false]);
  });

  it('attach() after a detach() from inside a draw starts from depth 0, so the next render is a main frame', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
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
