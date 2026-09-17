/**
 * measureOverdraw re-entered: a measurement from a hook the count renders run, renders a hook or a reflector makes
 * inside a count draw, a count render that throws, and disposeOverdraw() during the counts.
 */
import {
  BoxGeometry,
  type Camera,
  DataTexture,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  type Scene,
  type Texture,
} from 'three';
import { float } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { disposeOverdraw, measureOverdraw, overdrawTargetOf } from '../../src/ledger/overdraw.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';

/** The count material's slots the tests below read back. */
type CountMaterial = Material & {
  map: Texture | null;
  opacityNode?: unknown;
  positionNode?: unknown;
  displacementMap?: Texture | null;
};

describe('measureOverdraw re-entrancy', () => {
  const geometry = new BoxGeometry(1, 1, 1);

  /** The unhandled rejections Node reports while `run` runs, and one macrotask after it. */
  async function unhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
    const reasons: unknown[] = [];
    const listener = (reason: unknown): void => void reasons.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', listener);
    }
    return reasons;
  }

  it('returns the measurement in progress to a call from a count-render hook', async () => {
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    scene.add(mesh);
    scene.updateMatrixWorld();
    let renders = 0;
    const render = renderer.render.bind(renderer);
    renderer.render = (s, c) => {
      renders++;
      render(s, c);
    };
    const nested: Array<Promise<unknown>> = [];
    // Counted before the call, so a measureOverdraw without the guard recurses at most 3 deep and fails these assertions
    // instead of overflowing the stack.
    let calls = 0;
    mesh.onBeforeRender = () => {
      if (calls++ < 3) nested.push(measureOverdraw(renderer as never, scene, camera));
    };
    const rejections = await unhandledRejections(async () => {
      const outer = measureOverdraw(renderer as never, scene, camera);
      expect(renders, 'the two count renders only').toBe(2);
      expect(nested).toHaveLength(1);
      expect(nested[0]).toBe(outer);
      // The counts have rendered and the state is back: a call while the read-backs are pending is a measurement of its own.
      mesh.onBeforeRender = () => {};
      const after = measureOverdraw(renderer as never, scene, camera);
      expect(after).not.toBe(outer);
      expect(renders).toBe(4);
      await Promise.all([outer, after]);
    });
    expect(rejections).toEqual([]);
  });

  it('joins a re-entered ledger measurement to the one in progress, ledger paused', async () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    scene.add(mesh, new Mesh(geometry, new MeshBasicMaterial({ transparent: true })));
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    const plain = ledger.frame();
    const measurements: Array<Promise<unknown>> = [];
    // The app frame's draw measures; the opaque count render draws this mesh again, and that call joins the measurement.
    // Counted before the call: without the guard the recursion stops 3 deep instead of overflowing the stack.
    let calls = 0;
    mesh.onBeforeRender = () => {
      if (calls++ < 3) measurements.push(ledger.measureOverdraw(scene, camera));
    };
    let hooked = plain;
    const rejections = await unhandledRejections(async () => {
      renderer.render(scene, camera);
      hooked = ledger.frame();
      mesh.onBeforeRender = () => {};
      const results = await Promise.all(measurements);
      expect(results[1]).toBe(results[0]);
    });
    expect(rejections).toEqual([]);
    expect(measurements).toHaveLength(2);
    expect(hooked.passes).toEqual(plain.passes);
    expect(hooked.totals).toEqual(plain.totals);
    expect(ledger as unknown as { paused: boolean; depth: number }).toMatchObject({ paused: false, depth: 0 });
    renderer.render(scene, camera);
    expect(ledger.frame().totals).toEqual(plain.totals);
    expect(ledger.frame().overdraw.measured).toBe(true);
  });
});

