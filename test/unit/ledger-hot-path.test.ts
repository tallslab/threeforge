/**
 * The ledger's per-submission hot path (Task 26): guarded by counts, not timings, plus one µs ratio.
 *
 * - Registry cache reads per frame are bounded by unique materials (the ledger memoizes `hashesOf()` per frame and
 *   never calls `describe()`), and stay current across `registry.invalidate()`.
 * - A frame without a rescan traverses the scene at most once; nothing calls `children.indexOf` for display names,
 *   and cached names always equal `displayName()` computed at the same instant.
 * - Draw state is read after `renderObject` returns, so a nested shadow pass inside a receiver's draw (which zeroes
 *   prefix slots, appends rows and restores them at pass end) is attributed exactly.
 * - Pooled records never leak: items handed out by `frame({ items: true })`, or read inside a frame, keep their values.
 * - A frame whose shadow maps render as nested passes keeps all of it: one walk of the scene, registry reads still
 *   bounded by unique materials, and each caster marked once however many maps it is drawn into.
 *
 * `ListRenderer` stands in for three where a test must count the ledger's own traversals: it walks the scene with a
 * plain loop instead of `Object3D.traverse`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PointLight,
  Scene,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type BufferGeometry,
  type Camera,
  type CoordinateSystem,
  type Light,
  type Material,
} from 'three';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger, type LedgerRenderer } from '../../src/ledger/DrawCallLedger.js';
import { displayName, flagsInto, reasonOf } from '../../src/ledger/reasons.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

const box = new BoxGeometry(1, 1, 1);

/**
 * The part of three's render loop the ledger patches, without a traversal of its own: a depth-first walk of visible
 * meshes with a plain loop, one `renderObject` call each (object hooks around it). `internal` objects render after the
 * scene with the scene as root, like three's output quad. With `expectNames`, the name `displayName()` gives each
 * object right before its `renderObject` call (the instant the ledger names it) is pushed to `expectedNames` once the
 * call returns (the order the ledger files items in: a pass nested inside the call files its items first).
 */
class ListRenderer implements LedgerRenderer {
  readonly info = { render: { drawCalls: 0, triangles: 0 }, memory: { programs: 0, textures: 0, geometries: 0 } };
  readonly backend = { hasFeature: (name: string) => name === 'WEBGL_multi_draw' };
  internal: Object3D[] = [];
  expectNames = false;
  expectedNames: string[] = [];
  /** renderObject's argument 7 for scene objects (three's lights node); internal objects get null. */
  lightsNode: { getLights(): Light[] } | null = null;
  /**
   * Shadow-casting lights whose maps render as nested passes of every outermost Scene render, before its own list, as
   * three's ShadowNode.updateBefore does. A map's pass draws the scene's casters only, with `light.shadow.camera` —
   * the camera the ledger's walk of the scene gave that light's pass id to.
   */
  shadowLights: (Light & { shadow: { camera: Camera } })[] = [];
  private inShadowPass = false;

  render(scene: Scene, camera: Camera): unknown {
    const shadowPass = this.inShadowPass;
    const draw = (object: Object3D, lightsNode: { getLights(): Light[] } | null): void => {
      const name = this.expectNames ? displayName(object, scene) : '';
      const mesh = object as Mesh;
      this.renderObject(object, scene, camera, mesh.geometry, mesh.material, null, lightsNode, null, null);
      if (this.expectNames) this.expectedNames.push(name);
    };
    const visit = (object: Object3D): void => {
      if (!object.visible) return;
      // A shadow map draws casters only, like ShadowBaseNode's render-object function.
      if ((object as Mesh).isMesh && (!shadowPass || object.castShadow)) draw(object, this.lightsNode);
      const children = object.children;
      for (let i = 0; i < children.length; i++) visit(children[i]!);
    };
    if (!shadowPass && scene.isScene) {
      for (const light of this.shadowLights) {
        this.inShadowPass = true;
        try {
          // `this.render` is the ledger-patched instance method, so the map is a nested pass of this frame.
          this.render(scene, light.shadow.camera);
        } finally {
          this.inShadowPass = false;
        }
      }
    }
    visit(scene);
    if (!shadowPass && scene.isScene) for (const object of this.internal) draw(object, null);
    return undefined;
  }

  renderObject(...args: unknown[]): unknown {
    const [object, scene, camera, geometry, material] = args as [Object3D, Scene, Camera, BufferGeometry, Material];
    object.onBeforeRender(this as never, scene, camera, geometry, material, null as never);
    this.info.render.drawCalls++;
    object.onAfterRender(this as never, scene, camera, geometry, material, null as never);
    return undefined;
  }
}

/**
 * Counts outermost `Object3D.prototype.traverse` and `traverseVisible` calls while `run` runs (three's recurse through
 * the prototype, so a nested call of either kind is part of the outermost walk).
 */
function countTraversals(run: () => void): number {
  const proto = Object3D.prototype;
  const originals = { traverse: proto.traverse, traverseVisible: proto.traverseVisible };
  let depth = 0;
  let outermost = 0;
  for (const key of ['traverse', 'traverseVisible'] as const) {
    const original = originals[key];
    proto[key] = function (this: Object3D, callback: (object: Object3D) => unknown) {
      if (depth === 0) outermost++;
      depth++;
      try {
        return original.call(this, callback);
      } finally {
        depth--;
      }
    };
  }
  try {
    run();
  } finally {
    proto.traverse = originals.traverse;
    proto.traverseVisible = originals.traverseVisible;
  }
  return outermost;
}

