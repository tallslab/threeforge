/**
 * Compacted InstancedMesh in nested render passes: the main pass draws exactly its list, a shadow pass keeps the
 * enclosing rows and appends only the casters its light reaches, and count is back to the main list after every
 * nested render. Rig and reference in `helpers/nestedPassRig.ts`.
 */

import {
  Box3,
  type Camera,
  type DirectionalLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLCoordinateSystem,
} from 'three';
import { describe, expect, it } from 'vitest';
import type { NestedPassPolicy } from '../../src/compiler/culling.js';
import { createCulledInstancedMesh } from '../../src/compiler/instancing.js';
import { PassTracker } from '../../src/compiler/passTracker.js';
import { mulberry32 } from '../scenes/naive.js';
import { type FakePass, FakeRenderer } from './helpers/fakeRenderer.js';
import {
  backends,
  box,
  cameraAt,
  expectExact,
  expectInstancedPasses,
  frustumOf,
  type Instanced,
  type InstancedRig,
  insertBefore,
  instancedIds,
  instancedRig,
  mirrorMesh,
  passLabels,
  pointLight,
  policies,
  reference,
  setFrame,
  sunLight,
} from './helpers/nestedPassRig.js';

const _box = new Box3();

describe.each(backends)(
  'more shadow cameras in a frame than the caster bitmask has bits (webgpu: $webgpu)',
  ({ webgpu }) => {
    it('appends the whole union past the 32nd camera and still draws every caster', () => {
      // `bitFor` (src/compiler/instancing.ts) gives each shadow camera of the frame one bit of a Uint32, and
      // `appendCasters` appends only the casters the camera reaches. Past the 32nd camera no bit is left, so the
      // per-light filter is skipped and the pass appends the frame's whole union: more than the light needs, but never
      // a dropped caster, which is what would show as a missing shadow.
      const COUNT = 33;
      const r = instancedRig({
        webgpu,
        nested: 'auto',
        buffers: 'uniform',
        // Narrow suns spread along the rows, so each reaches a different few cubes and the slices stay distinguishable.
        lights: (cs) => Array.from({ length: COUNT }, (_, i) => sunLight(`sun-${i}`, -96 + i * 6, cs, 3)),
      });
      expect(r.lights).toHaveLength(COUNT);
      r.renderer.render(r.scene, r.main);
      expect(passLabels(r.renderer)).toEqual(['render:0', ...Array<string>(COUNT).fill('shadow:1')]);
      // The contract every pass keeps, the fallback included: every caster its own camera needs is drawn, and nothing
      // that no light of the frame and not the main camera reaches.
      expectInstancedPasses(r, `${COUNT} suns`);

      const [main, ...shadows] = r.renderer.passes as [FakePass, ...FakePass[]];
      const past = shadows[32]!;
      expect(past.light!.name, 'the 33rd shadow camera').toBe('sun-32');
      for (const mesh of [r.unlit, r.lit]) {
        const name = mesh === r.unlit ? 'unlit' : 'lit';
        const held = new Set(instancedIds(r, main, mesh, `${name}, main`));
        const ids = instancedIds(r, past, mesh, `${name}, the 33rd sun`);
        const own = reference(r, mesh, frustumOf(past, r.cs));
        const drawn = new Set(ids);
        expect(
          own.must.filter((id) => !drawn.has(id)),
          `${name}: casters the 33rd sun needs but did not draw`,
        ).toEqual([]);
        // It appended the other suns' casters too, which is what the missing bit costs: the superset, not a narrowed list.
        const foreign = [
          ...new Set(shadows.filter((p) => p !== past).flatMap((p) => reference(r, mesh, frustumOf(p, r.cs)).must)),
        ].filter((id) => !held.has(id) && !own.may.has(id));
        expect(foreign.length, `${name}: the other suns have casters of their own`).toBeGreaterThan(15);
        expect(
          foreign.filter((id) => !drawn.has(id)),
          `${name}: past the 32nd camera the pass appends the frame's whole union`,
        ).toEqual([]);
      }
      // A camera inside the 32 still gets only its own casters, so the fallback is the exception and not the new rule.
      for (const mesh of [r.unlit, r.lit]) {
        const name = mesh === r.unlit ? 'unlit' : 'lit';
        const held = new Set(instancedIds(r, main, mesh, `${name}, main`));
        const first = shadows[0]!;
        const own = reference(r, mesh, frustumOf(first, r.cs));
        expect(
          instancedIds(r, first, mesh, `${name}, the 1st sun`).filter((id) => !held.has(id) && !own.may.has(id)),
          `${name}: the 1st sun appended only the casters it reaches`,
        ).toEqual([]);
      }
    });
  },
);

