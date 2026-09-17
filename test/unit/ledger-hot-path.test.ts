/**
 * The ledger's per-submission hot path, guarded by counts rather than timings: registry reads per frame bounded by
 * unique materials (`keys()` memoized per frame, `describe()` never called, current across `registry.invalidate()`),
 * at most one scene walk per frame without a rescan, no `children.indexOf` for display names, draw state read after
 * `renderObject` returns (a shadow pass nested inside a receiver's draw is attributed exactly), pooled records that
 * never leak, and each caster marked once across the shadow maps of a frame. The wall-clock figures live in
 * `scripts/ledger-overhead.mjs`.
 *
 * The FakeRenderer walks the scene with a plain loop, never `Object3D.traverse`, so the traversals counted below are the
 * ledger's own. It renders into an app target here, so no output quad joins the scene's own submissions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  BoxGeometry,
  type CoordinateSystem,
  DirectionalLight,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PointLight,
  RenderTarget,
  Scene,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { DrawCallLedger, type DrawCallLedgerOptions } from '../../src/ledger/DrawCallLedger.js';
import { displayName } from '../../src/ledger/reasons.js';
import { tag } from '../../src/tags.js';
import { FakeRenderer, type FakeRendererOptions, sceneWithCamera } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';

const box = new BoxGeometry(1, 1, 1);

/** A ledger on a fake that renders into an app target, as a post-processing frame does: every submission is the scene's own. */
function attached(renderer: FakeRendererOptions = {}, ledger: Omit<DrawCallLedgerOptions, 'registry'> = {}) {
  const rig = attachedLedger(renderer, ledger);
  rig.renderer.setRenderTarget(new RenderTarget(4, 4));
  return rig;
}

/**
 * Records, in the order the ledger files items, the name `displayName()` gives each object right before its
 * `renderObject` call (the instant the ledger names it): pushed once the call returns, so a pass nested inside the call
 * files its items first. Wraps the ledger's own wrapper, so install it after `attach()`.
 */
function recordNames(renderer: FakeRenderer): string[] {
  const names: string[] = [];
  const inner = renderer.renderObject;
  renderer.renderObject = function (this: FakeRenderer, ...args: Parameters<FakeRenderer['renderObject']>) {
    const name = displayName(args[0], args[1]);
    inner.apply(this, args);
    names.push(name);
  };
  return names;
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
    const { renderer, registry, ledger, scene, camera } = attached();
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) =>
      registry.register(new MeshStandardMaterial({ color })),
    );
    for (let i = 0; i < 40; i++) scene.add(tag.static(new Mesh(box, materials[i % 4]!)));
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
    const { renderer, registry, ledger, scene, camera } = attached();
    const shared = new MeshStandardMaterial({ color: 0x336699 });
    registry.register(shared);
    const meshes = [0, 1, 2, 3].map((i) => {
      const mesh = tag.static(new Mesh(box, shared));
      mesh.name = `a${i}`;
      scene.add(mesh);
      return mesh;
    });
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
    expect(programs[d2.programHash]).toEqual({
      type: 'MeshStandardMaterial',
      description: d2.description,
      submissions: 2,
    });
    expect(programs[d3.programHash]).toEqual({
      type: 'MeshStandardMaterial',
      description: d3.description,
      submissions: 2,
    });
  });
});