describe('measureOverdraw: nested renders, a throwing count render, disposal mid-count', () => {
  it('passes a scene a hook renders during a count draw straight through', async () => {
    // Its draws neither write the count material's slots nor run the count's skip rules.
    const { scene, camera } = sceneWithCamera();
    const renderer = new FakeRenderer();
    const outerMap = new DataTexture(new Uint8Array(4), 1, 1);
    const opacityNode = float(0.5);
    const outer = new Mesh(
      new PlaneGeometry(),
      Object.assign(new MeshBasicNodeMaterial({ map: outerMap, opacity: 0.25 }), { opacityNode }),
    );
    scene.add(outer);
    const nested = sceneWithCamera().scene;
    nested.overrideMaterial = new MeshBasicMaterial(); // the app's own override for its render-to-texture
    const nestedMesh = new Mesh(
      new PlaneGeometry(),
      new MeshBasicMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1), opacity: 0.75 }),
    );
    const noColour = new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ colorWrite: false })); // a count skip rule, not the app's
    nested.add(nestedMesh, noColour);
    for (const s of [scene, nested]) s.updateMatrixWorld();
    const drawnInNested: Object3D[] = [];
    let seenByOuter: unknown[] | null = null;
    renderer.renderObject = function (this: FakeRenderer, object: Object3D, s: Scene) {
      if (s === nested) {
        drawnInNested.push(object);
        return;
      }
      // Renderer.renderObject runs onBeforeRender (~3721) before its override copies (~3736): a hook's render comes first.
      this.render(nested, camera);
      const count = s.overrideMaterial as CountMaterial;
      seenByOuter = [count.map, count.opacity, count.opacityNode];
    };

    await measureOverdraw(renderer as never, scene, camera);

    expect(seenByOuter).toEqual([outerMap, 0.25, opacityNode]);
    // The outer material is opaque: the opaque count render draws it, and its hook renders the nested scene once.
    expect(drawnInNested).toEqual([nestedMesh, noColour]);
  });

  it("puts back the outer draw's positionNode and displacementMap after a nested render", async () => {
    // A reflector's updateBefore renders the same scene inside the draw, after three's copies.
    const { scene, camera } = sceneWithCamera();
    const renderer = new FakeRenderer();
    const outerPosition = float(1);
    const outerDisplacement = new DataTexture(new Uint8Array(4), 1, 1);
    const outer = new Mesh(
      new PlaneGeometry(),
      Object.assign(new MeshBasicNodeMaterial(), { positionNode: outerPosition, displacementMap: outerDisplacement }),
    );
    const reflected = new Mesh(
      new PlaneGeometry(),
      Object.assign(new MeshBasicNodeMaterial(), { positionNode: float(2) }),
    );
    scene.add(outer, reflected);
    scene.updateMatrixWorld();
    let reflecting = false;
    let seenAfterReflection: unknown[] | null = null;
    let countMaterial: CountMaterial | null = null;
    // Renderer.renderObject's override path: copy (~3744-3752), then the draw, whose updateBefore nodes render first
    // (~3875), then the restore (~3805-3809). The fake makes the copies and the restore itself but has no hook between
    // them, so the sequence is spelt out here.
    renderer.renderObject = function (
      this: FakeRenderer,
      object: Object3D,
      s: Scene,
      _camera: Camera,
      _geometry: unknown,
      material: Material,
    ) {
      const count = s.overrideMaterial as CountMaterial;
      countMaterial = count;
      const [position, displacement] = [count.positionNode, count.displacementMap ?? null];
      const source = material as CountMaterial;
      if (source.positionNode) count.positionNode = source.positionNode;
      count.displacementMap = source.displacementMap ?? null;
      if (object === outer && !reflecting) {
        reflecting = true;
        this.render(s, camera);
        reflecting = false;
        seenAfterReflection = [count.positionNode, count.displacementMap];
      }
      count.positionNode = position;
      count.displacementMap = displacement;
    };

    await measureOverdraw(renderer as never, scene, camera);

    expect(seenAfterReflection).toEqual([outerPosition, outerDisplacement]);
    expect([countMaterial!.positionNode ?? null, countMaterial!.displacementMap ?? null]).toEqual([null, null]);
  });

  it('clears the re-entrancy guard when a count render throws', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = new FakeRenderer();
    const render = renderer.render;
    let fail = true;
    let renders = 0;
    renderer.render = function (this: FakeRenderer, s: Object3D, c: Camera) {
      renders++;
      if (fail) throw new Error('device lost');
      render.call(this, s, c);
    };
    const failed = measureOverdraw(renderer as never, scene, camera);
    await expect(failed).rejects.toThrow('device lost');
    fail = false;
    const next = measureOverdraw(renderer as never, scene, camera);
    expect(next).not.toBe(failed);
    expect(renders, 'one throwing render, then two fresh count renders').toBe(3);
    await expect(next).resolves.toEqual({ opaque: 0, transparent: 0 });
  });

  it('defers a disposeOverdraw() made during the count renders until they end', async () => {
    // A hook that disposes and measures on every draw renders the counts once.
    const renderer = new FakeRenderer();
    const { scene, camera } = sceneWithCamera();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    scene.add(mesh);
    scene.updateMatrixWorld();
    let renders = 0;
    const render = renderer.render.bind(renderer);
    renderer.render = (s, c) => {
      renders++;
      render(s, c);
    };
    await measureOverdraw(renderer as never, scene, camera); // a target to release
    renders = 0;
    let released = false;
    overdrawTargetOf(renderer)!.addEventListener('dispose', () => {
      released = true;
    });
    const joined: Array<Promise<unknown>> = [];
    const releasedInHook: boolean[] = [];
    // Bounded: a disposal that drops the guard lets the next call render the counts inside the counts, level after level.
    let calls = 0;
    mesh.onBeforeRender = () => {
      if (calls++ >= 6) return;
      disposeOverdraw(renderer);
      releasedInHook.push(released);
      joined.push(measureOverdraw(renderer as never, scene, camera));
    };

    const outer = measureOverdraw(renderer as never, scene, camera);

    expect(renders, 'the two count renders only').toBe(2);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toBe(outer);
    expect(releasedInHook).toEqual([false]);
    expect(released, 'released as the counts end').toBe(true);
    expect(overdrawTargetOf(renderer)).toBeNull();
    mesh.onBeforeRender = () => {};
    await outer;
  });
});