const bufferPaths = ['uniform', 'vertex'] as const;

describe.each(backends)('compacted InstancedMesh in nested passes (webgpu: $webgpu)', ({ webgpu }) => {
  describe.each(policies)("nestedPasses: '%s'", (nested) => {
    describe.each(bufferPaths)('%s buffers', (buffers) => {
      const resolved: NestedPassPolicy = nested === 'auto' ? 'per-pass' : nested;

      it.each([false, true])(
        'draws the main list exactly and every caster a shadow camera needs, on two frames (lit row first: %s)',
        (litFirst) => {
          const r = instancedRig({ webgpu, nested, buffers, litFirst });
          expect(r.report.nestedPasses).toBe(resolved);
          expect(r.report.after).toMatchObject({ batches: 0, instanced: 2 });
          expect(
            r.scene.children.indexOf(r.unlit) < r.scene.children.indexOf(r.lit),
            'the unlit mesh is first in traversal',
          ).toBe(!litFirst);
          for (let frame = 1; frame <= 2; frame++) {
            r.renderer.render(r.scene, r.main);
            expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1']);
            expectInstancedPasses(r, `frame ${frame}`);
          }
          const [main, shadow] = r.renderer.passes as [FakePass, FakePass];
          for (const mesh of [r.unlit, r.lit]) {
            const mainMust = new Set(reference(r, mesh, frustumOf(main, r.cs)).must);
            expect(
              reference(r, mesh, frustumOf(shadow, r.cs)).must.filter((id) => !mainMust.has(id)).length,
              'casters outside the view',
            ).toBeGreaterThan(20);
          }
        },
      );

      it.each([false, true])(
        'keeps the rows exact while the main camera moves every frame, the lit mesh receiving shadows first (per-instance colours: %s)',
        (colors) => {
          const r = instancedRig({ webgpu, nested, buffers, colors });
          expect(r.lit.instanceColor === null, 'per-instance colours on the lit mesh').toBe(!colors);
          for (let frame = 1; frame <= 3; frame++) {
            // Two cubes leave the view and two enter each frame: the main rows and the appended casters both change.
            r.main.position.set(4 * (frame - 1), 6, 35);
            r.main.lookAt(4 * (frame - 1), 0, 0);
            r.main.updateMatrixWorld();
            r.renderer.render(r.scene, r.main);
            expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1']);
            expectInstancedPasses(r, `frame ${frame}`);
          }
        },
      );

      it('leaves count and visibleIds holding the main list once the frame is over', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        r.renderer.render(r.scene, r.main);
        const frustum = frustumOf(r.renderer.passes[0]!, r.cs);
        for (const mesh of [r.unlit, r.lit]) {
          expect(mesh.visibleIds.length, 'visibleIds matches count').toBe(mesh.count);
          expectExact('after the frame', mesh.visibleIds, reference(r, mesh, frustum));
        }
      });

      it('serves two suns and six point faces from rows appended once, restoring count', () => {
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20), pointLight('bulb', 0, cs, 30)],
        });
        const shadowCameras = new Set<Camera>(r.lights.map((light) => light.shadow.camera));
        const afterShadow: number[][] = [];
        r.scene.onAfterRender = ((previous) =>
          function (this: Scene, ...args: Parameters<Scene['onAfterRender']>) {
            previous.apply(this, args);
            if (shadowCameras.has(args[2])) afterShadow.push([r.unlit.count, r.lit.count]);
          })(r.scene.onAfterRender);
        for (let frame = 1; frame <= 2; frame++) {
          afterShadow.length = 0;
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', ...Array<string>(8).fill('shadow:1')]);
          expectInstancedPasses(r, `frame ${frame}`);
          const counts = [r.unlit.count, r.lit.count];
          expect(afterShadow, 'count is back to the main list after each shadow render').toEqual(
            Array.from({ length: 8 }, () => counts),
          );
        }
      });

      it('appends to each shadow light only the casters it reaches, after the enclosing rows', () => {
        // Two suns with disjoint volumes, neither overlapping the main view: every appended caster belongs to exactly
        // one of them, so a pass that appended the frame's union would draw the other light's casters too.
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20)],
        });
        for (let frame = 1; frame <= 2; frame++) {
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', 'shadow:1', 'shadow:1']);
          expectInstancedPasses(r, `frame ${frame}`);
          const [main, ...shadows] = r.renderer.passes as [FakePass, ...FakePass[]];
          expect(shadows.map((p) => p.light!.name)).toEqual(['east', 'west']);
          for (const mesh of [r.unlit, r.lit]) {
            const name = mesh === r.unlit ? 'unlit' : 'lit';
            const prefix = instancedIds(r, main, mesh, `frame ${frame}, ${name}, main`);
            for (const pass of shadows) {
              const label = `frame ${frame}, ${name}, ${pass.light!.name}`;
              const ids = instancedIds(r, pass, mesh, label);
              // Compared in row order, never as a set: the enclosing pass's rows must be the same rows, unreordered.
              expect(ids.slice(0, prefix.length), `${label}: the enclosing pass's rows`).toEqual(prefix);
              const own = reference(r, mesh, frustumOf(pass, r.cs));
              const other = reference(r, mesh, frustumOf(shadows.find((p) => p !== pass)!, r.cs));
              const held = new Set(prefix);
              expect(
                other.must.filter((id) => !held.has(id) && !own.may.has(id)).length,
                `${label}: the other light has casters of its own`,
              ).toBeGreaterThan(15);
              expect(
                ids.slice(prefix.length).filter((id) => !own.may.has(id)),
                `${label}: appended casters this light does not reach`,
              ).toEqual([]);
              expect(
                own.must.filter((id) => !ids.includes(id)),
                `${label}: casters this light reaches that were not drawn`,
              ).toEqual([]);
            }
          }
        }
      });

      it('rewrites the appended tail only for a light whose casters differ from the rows', () => {
        // The worst case for uploads: two disjoint caster sets, so each pass rewrites what the pass before it wrote.
        // A light whose casters are the rows already there (a point light's faces, or a set the tail starts with)
        // writes nothing; `writeRows` marks only rows that change.
        const r = instancedRig({
          webgpu,
          nested,
          buffers,
          lights: (cs) => [sunLight('east', 60, cs, 20), sunLight('west', -60, cs, 20)],
        });
        const bumps = (): number[] => {
          const before = [r.unlit, r.lit].map((m) => m.instanceMatrix.version);
          r.renderer.render(r.scene, r.main);
          return [r.unlit, r.lit].map((m, i) => m.instanceMatrix.version - before[i]!);
        };
        // Frame 1: the outermost compaction, then one append per sun. Frame 2: the compaction is skipped (the view and
        // the rows are unchanged), and each sun rewrites the tail the other left.
        expect(bumps(), 'frame 1').toEqual([3, 3]);
        expect(bumps(), 'frame 2').toEqual([2, 2]);
      });

      it("draws the main camera's list in a reflection rendered between the rows", () => {
        const r = instancedRig({ webgpu, nested, buffers });
        insertBefore(r.scene, mirrorMesh(r.scene, cameraAt(-60, r.cs)), r.lit);
        for (let frame = 1; frame <= 2; frame++) {
          r.renderer.render(r.scene, r.main);
          expect(passLabels(r.renderer)).toEqual(['render:0', 'render:1', 'shadow:2', 'shadow:1']);
          expectInstancedPasses(r, `frame ${frame}`);
          const [main, reflection] = r.renderer.passes as [FakePass, FakePass];
          // The open main pass compacted the unlit row; the reflection reaches the lit row first and compacts it for the
          // main camera. Either way the reflection draws the main list and appends nothing.
          for (const mesh of [r.unlit, r.lit]) {
            const name = mesh === r.unlit ? 'unlit' : 'lit';
            expect(
              new Set(instancedIds(r, reflection, mesh, `reflection, ${name}`)),
              `frame ${frame}, reflection, ${name}`,
            ).toEqual(new Set(instancedIds(r, main, mesh, `main, ${name}`)));
          }
        }
      });

      it('uploads only the rows that change across a first, a static and a moved-light frame', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        const versions = (): number[] => [r.unlit, r.lit].map((m) => m.instanceMatrix.version);
        const frame = (): number[] => {
          const before = versions();
          r.renderer.render(r.scene, r.main);
          return versions().map((v, i) => v - before[i]!);
        };
        expect(frame(), 'frame 1').toEqual([2, 2]);
        expect(frame(), 'frame 2').toEqual([0, 0]);
        const sun = r.lights[0] as DirectionalLight;
        sun.position.x = -50;
        sun.target.position.x = -50;
        sun.updateMatrix(); // compile() froze the static light
        sun.target.updateMatrix();
        r.scene.updateMatrixWorld(true);
        expect(frame(), 'frame 3').toEqual([1, 1]);
        expectInstancedPasses(r, 'frame 3');
      });

      it('recovers exact count and lists on the animation frame after a nested render throws', () => {
        const r = instancedRig({ webgpu, nested, buffers });
        const thrower = new Mesh(box, new MeshBasicMaterial());
        thrower.name = 'thrower';
        thrower.castShadow = true;
        thrower.position.set(50, 0.5, 0);
        thrower.updateMatrixWorld();
        let armed = true;
        thrower.onBeforeRender = (_renderer, _scene, camera) => {
          if (armed && camera === r.lights[0]!.shadow.camera) throw new Error('shadow pass failed');
        };
        r.scene.add(thrower);
        setFrame(r.renderer, 1);
        expect(() => r.renderer.render(r.scene, r.main)).toThrow('shadow pass failed');
        armed = false;
        r.scene.overrideMaterial = null; // ShadowNode.updateShadow restores the scene state only when the map render returns
        const next = new FakeRenderer({
          webgpu,
          sceneHooks: true,
          shadowTrigger: 'first-receiver',
          record: true,
          shadowLights: r.lights,
          uniformBufferLimit: buffers === 'vertex' ? 1024 : 65536,
        });
        const again: InstancedRig = { ...r, renderer: next };
        for (let frame = 2; frame <= 3; frame++) {
          setFrame(next, frame);
          next.render(r.scene, r.main);
          expect(passLabels(next)).toEqual(['render:0', 'shadow:1']);
          expectInstancedPasses(again, `frame ${frame} after the throw`);
        }
        const frustum = frustumOf(next.passes[0]!, r.cs);
        for (const mesh of [r.unlit, r.lit]) {
          expect(mesh.visibleIds.length).toBe(mesh.count);
          expectExact('after the throw', mesh.visibleIds, reference(r, mesh, frustum));
        }
      });
    });
  });
});