describe('DrawCallLedger scene walks', () => {
  it('traverses a scene at most once on a frame without a rescan', () => {
    const { renderer, ledger, scene, camera } = attached();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.name = 'sun';
    sun.castShadow = true;
    scene.add(sun);
    for (let i = 0; i < 20; i++) scene.add(tag.static(new Mesh(box, new MeshBasicMaterial())));
    renderer.render(scene, camera); // the first frame rescans

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    expect(ledger.frame().totals.sceneSubmissions).toBe(20);
    expect(ledger.frame().lighting).toMatchObject({ lights: { directional: 1 }, shadowLights: 1 });
  });

  it('reads the lights three projected from the first scene submission, once per frame, without another walk', () => {
    const renderer = new FakeRenderer();
    renderer.setRenderTarget(new RenderTarget(4, 4));
    const { scene, camera } = sceneWithCamera();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.castShadow = true;
    scene.add(sun);
    // In the graph but not in the render list: three (and the fake) skip a light on a layer the camera does not test.
    // The section must come from the lights node, not from a walk of the graph.
    const hidden = new PointLight();
    hidden.layers.set(1);
    scene.add(hidden);
    for (let i = 0; i < 20; i++) scene.add(tag.static(new Mesh(box, new MeshBasicMaterial())));
    const getLights = vi.spyOn(renderer.lighting.getNode(scene), 'getLights');
    renderer.render(scene, camera); // detached: the fake's own reads of its lights node per frame
    const own = getLights.mock.calls.length;
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    renderer.render(scene, camera); // the first frame rescans
    getLights.mockClear();

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    expect(getLights.mock.calls.length - own).toBe(1);
    expect(ledger.frame().lighting).toMatchObject({ lights: { directional: 1, point: 0 }, shadowLights: 1 });
  });

  it('never calls children.indexOf for display names, in frames or rescans, and names match displayName()', () => {
    const { renderer, ledger, scene, camera } = attached();
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
    scene.add(
      new Mesh(box, new MeshBasicMaterial()),
      named,
      zone,
      loose,
      tag.static(new Mesh(box, new MeshBasicMaterial())),
    );
    const childArrays = new Set<unknown>();
    scene.traverse((o) => childArrays.add(o.children));

    const calls = countIndexOf(childArrays, () => {
      renderer.render(scene, camera); // includes the first rescan
      renderer.render(scene, camera);
      ledger.rescan();
    });

    expect(calls).toBe(0);
    const names = ledger.frame({ items: true }).items!.map((i) => i.name);
    expect(names).toEqual([
      'Mesh[1]',
      'crate',
      'zone/Mesh[0]',
      'zone/Group[1]/Mesh[0]',
      'zone/Group[1]/Mesh[1]',
      'Group[4]/Mesh[0]',
      'Mesh[5]',
    ]);
    // The reference, outside the counted calls (displayName() itself uses indexOf).
    const expected = recordNames(renderer);
    renderer.render(scene, camera);
    expect(expected).toEqual(names);
    expect(ledger.frame().hints.find((h) => h.code === 'static-auto-update')?.objects).toEqual([
      'zone/Group[1]/Mesh[1]',
      'Group[4]/Mesh[0]',
      'Mesh[5]',
    ]);
  });

  it('keeps names current through renames, sibling reorders, reparenting, removal and mutations inside a frame', () => {
    const { renderer, ledger, scene, camera } = attached();
    const material = new MeshBasicMaterial();
    const zone = new Group();
    zone.name = 'zone';
    const group = new Group();
    const meshes = Array.from({ length: 6 }, () => new Mesh(box, material));
    group.add(meshes[0]!, meshes[1]!, meshes[2]!);
    zone.add(group, meshes[3]!);
    scene.add(zone, meshes[4]!, meshes[5]!);
    // An unnamed object rendered with the scene as root but outside it, as three's own quads are: drawn after the
    // scene's list from its onAfterRender, through the renderer's (ledger-patched) renderObject.
    const outside = new Group().add(new Mesh(box, material), new Mesh(box, material));
    const internal = outside.children[1] as Mesh;
    scene.onAfterRender = (r, s, c) => {
      (r as unknown as FakeRenderer).renderObject(
        internal,
        s,
        c,
        internal.geometry,
        internal.material as Material,
        null,
        null,
      );
    };
    // A second scene rendered from a hook.
    const portal = new Scene();
    const portalGroup = new Group().add(new Mesh(box, material));
    portal.add(new Mesh(box, material), portalGroup);
    meshes[5]!.onBeforeRender = (r) => {
      (r as unknown as FakeRenderer).render(portal, camera);
    };
    const expected = recordNames(renderer);
    const frame = (mutate: () => void): void => {
      mutate();
      expected.length = 0;
      renderer.render(scene, camera);
      expect(ledger.frame({ items: true }).items!.map((i) => i.name)).toEqual(expected);
    };

    frame(() => {});
    expect(expected).toContain('zone/Group[0]/Mesh[1]');
    expect(expected).toContain('Group[0]/Mesh[1]'); // outside the scene: the path runs to its top
    expect(expected).toContain('Group[1]/Mesh[0]'); // portal pass, portal scene as root
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
    renderer.render(quad, camera);
    expect(ledger.frame({ items: true }).items!.map((i) => ({ name: i.name, reason: i.reason, pass: i.pass }))).toEqual(
      [{ name: '', reason: 'fullscreen-pass', pass: 'fullscreen' }],
    );
  });
});