/** Counts `indexOf` calls on any of `arrays` while `run` runs. */
function countIndexOf(arrays: Set<unknown>, run: () => void): number {
  const proto = Array.prototype as unknown as { indexOf: (...args: unknown[]) => number };
  const original = proto.indexOf;
  let calls = 0;
  proto.indexOf = function (this: unknown, ...args: unknown[]) {
    if (arrays.has(this)) calls++;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    proto.indexOf = original;
  }
  return calls;
}

describe('DrawCallLedger material hashes', () => {
  it('reads the registry at most once per unique material in a frame, however the materials interleave, and never calls describe()', () => {
    const registry = new MaterialRegistry();
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) => registry.register(new MeshStandardMaterial({ color })));
    const { scene, camera } = sceneWithCamera();
    for (let i = 0; i < 40; i++) scene.add(tag.static(new Mesh(box, materials[i % 4]!)));
    const renderer = new ListRenderer();
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer);
    renderer.render(scene, camera);

    const keys = vi.spyOn(registry, 'keys');
    const describeSpy = vi.spyOn(registry, 'describe');
    renderer.render(scene, camera);
    const reads = keys.mock.calls.length;
    const describes = describeSpy.mock.calls.length;
    keys.mockRestore();
    describeSpy.mockRestore();

    expect(ledger.frame().totals.sceneSubmissions).toBe(40);
    expect(describes).toBe(0);
    expect(reads).toBeLessThanOrEqual(4);
    expect(Object.keys(ledger.frame().programs)).toEqual([registry.describe(materials[0]!).programHash]);
  });

  it('reports the re-filed hashes after registry.invalidate(), between frames and inside a frame', () => {
    const registry = new MaterialRegistry();
    const shared = new MeshStandardMaterial({ color: 0x336699 });
    registry.register(shared);
    const { scene, camera } = sceneWithCamera();
    const meshes = [0, 1, 2, 3].map((i) => {
      const mesh = tag.static(new Mesh(box, shared));
      mesh.name = `a${i}`;
      scene.add(mesh);
      return mesh;
    });
    const renderer = new ListRenderer();
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer);
    const hashes = () => ledger.frame({ items: true }).items!.map((i) => i.programHash);

    renderer.render(scene, camera);
    const h1 = registry.describe(shared).programHash;
    expect(hashes()).toEqual([h1, h1, h1, h1]);

    shared.flatShading = true;
    registry.invalidate(shared);
    const d2 = registry.describe(shared);
    expect(d2.programHash).not.toBe(h1);
    renderer.render(scene, camera);
    expect(hashes()).toEqual([d2.programHash, d2.programHash, d2.programHash, d2.programHash]);

    // a1's hook runs after the ledger read a1's hashes: a0 and a1 keep the old ones, a2 and a3 get the new ones.
    let fired = false;
    meshes[1]!.onBeforeRender = () => {
      if (fired) return;
      fired = true;
      shared.wireframe = true;
      registry.invalidate(shared);
    };
    renderer.render(scene, camera);
    const d3 = registry.describe(shared);
    expect(d3.programHash).not.toBe(d2.programHash);
    expect(hashes()).toEqual([d2.programHash, d2.programHash, d3.programHash, d3.programHash]);
    const programs = ledger.frame().programs;
    expect(programs[d2.programHash]).toEqual({ type: 'MeshStandardMaterial', description: d2.description, submissions: 2 });
    expect(programs[d3.programHash]).toEqual({ type: 'MeshStandardMaterial', description: d3.description, submissions: 2 });
  });
});

