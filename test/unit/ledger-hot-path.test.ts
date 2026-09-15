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
 *
 * `ListRenderer` stands in for three where a test must count the ledger's own traversals: it walks the scene with a
 * plain loop instead of `Object3D.traverse`.
 */
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
import { displayName, reasonOf } from '../../src/ledger/reasons.js';
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

  render(scene: Scene, camera: Camera): unknown {
    const draw = (object: Object3D, lightsNode: { getLights(): Light[] } | null): void => {
      const name = this.expectNames ? displayName(object, scene) : '';
      const mesh = object as Mesh;
      this.renderObject(object, scene, camera, mesh.geometry, mesh.material, null, lightsNode, null, null);
      if (this.expectNames) this.expectedNames.push(name);
    };
    const visit = (object: Object3D): void => {
      if (!object.visible) return;
      if ((object as Mesh).isMesh) draw(object, this.lightsNode);
      const children = object.children;
      for (let i = 0; i < children.length; i++) visit(children[i]!);
    };
    visit(scene);
    if (scene.isScene) for (const object of this.internal) draw(object, null);
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

  it('grows by less than 3x per submission from 2k to 20k submissions (best of 7)', () => {
    msPerSubmission(2000); // JIT warm-up
    const small = msPerSubmission(2000);
    const large = msPerSubmission(20000);
    expect(large / small, `${(small * 1000).toFixed(3)} µs at 2k, ${(large * 1000).toFixed(3)} µs at 20k`).toBeLessThan(3);
  }, 60_000);
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

  it('walks past an ancestor whose userData is null instead of throwing, and still finds a tag above it', () => {
    const material = new MeshStandardMaterial();
    const scene = new Scene();
    const group = new Group();
    const mesh = new Mesh(box, material);
    group.add(mesh);
    scene.add(group);
    // three fills `userData` on its own constructors, but a loader, a clone of a hand-built object or app code can
    // leave it null on an ancestor; the walk reads the key off it for every ancestor, so it must tolerate one.
    (group as { userData: unknown }).userData = null;

    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('untagged');
    tag.static(scene);
    expect(reasonOf(mesh, material, null, scene, false, undefined)).toBe('unique-material');
    tag.dynamic(mesh);
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
    expect(ledger.frame({ items: true }).items!.map((i) => i.name)).toEqual(['a2', 'extra0', 'extra1', 'extra2', 'Mesh[1]', 'Output Color Transform']);
    scene.remove(...extra, b);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items!.map((i) => i.name)).toEqual(['a2', 'Output Color Transform']);
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

interface NestedObservation {
  passes: { id: string; submissions: number; gpuDraws: number }[];
  reportedDrawCalls: number;
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
    reportedDrawCalls: 5,
    batches: BATCHES.map((b) => ({ ...b, expectedGpuDraws: 1 })),
  },
  // One call per slot, zeroed prefix slots included (Info.js counts every slot).
  webgpu: {
    passes: [
      { id: 'main', submissions: 3, gpuDraws: 33 },
      { id: 'shadow:sun', submissions: 2, gpuDraws: 134 },
    ],
    reportedDrawCalls: 167,
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
      expect(frame.totals.unattributed).toBe(0);
      // Every batched submission predicts the draw calls the fake issued for it, pass by pass, in order.
      for (const kind of ['render', 'shadow'] as const) {
        const draws = renderer.passes.filter((p) => p.kind === kind).flatMap((p) => p.draws.filter((d) => isBatch(d.object)));
        const batchItems = items.filter((i) => i.kind === 'batched' && i.pass.startsWith('shadow:') === (kind === 'shadow'));
        expect(draws.length, `${backend} ${kind}: batch draws`).toBe(2);
        expect(batchItems.map((i) => i.expectedGpuDraws), `${backend} ${kind}: draw calls`).toEqual(draws.map((d) => d.drawCalls));
        // Drawn instances are the slots with a non-zero count, in every pass (the shadow pass zeroes main-list slots).
        expect(batchItems.map((i) => i.instancesDrawn), `${backend} ${kind}: instances drawn`).toEqual(draws.map((d) => d.batchIds!.length));
      }
      const observed: NestedObservation = {
        passes: frame.passes,
        reportedDrawCalls: frame.totals.reportedDrawCalls,
        batches: items.filter((i) => i.kind === 'batched').map(({ pass, instances, instancesDrawn, expectedGpuDraws }) => ({ pass, instances, instancesDrawn, expectedGpuDraws })),
      };
      expect(observed).toEqual(NESTED_EXPECTED[backend]);
    });
  }
});