/** A shadow-casting directional light, whose `shadow.camera` the fake renders its map with. */
function shadowLight(name: string): DirectionalLight {
  const light = new DirectionalLight();
  light.name = name;
  light.castShadow = true;
  return light;
}

describe('DrawCallLedger shadow passes on the hot path', () => {
  it('traverses a scene at most once in a frame whose shadow maps render as nested passes, and counts each caster once across them', () => {
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    const { renderer, ledger, scene, camera } = attached({ shadowLights: lights });
    scene.add(...lights);
    for (let i = 0; i < 20; i++) {
      const mesh = tag.static(new Mesh(box, new MeshBasicMaterial()));
      mesh.castShadow = i % 2 === 0;
      scene.add(mesh);
    }
    renderer.render(scene, camera); // the first frame rescans

    expect(countTraversals(() => renderer.render(scene, camera))).toBeLessThanOrEqual(1);
    const frame = ledger.frame();
    expect(frame.passes.map((p) => p.id)).toEqual(['shadow:sun', 'shadow:lamp', 'main']);
    // 10 casters, each drawn into both maps: the per-object frame stamp counts each once, in either pass.
    expect(frame.lighting).toMatchObject({ shadowPasses: 2, shadowCasters: 10, shadowSubmissions: 20 });
    expect(frame.totals.sceneSubmissions).toBe(40);
  });

  it('reads the registry at most once per unique material in a frame whose shadow maps render as nested passes', () => {
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    const { renderer, registry, ledger, scene, camera } = attached({ shadowLights: lights });
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) =>
      registry.register(new MeshStandardMaterial({ color })),
    );
    scene.add(...lights);
    for (let i = 0; i < 40; i++) {
      const mesh = tag.static(new Mesh(box, materials[i % 4]!));
      mesh.castShadow = true;
      scene.add(mesh);
    }
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
    const lights = [shadowLight('sun'), shadowLight('lamp')];
    const { renderer, registry, ledger, scene, camera } = attached({ shadowLights: lights });
    const materials = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00].map((color) =>
      registry.register(new MeshStandardMaterial({ color })),
    );
    scene.add(...lights);
    for (let i = 0; i < 40; i++) {
      const mesh = tag.static(new Mesh(box, materials[i % 4]!));
      mesh.castShadow = true;
      scene.add(mesh);
    }
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

/**
 * A structural guard: it counts a property of the source rather than timing anything, so it cannot be flaky.
 *
 * The ledger builds a snapshot in `exit()` on every frame, so `skinningOf`, `lightingOf` and `buildFrame` each walk
 * every submission record of every frame. V8 elides the array iterator of a `for…of` over that array only some of the
 * time; when a nearby edit tips it over, each step allocates a 40-byte iterator result. Shrinking one such loop once
 * took the flat 10k scene from 0.80 to 1.20 MB per frame — a 50 % allocation regression — because nothing counted
 * allocations here and `scripts/ledger-overhead.mjs` is a report, not a gate.
 *
 * Measuring bytes from a unit test would be flaky (GC timing, and other tests share the process), so this asserts the
 * shape the fix depends on instead: it scans every file under `src/ledger/` for an iterator-protocol walk of the
 * record array rather than trusting a list of files, and then checks each walk site that exists is an index loop. It
 * matches the names the record array actually goes by (`items`, `ctx.items`, `this.lastItems`, `state.buffer.items`)
 * with flexible whitespace; it cannot see the array under a name that is not on that list, so renaming it means adding
 * the new name here. Any binding counts, a destructuring pattern included (`for (const { pass } of items)` uses the
 * same protocol), and so do `[...items]`, `Array.from(items)` and `new Set(items)`. `Array.prototype.map`/`forEach`
 * are not flagged: they index internally and allocate no iterator result.
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
    const files = (readdirSync('src/ledger', { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/ledger/${f}`);
    expect(files.length, 'the scan found the ledger sources').toBeGreaterThan(0);
    for (const file of files) {
      const hit = readFileSync(file, 'utf8').match(ITERATOR_WALK);
      // soft: name every offending file in one run instead of stopping at the first.
      expect
        .soft(
          hit?.[0],
          `${file}: an iterator-protocol walk of the records allocates one iterator result per submission per frame`,
        )
        .toBeUndefined();
    }
  });

  it('keeps every known walk of the records an index loop', () => {
    for (const [file, sites] of Object.entries(RECORD_WALK_SITES)) {
      const loops = readFileSync(file, 'utf8').match(INDEX_WALK)?.length ?? 0;
      expect
        .soft(loops, `${file}: index loops over the record array (see scripts/ledger-overhead.mjs)`)
        .toBeGreaterThanOrEqual(sites);
    }
  });
});

describe('DrawCallLedger pooled records', () => {
  it('items from frame({ items: true }) keep their values through later frames, and a read inside a frame sees the last completed one', () => {
    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff, transparent: true });
    const { renderer, ledger, scene, camera } = attachedLedger();
    const a = tag.static(new Mesh(box, red));
    a.name = 'a';
    a.castShadow = true;
    const b = tag.dynamic(new Mesh(box, blue));
    const c = new Mesh(box, red);
    c.name = 'c';
    scene.add(a, b, c);

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
 * The rig's second frame (camera moved to x = 90) as the ledger reported it before the restructure. Items
 * in filing order: the unlit batch's main draw, then the shadow pass the lit batch's draw triggers (both batches, the
 * main prefix zeroed and the shadow camera's rows appended), then the lit batch's main draw, filed once it returns.
 * The first frame (camera at x = 0) drew more of each row, so a count read before a draw would differ. Now a
 * shadow batch's `instancesDrawn` counts only its slots with a non-zero count (the 51 cubes the shadow camera sees);
 * the old ledger reported every slot there (68 and 66, the zeroed main-list slots included), which `expectedGpuDraws` still counts.
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
      const renderer = new FakeRenderer({
        webgpu,
        sceneHooks: true,
        shadowTrigger: 'first-receiver',
        record: true,
        shadowLights: [light],
      });
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
        const draws = renderer.passes
          .filter((p) => p.kind === kind)
          .flatMap((p) => p.draws.filter((d) => isBatch(d.object)));
        const batchItems = items.filter(
          (i) => i.kind === 'batched' && i.pass.startsWith('shadow:') === (kind === 'shadow'),
        );
        expect(draws.length, `${backend} ${kind}: batch draws`).toBe(2);
        expect(
          batchItems.map((i) => i.instancesDrawn),
          `${backend} ${kind}: instances drawn`,
        ).toEqual(draws.map((d) => d.batchIds!.length));
      }
      const observed: NestedObservation = {
        passes: frame.passes,
        batches: items
          .filter((i) => i.kind === 'batched')
          .map(({ pass, instances, instancesDrawn, expectedGpuDraws }) => ({
            pass,
            instances,
            instancesDrawn,
            expectedGpuDraws,
          })),
      };
      expect(observed).toEqual(NESTED_EXPECTED[backend]);
    });
  }
});