describe('DrawCallLedger scene walks', () => {
  it('traverses a scene at most once on a frame without a rescan', () => {
    const { scene, camera } = sceneWithCamera();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.name = 'sun';
    sun.castShadow = true;
    scene.add(sun);
    for (let i = 0; i < 20; i++) scene.add(tag.static(new Mesh(box, new MeshBasicMaterial())));
    const renderer = new ListRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer);
    renderer.render(scene, camera); // the first frame rescans

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    expect(ledger.frame().totals.sceneSubmissions).toBe(20);
    expect(ledger.frame().lighting).toMatchObject({ lights: { directional: 1 }, shadowLights: 1 });
  });

  it('reads the lights three projected from the first scene submission, once per frame, without another walk', () => {
    const { scene, camera } = sceneWithCamera();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.castShadow = true;
    scene.add(sun);
    for (let i = 0; i < 20; i++) scene.add(tag.static(new Mesh(box, new MeshBasicMaterial())));
    const renderer = new ListRenderer();
    // Not the lights in the scene graph: the section must come from the lights node.
    const projected: Light[] = [sun, new PointLight()];
    let reads = 0;
    renderer.lightsNode = {
      getLights: () => {
        reads++;
        return projected;
      },
    };
    const ledger = new DrawCallLedger();
    ledger.attach(renderer);
    renderer.render(scene, camera); // the first frame rescans
    reads = 0;

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    expect(reads).toBe(1);
    expect(ledger.frame().lighting).toMatchObject({ lights: { directional: 1, point: 1 }, shadowLights: 1 });
  });

  it('never calls children.indexOf for display names, in frames or rescans, and names match displayName()', () => {
    const { scene, camera } = sceneWithCamera();
    scene.add(new DirectionalLight());
    const zone = new Group();
    zone.name = 'zone';
    const inner = new Group();
    inner.add(new Mesh(box, new MeshBasicMaterial()), tag.static(new Mesh(box, new MeshBasicMaterial())));
    zone.add(new Mesh(box, new MeshBasicMaterial()), inner);
    const named = new Mesh(box, new MeshBasicMaterial());
    named.name = 'crate';
    const loose = new Group();
    loose.add(tag.static(new Mesh(box, new MeshBasicMaterial())));
    scene.add(new Mesh(box, new MeshBasicMaterial()), named, zone, loose, tag.static(new Mesh(box, new MeshBasicMaterial())));
    const renderer = new ListRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer);
    const childArrays = new Set<unknown>();
    scene.traverse((o) => childArrays.add(o.children));

    const calls = countIndexOf(childArrays, () => {
      renderer.render(scene, camera); // includes the first rescan
      renderer.render(scene, camera);
      ledger.rescan();
    });

    expect(calls).toBe(0);
    const names = ledger.frame({ items: true }).items!.map((i) => i.name);
    expect(names).toEqual(['Mesh[1]', 'crate', 'zone/Mesh[0]', 'zone/Group[1]/Mesh[0]', 'zone/Group[1]/Mesh[1]', 'Group[4]/Mesh[0]', 'Mesh[5]']);
    // The reference, outside the counted calls (displayName() itself uses indexOf).
    renderer.expectNames = true;
    renderer.render(scene, camera);
    expect(renderer.expectedNames).toEqual(names);
    expect(ledger.frame().hints.find((h) => h.code === 'static-auto-update')?.objects).toEqual(['zone/Group[1]/Mesh[1]', 'Group[4]/Mesh[0]', 'Mesh[5]']);
  });

  it('keeps names current through renames, sibling reorders, reparenting, removal and mutations inside a frame', () => {
    const { scene, camera } = sceneWithCamera();
    const material = new MeshBasicMaterial();
    const zone = new Group();
    zone.name = 'zone';
    const group = new Group();
    const meshes = Array.from({ length: 6 }, () => new Mesh(box, material));
    group.add(meshes[0]!, meshes[1]!, meshes[2]!);
    zone.add(group, meshes[3]!);
    scene.add(zone, meshes[4]!, meshes[5]!);
    // An unnamed object rendered with the scene as root but outside it, and a second scene rendered from a hook.
    const outside = new Group().add(new Mesh(box, material), new Mesh(box, material));
    const portal = new Scene();
    const portalGroup = new Group().add(new Mesh(box, material));
    portal.add(new Mesh(box, material), portalGroup);
    const renderer = new ListRenderer();
    renderer.internal = [outside.children[1]!];
    renderer.expectNames = true;
    meshes[5]!.onBeforeRender = (r) => {
      (r as unknown as ListRenderer).render(portal, camera);
    };
    const ledger = new DrawCallLedger();
    ledger.attach(renderer);
    const frame = (mutate: () => void): void => {
      mutate();
      renderer.expectedNames = [];
      renderer.render(scene, camera);
      expect(ledger.frame({ items: true }).items!.map((i) => i.name)).toEqual(renderer.expectedNames);
    };

    frame(() => {});
    expect(renderer.expectedNames).toContain('zone/Group[0]/Mesh[1]');
    expect(renderer.expectedNames).toContain('Group[0]/Mesh[1]'); // outside the scene: the path runs to its top
    expect(renderer.expectedNames).toContain('Group[1]/Mesh[0]'); // portal pass, portal scene as root
    frame(() => {
      zone.name = 'area';
    });
    frame(() => {
      group.remove(meshes[0]!); // every later sibling's index shifts
    });
    frame(() => {
      zone.add(meshes[0]!); // reparented to the end of zone
      group.children.reverse(); // reordered in place
    });
    frame(() => {
      meshes[1]!.name = 'named';
      zone.name = '';
    });
    frame(() => {
      meshes[1]!.name = '';
      scene.remove(meshes[4]!);
      group.add(meshes[4]!);
    });
    // Mutations from a hook between two submissions of the same frame.
    let fired = false;
    meshes[3]!.onBeforeRender = () => {
      if (fired) return;
      fired = true;
      scene.children.reverse();
      group.name = 'late';
    };
    frame(() => {});
    frame(() => {});
    // A mesh rendered as its own root (a fullscreen quad): no name, no path.
    const quad = new Mesh(box, material);
    renderer.expectedNames = [];
    renderer.render(quad as unknown as Scene, camera);
    expect(ledger.frame({ items: true }).items!.map((i) => ({ name: i.name, reason: i.reason, pass: i.pass }))).toEqual([{ name: '', reason: 'fullscreen-pass', pass: 'fullscreen' }]);
  });
});