describe('compacted InstancedMesh driven by a PassTracker', () => {
  function field() {
    const main = new PerspectiveCamera(60, 1.5, 0.1, 300);
    main.position.set(0, 2, 0);
    main.lookAt(100, 1, 0);
    main.updateMatrixWorld();
    const mirror = main.clone();
    mirror.rotateY(Math.PI); // looks the other way: a different visible set
    mirror.updateMatrixWorld();
    const rng = mulberry32(5);
    const matrices = Array.from({ length: 2000 }, () =>
      new Matrix4().makeTranslation(rng() * 2000 - 1000, 1, rng() * 2000 - 1000),
    );
    const passes = new PassTracker();
    const mesh = createCulledInstancedMesh(box, new MeshStandardMaterial(), matrices, null, WebGLCoordinateSystem, {
      passes,
    }) as Instanced;
    const scene = new Scene();
    const run = (c: Camera): void =>
      mesh.onBeforeRender(
        { coordinateSystem: WebGLCoordinateSystem } as never,
        scene,
        c,
        mesh.geometry,
        mesh.material as never,
        null as never,
      );
    const inView = (c: Camera): Set<number> => {
      const frustum = frustumOf(c, WebGLCoordinateSystem);
      const ids = new Set<number>();
      matrices.forEach((m, id) => {
        if (frustum.intersectsBox(_box.copy(box.boundingBox!).applyMatrix4(m))) ids.add(id);
      });
      return ids;
    };
    return { main, mirror, mesh, passes, run, inView };
  }

  it("draws the enclosing pass's list in a nested render that is not a shadow map, without an upload", () => {
    const f = field();
    f.passes.begin(f.main);
    f.run(f.main);
    const ids = [...f.mesh.visibleIds];
    expect(new Set(ids)).toEqual(f.inView(f.main));
    const version = f.mesh.instanceMatrix.version;
    f.passes.begin(f.mirror);
    f.run(f.mirror);
    expect(f.mesh.visibleIds).toEqual(ids);
    expect(f.mesh.count).toBe(ids.length);
    expect(f.mesh.instanceMatrix.version, 'no upload for the nested pass').toBe(version);
    f.passes.end();
    f.passes.end();
    expect([f.mesh.count, f.mesh.visibleIds]).toEqual([ids.length, ids]);
  });

  it('compacts for the main camera first when a nested render reaches the mesh before it', () => {
    const f = field();
    for (let frame = 1; frame <= 2; frame++) {
      f.passes.begin(f.main); // the outermost render has not drawn the mesh yet
      f.passes.begin(f.mirror);
      f.run(f.mirror);
      const ids = [...f.mesh.visibleIds];
      expect(new Set(ids), `frame ${frame}: the nested render draws the main camera's list`).toEqual(f.inView(f.main));
      expect(f.mesh.count).toBe(ids.length);
      f.passes.end();
      const version = f.mesh.instanceMatrix.version;
      f.run(f.main);
      expect([f.mesh.count, f.mesh.visibleIds], `frame ${frame}: the outermost render draws the same list`).toEqual([
        ids.length,
        ids,
      ]);
      expect(f.mesh.instanceMatrix.version, 'without another upload').toBe(version);
      f.passes.end();
    }
  });
});