/** A shadow-casting directional light, whose `shadow.camera` the ListRenderer renders its map with. */
function shadowLight(name: string): DirectionalLight {
  const light = new DirectionalLight();
  light.name = name;
  light.castShadow = true;
  return light;
}

describe('DrawCallLedger shadow passes on the hot path', () => {
  it('traverses a scene at most once in a frame whose shadow maps render as nested passes, and counts each caster once across them', () => {
    const { scene, camera } = sceneWithCamera();
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    scene.add(...lights);
    for (let i = 0; i < 20; i++) {
      const mesh = tag.static(new Mesh(box, new MeshBasicMaterial()));
      mesh.castShadow = i % 2 === 0;
      scene.add(mesh);
    }
    const renderer = new ListRenderer();
    renderer.shadowLights = lights;
    const ledger = new DrawCallLedger();
    ledger.attach(renderer);
    renderer.render(scene, camera); // the first frame rescans

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['shadow:sun', 'shadow:lamp', 'main']);
    // 10 casters, each drawn into both maps: the per-object frame stamp counts each once, in either pass.
    expect(frame.lighting).toMatchObject({ shadowPasses: 2, shadowCasters: 10, shadowSubmissions: 20 });
    expect(frame.totals.sceneSubmissions).toBe(40);
  });

  it('reads the registry at most once per unique material in a frame whose shadow maps render as nested passes', () => {
    const registry = new MaterialRegistry();
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) => registry.register(new MeshStandardMaterial({ color })));
    const { scene, camera } = sceneWithCamera();
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    scene.add(...lights);
    for (let i = 0; i < 40; i++) {
      const mesh = tag.static(new Mesh(box, materials[i % 4]!));
      mesh.castShadow = true;
      scene.add(mesh);
    }
    const renderer = new ListRenderer();
    renderer.shadowLights = lights;
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer);
    renderer.render(scene, camera); // the first frame rescans

    const keys = vi.spyOn(registry, 'keys');
    renderer.render(scene, camera);
    const reads = keys.mock.calls.length;
    keys.mockRestore();

    const frame = ledger.frame();
    // Every mesh draws in the main pass and in both shadow passes: the memo spans the passes of one frame.
    expect(frame.totals.sceneSubmissions).toBe(40 * 3);
    expect(frame.lighting).toMatchObject({ shadowPasses: 2, shadowCasters: 40 });
    expect(reads).toBeLessThanOrEqual(4);
  });

  it('resolves a drawn material to its registry canonical at most once per unique material, across the passes of a frame', () => {
    const registry = new MaterialRegistry();
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) => registry.register(new MeshStandardMaterial({ color })));
    const { scene, camera } = sceneWithCamera();
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    scene.add(...lights);
    for (let i = 0; i < 40; i++) {
      const mesh = tag.static(new Mesh(box, materials[i % 4]!));
      mesh.castShadow = true;
      scene.add(mesh);
    }
    const renderer = new ListRenderer();
    renderer.shadowLights = lights;
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer);
    renderer.render(scene, camera); // the first frame rescans

    const canonicalOf = vi.spyOn(registry, 'canonicalOf');
    renderer.render(scene, camera);
    const resolves = canonicalOf.mock.calls.length;
    canonicalOf.mockRestore();

    // 120 submissions (40 in the main pass and in each of the two shadow passes) over 4 unique materials: the
    // per-frame index and the shared mark each submission carries cost one resolve per material, not one per draw.
    expect(ledger.frame().totals.sceneSubmissions).toBe(120);
    expect(resolves).toBeLessThanOrEqual(4);
  });
});

describe('DrawCallLedger cost per submission', () => {
  /** Milliseconds per submission of an attached frame (ledger plus ListRenderer), best of 7, over n unnamed meshes directly under the scene. */
  function msPerSubmission(n: number): number {
    const registry = new MaterialRegistry();
    const materials = Array.from({ length: 16 }, (_, i) => registry.register(new MeshStandardMaterial({ color: i * 0x0f0f0f })));
    const { scene, camera } = sceneWithCamera();
    for (let i = 0; i < n; i++) {
      const mesh = new Mesh(box, materials[i % 16]!);
      mesh.castShadow = i % 4 === 0;
      scene.add(i % 2 === 0 ? tag.static(mesh) : tag.dynamic(mesh));
    }
    const renderer = new ListRenderer();
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer);
    for (let i = 0; i < 3; i++) renderer.render(scene, camera); // warm-up, including the first rescan
    let best = Infinity;
    for (let round = 0; round < 7; round++) {
      const start = performance.now();
      renderer.render(scene, camera);
      best = Math.min(best, (performance.now() - start) / n);
    }
    expect(ledger.frame().totals.sceneSubmissions).toBe(n);
    return best;
  }

  it('grows by less than 3x per submission from 2k to 20k submissions (best ratio of 3 interleaved attempts)', () => {
    msPerSubmission(2000); // JIT warm-up
    // `msPerSubmission` is already a best-of-7, but another vitest worker can hold the CPU for the whole of one such
    // call, which is what made a single small-then-large pair fail once under e2e load. Each attempt measures both
    // sizes afresh, so a stall has to land on the fast half of every attempt to matter, and the best ratio is taken.
    // The 3x bound itself is untouched: a real per-submission regression is in every attempt, so the best ratio shows
    // it just as plainly as a single reading would on an idle machine.
    const smalls: number[] = [];
    const larges: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      smalls.push(msPerSubmission(2000));
      larges.push(msPerSubmission(20000));
    }
    // The statistic is best-of-N per size, not the best of the per-attempt ratios. Pairing each large with the small
    // measured beside it lets a stall that inflated that attempt's small *lower* its ratio, and a minimum over ratios
    // would then select exactly that attempt: a false pass under the very load the interleaving exists to survive.
    // (larges [10, 20] with smalls [5, 20]: the best ratio is 1.0, while min/min is 2.0.) Taking each size's own
    // minimum discards a stall in either measurement, and the 3x bound is unchanged.
    const small = Math.min(...smalls);
    const large = Math.min(...larges);
    const readings = `2k ${smalls.map((v) => (v * 1000).toFixed(3)).join('/')} µs -> 20k ${larges.map((v) => (v * 1000).toFixed(3)).join('/')} µs; best ${(small * 1000).toFixed(3)} -> ${(large * 1000).toFixed(3)} = ${(large / small).toFixed(2)}x`;
    expect(large / small, readings).toBeLessThan(3);
  }, 180_000);
});

/**
 * A structural guard, in the spirit of R97: it counts a property of the source rather than timing anything, so it
 * cannot be flaky.
 *
 * The ledger builds a snapshot in `exit()` on every frame, so `skinningOf`, `lightingOf` and `buildFrame` each walk
 * every submission record of every frame. V8 elides the array iterator of a `for…of` over that array only some of the
 * time; when a nearby edit tips it over, each step allocates a 40-byte iterator result. That is not hypothetical:
 * `e568614` *shrank* `lightingOf`'s loop and took the flat 10k scene from 0.80 to 1.20 MB per frame — a 50 %
 * allocation regression that shipped and was documented as the new normal, because nothing counts allocations here
 * and `scripts/ledger-overhead.mjs` is a report, not a gate.
 *
 * Measuring bytes from a unit test would be flaky (GC timing, and other tests share the process), so this asserts the
 * shape the fix depends on instead.
 *
 * Its first version named two files and missed two more walks of the same array (`DrawCallLedger.exit()` and
 * `hintsFor`, which `exit()` calls every frame with that array), so it passed while its claim was false. This version
 * scans every file under `src/ledger/` for an iterator-protocol walk rather than trusting a list, and then checks each
 * walk site that exists is an index loop. It matches the names the record array actually goes by (`items`,
 * `ctx.items`, `this.lastItems`, `state.buffer.items`) with flexible whitespace; it cannot see the array under a name
 * that is not on that list, so renaming it means adding the new name here. Any binding counts, a destructuring pattern
 * included (`for (const { pass } of items)` uses the same protocol), and so do `[...items]`, `Array.from(items)` and
 * `new Set(items)`. `Array.prototype.map`/`forEach` are not flagged: they index internally and allocate no iterator
 * result.
 */
const RECORD_ARRAY = String.raw`(?:ctx\.items|this\.lastItems|state\.buffer\.items|items)\b`;
/** A `for…of` binding: a name, or an object or array destructuring pattern (the same iterator protocol either way). */
const BINDING = String.raw`(?:[\w$]+|\{[^}]*\}|\[[^\]]*\])`;
const ITERATOR_WALK = new RegExp(
  String.raw`for\s*\(\s*(?:const|let|var)\s+` +
    BINDING +
    String.raw`\s+of\s+` +
    RECORD_ARRAY +
    String.raw`|\[\s*\.\.\.\s*` +
    RECORD_ARRAY +
    String.raw`|Array\.from\(\s*` +
    RECORD_ARRAY +
    String.raw`\s*[,)]|new\s+Set\(\s*` +
    RECORD_ARRAY +
    String.raw`\s*\)`,
);
const INDEX_WALK = /for\s*\(\s*let\s+([\w$]+)\s*=\s*0\s*;\s*\1\s*<\s*items\.length\s*;\s*\1\s*\+\+\s*\)/g;
/** The walk sites that exist, and how many index loops over the record array each file must hold. */
const RECORD_WALK_SITES: Record<string, number> = {
  'src/ledger/sections.ts': 2, // skinningOf, lightingOf
  'src/ledger/snapshot.ts': 1, // buildFrame
  'src/ledger/DrawCallLedger.ts': 1, // exit()
  'src/ledger/hints.ts': 1, // hintsFor, called from exit() every frame
};

describe('DrawCallLedger per-frame allocations', () => {
  it('walks the per-frame submission records with no iterator protocol anywhere under src/ledger/', () => {
    const files = (readdirSync('src/ledger', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => `src/ledger/${f}`);
    expect(files.length, 'the scan found the ledger sources').toBeGreaterThan(0);
    for (const file of files) {
      const hit = readFileSync(file, 'utf8').match(ITERATOR_WALK);
      // soft: name every offending file in one run instead of stopping at the first.
      expect.soft(hit?.[0], `${file}: an iterator-protocol walk of the records allocates one iterator result per submission per frame`).toBeUndefined();
    }
  });

  it('flags every iterator-protocol form of a walk of the records, and none of the index-based ones', () => {
    // Each allocates an iterator result per element when V8 stops eliding it (a destructuring binding uses the same
    // protocol as a plain one); `Array.from` and `new Set` iterate their argument the same way.
    const walks = [
      'for (const item of items) {',
      'for (const { pass, reason } of items) {',
      'for (let [k, item] of items.entries()) {',
      'for (var { name } of ctx.items) {',
      'for (const {\n  pass,\n  reason,\n} of this.lastItems) {',
      'for (const [first] of state.buffer.items) {',
      'const copy = [...items];',
      'const copy = Array.from(items);',
      'const names = new Set(ctx.items);',
    ];
    for (const code of walks) expect(ITERATOR_WALK.test(code), code).toBe(true);
    const indexed = ['for (let k = 0; k < items.length; k++) {', 'items.map((i) => i.name)', 'items.forEach((i) => count(i))', 'for (const light of lights) {', 'for (const { pass } of passes) {', 'Array.from(itemsByName)'];
    for (const code of indexed) expect(ITERATOR_WALK.test(code), code).toBe(false);
  });

  it('keeps every known walk of the records an index loop', () => {
    for (const [file, sites] of Object.entries(RECORD_WALK_SITES)) {
      const loops = readFileSync(file, 'utf8').match(INDEX_WALK)?.length ?? 0;
      expect.soft(loops, `${file}: index loops over the record array (see scripts/ledger-overhead.mjs)`).toBeGreaterThanOrEqual(sites);
    }
  });
});

describe('flagsInto', () => {
  /** An array that counts every write to it (elements and `length`). */
  const counted = (): { flags: string[]; writes: () => number } => {
    let writes = 0;
    const flags = new Proxy([] as string[], {
      set(target, key, value) {
        writes++;
        return Reflect.set(target, key, value);
      },
    });
    return { flags, writes: () => writes };
  };

  it('rewrites a pooled record\'s flags in place, writing nothing when they are unchanged: no length = 0 per submission per frame', () => {
    // V8 releases an array's backing store when its length is set to 0, so resetting a flagged record's array and pushing
    // its flags again allocated a new store for every flagged submission of every frame (~40 bytes per submission at the
    // ledger-overhead scenes, where a quarter of the meshes cast shadows and every shadow-pass record is flagged).
    const caster = new Mesh(box, new MeshStandardMaterial({ transparent: true }));
    caster.castShadow = true;
    const { flags, writes } = counted();
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual(['shadow-caster', 'transparent']);
    const first = writes();
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual(['shadow-caster', 'transparent']);
    expect(writes(), 'the same flags again').toBe(first);
    caster.castShadow = false;
    flagsInto(caster, caster.material as Material, 2, flags as never);
    expect(flags).toEqual(['double-sided-transparent', 'transparent']);
    (caster.material as Material).transparent = false;
    caster.renderOrder = 0;
    flagsInto(caster, caster.material as Material, 1, flags as never);
    expect(flags).toEqual([]);
  });
});

describe('reasonOf', () => {
  it('finds the root and the nearest tag in one walk: tags on the object, an ancestor, the root and above the root', () => {
    const material = new MeshStandardMaterial();
    const holder = new Group();
    const scene = new Scene();
    holder.add(scene);
    const group = new Group();
    const mesh = new Mesh(box, material);
    group.add(mesh);
    scene.add(group);
    const reason = (object: Object3D, root: Object3D = scene): string => reasonOf(object, material, null, root, false, undefined);

    expect(reason(mesh)).toBe('untagged');
    tag.dynamic(holder);
    expect(reason(mesh)).toBe('dynamic'); // a tag above the root still counts, as effectiveTag() walks to the top
    tag.static(scene);
    expect(reason(mesh)).toBe('unique-material');
    tag.dynamic(group);
    expect(reason(mesh)).toBe('dynamic');
    tag.static(mesh);
    expect(reason(mesh)).toBe('unique-material');
    expect(reason(mesh, new Scene())).toBe('renderer-internal');
    expect(reason(mesh, group)).toBe('fullscreen-pass');
    const proxy = new Mesh(box, new MeshBasicMaterial({ colorWrite: false }));
    proxy.userData.forge = { kind: 'occlusion-proxy' };
    scene.add(proxy);
    expect(reason(proxy)).toBe('occlusion-proxy');
    expect(reasonOf(mesh, material, null, scene, true, undefined)).toBe('unsupported-material');
    expect(reasonOf(mesh, material, null, scene, false, 'excluded:mirrored')).toBe('excluded:mirrored'); // an annotation wins over tags
  });

  it('walks past a null userData on the drawn object and on an ancestor instead of throwing, and still finds a tag above them', () => {
    const material = new MeshStandardMaterial();
    const scene = new Scene();
    const group = new Group();
    const mesh = new Mesh(box, material);
    group.add(mesh);
    scene.add(group);
    // three fills `userData` on its own constructors, but app code and non-three loaders assign null, and
    // Object3D.copy propagates it to every clone. three renders such a scene without complaint, so both reads
    // reasonOf makes of it — the ancestor walk's tag, and the drawn object's own `forge` kind — must tolerate it.
    (group as { userData: unknown }).userData = null;
    (mesh as { userData: unknown }).userData = null;

    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('untagged');
    // Tagged on the scene, not the mesh: tagging writes into `userData`, which is exactly what is null here.
    tag.static(scene);
    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('unique-material');
    tag.dynamic(scene);
    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('dynamic');
  });
});

describe('DrawCallLedger pooled records', () => {
  it('items from frame({ items: true }) keep their values through later frames, and a read inside a frame sees the last completed one', () => {
    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff, transparent: true });
    const { scene, camera } = sceneWithCamera();
    const a = tag.static(new Mesh(box, red));
    a.name = 'a';
    a.castShadow = true;
    const b = tag.dynamic(new Mesh(box, blue));
    const c = new Mesh(box, red);
    c.name = 'c';
    scene.add(a, b, c);
    const renderer = new FakeRenderer();
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);

    renderer.render(scene, camera);
    const held = ledger.frame({ items: true }).items!;
    const heldJson = JSON.stringify(held);
    expect(held.map((i) => i.name)).toEqual(['a', 'c', 'Mesh[1]', 'Output Color Transform']);

    let inside = '';
    let insideFrame = '';
    const before = JSON.stringify(ledger.frame());
    a.onBeforeRender = () => {
      inside = JSON.stringify(ledger.frame({ items: true }).items);
      insideFrame = JSON.stringify(ledger.frame());
    };
    a.name = 'a2';
    a.castShadow = false;
    scene.remove(c);
    renderer.render(scene, camera);
    expect(inside).toBe(heldJson);
    expect(insideFrame).toBe(before);
    expect(JSON.stringify(held)).toBe(heldJson);
    const second = ledger.frame({ items: true }).items!;
    expect(second.map((i) => [i.name, i.flags])).toEqual([
      ['a2', ['custom-hook']],
      ['Mesh[1]', ['transparent']],
      ['Output Color Transform', []],
    ]);
    const secondJson = JSON.stringify(second);

    // More submissions than any earlier frame, then fewer again.
    a.onBeforeRender = () => {};
    const extra = [0, 1, 2].map((i) => {
      const mesh = new Mesh(box, red);
      mesh.name = `extra${i}`;
      return mesh;
    });
    scene.add(...extra);
    renderer.render(scene, camera);
    expect(ledger.frame().totals.submissions).toBe(6);
    // Frame 3 writes into frame 1's buffer: extra1 reuses the record Mesh[1] filled with ['transparent'] there, so a
    // flag count that shrinks must not leave the old flag behind (`flagsInto` truncates in place).
    expect(ledger.frame({ items: true }).items!.map((i) => [i.name, i.flags])).toEqual([
      ['a2', ['custom-hook']],
      ['extra0', []],
      ['extra1', []],
      ['extra2', []],
      ['Mesh[1]', ['transparent']],
      ['Output Color Transform', []],
    ]);
    scene.remove(...extra, b);
    renderer.render(scene, camera);
    // Frame 4 writes into frame 2's buffer: Output Color Transform reuses the record Mesh[1] filled with ['transparent']
    // there, and a renderer-internal record is cleared rather than passed through `flagsInto` (`begin`).
    expect(ledger.frame({ items: true }).items!.map((i) => [i.name, i.flags])).toEqual([
      ['a2', ['custom-hook']],
      ['Output Color Transform', []],
    ]);
    expect(ledger.frame().totals).toMatchObject({ submissions: 2, sceneSubmissions: 1, unattributed: 0 });
    expect(JSON.stringify(held)).toBe(heldJson);
    expect(JSON.stringify(second)).toBe(secondJson);
  });
});

// ---- nested shadow pass inside a receiver's draw --------------------------------------------------------------------

/** Sees x in about [cx - 20, cx + 20] at the rows' depth. */
function mainCamera(cs: CoordinateSystem, cx = 0): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 200);
  camera.coordinateSystem = cs;
  camera.updateProjectionMatrix();
  camera.position.set(cx, 6, 35);
  camera.lookAt(cx, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function sun(cs: CoordinateSystem): DirectionalLight {
  const light = new DirectionalLight(0xffffff, 1);
  light.name = 'sun';
  light.castShadow = true;
  light.position.set(0, 60, 10);
  light.target.position.set(0, 0, 0);
  const sc = light.shadow.camera;
  sc.coordinateSystem = cs;
  sc.left = -50;
  sc.right = 50;
  sc.top = 20;
  sc.bottom = -20;
  sc.near = 1;
  sc.far = 200;
  sc.updateProjectionMatrix();
  return light;
}

function row(scene: Scene, name: string, z: number, material: Material, receiveShadow: boolean): void {
  for (let i = 0; i < 101; i++) {
    const mesh = new Mesh(box, material);
    mesh.name = `${name}-${i}`;
    mesh.position.set(-100 + 2 * i, 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = receiveShadow;
    scene.add(tag.static(mesh));
  }
}

/**
 * What this rig pins, in CONTRIBUTING.md rule 5's terms. `reportedDrawCalls` used to be a field here and
 * `frame.totals.reportedDrawCalls` was asserted at 5 (webgl2) and 167 (webgpu) — the raw backend draw count rule 5
 * says not to assert on, and redundant besides: `unattributed` is `reportedDrawCalls - gpuDraws` and is asserted to
 * be 0, so pinning `passes[].gpuDraws` pins `reportedDrawCalls` exactly. Keeping the raw number as well only added a
 * second place to edit when a backend changed how it counts a BatchedMesh, with nothing extra guarded.
 */
interface NestedObservation {
  passes: { id: string; submissions: number; gpuDraws: number }[];
  batches: { pass: string; instances: number; instancesDrawn: number; expectedGpuDraws: number }[];
}

/**
 * The rig's second frame (camera moved to x = 90) as the ledger reported it before the restructure, at 63daa89. Items
 * in filing order: the unlit batch's main draw, then the shadow pass the lit batch's draw triggers (both batches, the
 * main prefix zeroed and the shadow camera's rows appended), then the lit batch's main draw, filed once it returns.
 * The first frame (camera at x = 0) drew more of each row, so a count read before a draw would differ. Since Task 31 a
 * shadow batch's `instancesDrawn` counts only its slots with a non-zero count (the 51 cubes the shadow camera sees);
 * 63daa89 reported every slot there (68 and 66, the zeroed main-list slots included), which `expectedGpuDraws` still counts.
 */
const BATCHES: NestedObservation['batches'] = [
  { pass: 'main', instances: 101, instancesDrawn: 17, expectedGpuDraws: 17 },
  { pass: 'shadow:sun', instances: 101, instancesDrawn: 51, expectedGpuDraws: 68 },
  { pass: 'shadow:sun', instances: 101, instancesDrawn: 51, expectedGpuDraws: 66 },
  { pass: 'main', instances: 101, instancesDrawn: 15, expectedGpuDraws: 15 },
];
const NESTED_EXPECTED: Record<'webgl2' | 'webgpu', NestedObservation> = {
  // WEBGL_multi_draw: one call per batch.
  webgl2: {
    passes: [
      { id: 'main', submissions: 3, gpuDraws: 3 },
      { id: 'shadow:sun', submissions: 2, gpuDraws: 2 },
    ],
    batches: BATCHES.map((b) => ({ ...b, expectedGpuDraws: 1 })),
  },
  // One call per slot, zeroed prefix slots included (Info.js counts every slot).
  webgpu: {
    passes: [
      { id: 'main', submissions: 3, gpuDraws: 33 },
      { id: 'shadow:sun', submissions: 2, gpuDraws: 134 },
    ],
    batches: BATCHES,
  },
};

describe('DrawCallLedger reads draw state after renderObject returns', () => {
  for (const backend of ['webgl2', 'webgpu'] as const) {
    it(`attributes a shadow pass that renders inside a receiver's draw, zeroing prefix slots and appending rows (${backend})`, () => {
      const webgpu = backend === 'webgpu';
      const cs = webgpu ? WebGPUCoordinateSystem : WebGLCoordinateSystem;
      const scene = new Scene();
      const light = sun(cs);
      scene.add(light, light.target);
      row(scene, 'unlit', -3, new MeshBasicMaterial(), false);
      row(scene, 'lit', 3, new MeshStandardMaterial({ roughness: 0.8 }), true);
      scene.updateMatrixWorld(true);
      const ledger = new DrawCallLedger();
      const world = new World(scene, { instanceThreshold: 1000, ledger });
      world.compile({ coordinateSystem: cs });
      const renderer = new FakeRenderer({ webgpu, sceneHooks: true, shadowTrigger: 'first-receiver', record: true, shadowLights: [light] });
      ledger.attach(renderer as never);
      renderer.render(scene, mainCamera(cs));
      // The camera moves to the end of the rows, where fewer cubes are in view: a count read before a draw would still
      // be the last frame's.
      renderer.render(scene, mainCamera(cs, 90));

      const frame = ledger.frame({ items: true });
      const items = frame.items!;
      const isBatch = (object: object): boolean => (object as { isBatchedMesh?: boolean }).isBatchedMesh === true;
      // Nothing the ledger costed is missing from what the backend reported, which is also what ties the pinned
      // `passes[].gpuDraws` below to the renderer's own count without asserting that raw count itself (rule 5).
      expect(frame.totals.unattributed).toBe(0);
      // Every batched submission lines up with the draw the fake issued for it, pass by pass, in order. The link is
      // the drawn instances -- the slots with a non-zero count, in every pass (the shadow pass zeroes main-list
      // slots) -- not the backend's draw count: `expectedGpuDraws` is pinned per item by BATCHES below, and pinning
      // it again against `d.drawCalls` restated the same numbers in backend terms.
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter((d) => isBatch(d.object)));
        const batchItems = items.filter((i) => i.kind === 'batched' && i.pass.startsWith('shadow:') === (kind === 'shadow'));
        expect(draws.length, `${backend} ${kind}: batch draws`).toBe(2);
        expect(batchItems.map((i) => i.instancesDrawn), `${backend} ${kind}: instances drawn`).toEqual(draws.map((d) => d.batchIds!.length));
      }
      const observed: NestedObservation = {
        passes: frame.passes,
        batches: items.filter((i) => i.kind === 'batched').map(({ pass, instances, instancesDrawn, expectedGpuDraws }) => ({ pass, instances, instancesDrawn, expectedGpuDraws })),
      };
      expect(observed).toEqual(NESTED_EXPECTED[backend]);
    });
  }
});
