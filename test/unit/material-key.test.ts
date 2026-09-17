import * as THREE from 'three';
import {
  BoxGeometry,
  DataTexture,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Plane,
  RGBAFormat,
  Scene,
  Vector3,
} from 'three';
import * as WEBGPU from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import * as materialKeyModule from '../../src/registry/materialKey.js';
import { tag } from '../../src/tags.js';

function texture(): DataTexture {
  const t = new DataTexture(new Uint8Array(4 * 4), 2, 2, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/*
 * Material code and user-added own properties. Every factory below returns a new function (or class) with
 * the same source text on every call: only the captured `tint` differs, which `toString()` cannot see.
 */
function makeSetupOutput(tint: number) {
  return function (this: MeshStandardNodeMaterial, ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>) {
    void tint;
    return MeshStandardNodeMaterial.prototype.setupOutput.apply(this, args);
  };
}
function makeOnBeforeCompile(tint: number) {
  return (shader: { fragmentShader: string }): void => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>\ngl_FragColor.rgb *= ${tint.toFixed(3)};`,
    );
  };
}
function makeCustomProgramCacheKey(tint: number) {
  return (): string => {
    void tint;
    return 'tinted';
  };
}
function makeOnBeforeRender(tint: number) {
  return (): void => {
    void tint;
  };
}
function makeHookedClass(tint: number) {
  return class HookedMaterial extends MeshStandardMaterial {
    override onBeforeCompile(shader: { fragmentShader: string }): void {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>\ngl_FragColor.rgb *= ${tint.toFixed(3)};`,
      );
    }
  };
}
function makeCacheKeyClass(tint: number) {
  return class CacheKeyMaterial extends MeshStandardMaterial {
    override customProgramCacheKey(): string {
      void tint;
      return 'tinted';
    }
  };
}

interface CodeCase {
  /** A new function or class per call, same source text, different captured value. */
  code: (tint: number) => unknown;
  /** A material running `code`, otherwise a fresh default material. */
  make: (code: unknown) => Material;
  /** The key the code joins: `program` when three builds the shader from it, `variant` when it runs per draw. */
  level: 'program' | 'variant';
}
const CODE_CASES: Array<[string, CodeCase]> = [
  [
    'an instance setupOutput on a MeshStandardNodeMaterial',
    {
      level: 'program',
      code: makeSetupOutput,
      make: (code) =>
        Object.assign(new MeshStandardNodeMaterial(), { setupOutput: code as ReturnType<typeof makeSetupOutput> }),
    },
  ],
  [
    'an instance onBeforeCompile closure on a MeshStandardMaterial',
    {
      level: 'program',
      code: makeOnBeforeCompile,
      make: (code) =>
        Object.assign(new MeshStandardMaterial(), { onBeforeCompile: code as ReturnType<typeof makeOnBeforeCompile> }),
    },
  ],
  [
    'an instance customProgramCacheKey on a MeshStandardMaterial',
    {
      level: 'program',
      code: makeCustomProgramCacheKey,
      make: (code) =>
        Object.assign(new MeshStandardMaterial(), {
          customProgramCacheKey: code as ReturnType<typeof makeCustomProgramCacheKey>,
        }),
    },
  ],
  [
    'an instance onBeforeRender on a MeshStandardMaterial',
    {
      level: 'variant',
      code: makeOnBeforeRender,
      make: (code) =>
        Object.assign(new MeshStandardMaterial(), { onBeforeRender: code as ReturnType<typeof makeOnBeforeRender> }),
    },
  ],
  [
    'an onBeforeCompile declared on a subclass prototype (a class factory)',
    { level: 'program', code: makeHookedClass, make: (code) => new (code as ReturnType<typeof makeHookedClass>)() },
  ],
  [
    'a customProgramCacheKey declared on a subclass prototype (a class factory)',
    { level: 'program', code: makeCacheKeyClass, make: (code) => new (code as ReturnType<typeof makeCacheKeyClass>)() },
  ],
];

describe('material keys include material code by identity, not by source text', () => {
  it.each(CODE_CASES)(
    '%s: different function objects with identical source text do not merge',
    (_name, { code, make, level }) => {
      const first = code(1);
      const second = code(2);
      expect(String(second)).toBe(String(first)); // toString() cannot tell them apart
      const registry = new MaterialRegistry();
      const a = make(first);
      const b = make(second);
      expect(registry.register(a)).toBe(a);
      expect(registry.register(b)).not.toBe(a);
      if (level === 'program') {
        // Code three builds the shader from joins the program key, so the variant key differs too.
        expect(registry.describe(b).programHash).not.toBe(registry.describe(a).programHash);
        expect(registry.describe(b).outcome).toBe('shader-variant');
      } else {
        // A material's `onBeforeRender` runs per draw (WebGLRenderer) or never (WebGPU's renderer calls only the
        // object's): the same program, another variant.
        expect(registry.describe(b).programHash).toBe(registry.describe(a).programHash);
        expect(registry.describe(b).variantHash).not.toBe(registry.describe(a).variantHash);
        expect(registry.describe(b).outcome).toBe('uniform-variant');
      }
    },
  );

  it('invalidate() after replacing an instance function re-keys the material', () => {
    const first = makeSetupOutput(1);
    const second = makeSetupOutput(2);
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardNodeMaterial(), { setupOutput: first });
    expect(registry.register(a)).toBe(a);
    const before = registry.describe(a).programHash;
    a.setupOutput = second;
    registry.invalidate(a);
    expect(registry.describe(a).programHash).not.toBe(before);
    expect(registry.register(Object.assign(new MeshStandardNodeMaterial(), { setupOutput: second }))).toBe(a);
    expect(registry.register(Object.assign(new MeshStandardNodeMaterial(), { setupOutput: first }))).not.toBe(a);
  });

  it.each(CODE_CASES)('%s: materials sharing the same function object still merge', (_name, { code, make }) => {
    const shared = code(1);
    const registry = new MaterialRegistry();
    const a = make(shared);
    const b = make(shared);
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
    expect(registry.describe(b).variantHash).toBe(registry.describe(a).variantHash);
  });

  it('keys a function held inside a user-added own property by identity', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: { tint: makeOnBeforeRender(1) } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { tint: makeOnBeforeRender(2) } });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
  });

  it('three tinted node materials, one with a different setupOutput, compile to separate groups', () => {
    const shared = makeSetupOutput(1);
    const other = makeSetupOutput(2);
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const tints = [0xff0000, 0x00ff00, 0x0000ff];
    const meshes = tints.map((color, i) => {
      const mesh = tag.static(
        new Mesh(
          geometry,
          Object.assign(new MeshStandardNodeMaterial({ color }), { setupOutput: i === 2 ? other : shared }),
        ),
      );
      mesh.position.x = i * 2;
      scene.add(mesh);
      return mesh;
    });
    scene.updateMatrixWorld(true);
    const world = new World(scene);
    const report = world.compile();
    // The two sharing `shared` batch together; the third is a group of its own (one mesh, left drawing itself).
    expect(report.groups.map((g) => g.instances)).toEqual([2]);
    expect((world.batchedMeshes[0]!.material as MeshStandardNodeMaterial).setupOutput).toBe(shared);
    expect(report.registry.programs).toBe(2);
    // The third mesh draws with `other`: its material (the registry's canonical, under the default `unbatched: 'canonical'`) runs it.
    const third = meshes[2]!.material as MeshStandardNodeMaterial;
    expect(third.setupOutput).toBe(other);
    expect((world.registry.canonicalOf(third) as MeshStandardNodeMaterial).setupOutput).toBe(other);
  });
});

describe('material keys for user-added own properties', () => {
  it.each([
    [
      'a plain object that references itself',
      () => {
        const extra: Record<string, unknown> = { tint: 1 };
        extra.self = extra;
        return extra;
      },
    ],
    [
      'an array that contains itself',
      () => {
        const list: unknown[] = [1];
        list.push(list);
        return { list };
      },
    ],
    [
      'an Object3D in a scene graph (parent and children reference each other)',
      () => {
        const scene = new Scene();
        const target = new Object3D();
        scene.add(target);
        return { target };
      },
    ],
  ])('a material whose own property holds %s registers without throwing', (_name, extra) => {
    const value = extra();
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: value });
    const b = Object.assign(new MeshStandardMaterial(), { extra: value });
    expect(() => registry.register(a)).not.toThrow();
    expect(registry.register(b)).toBe(a);
  });

  it('merges materials whose own `extra` objects are different identities holding deep-equal plain data', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), {
      extra: { uTint: [1, 0.5, 0], mode: 'warm', nested: { on: true } },
    });
    const b = Object.assign(new MeshStandardMaterial(), {
      extra: { nested: { on: true }, mode: 'warm', uTint: [1, 0.5, 0] },
    });
    const c = Object.assign(new MeshStandardMaterial(), {
      extra: { nested: { on: false }, mode: 'warm', uTint: [1, 0.5, 0] },
    });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
    expect(registry.register(c)).not.toBe(a);
  });

  it.each([
    [
      'a distinct texture with the same uuid and content does not merge',
      // A clone with the original's uuid: what ObjectLoader does when it parses the same JSON twice.
      (map: DataTexture) => Object.assign(map.clone(), { uuid: map.uuid }),
      false,
    ],
    ['the same texture object in different `extra` objects merges', (map: DataTexture) => map, true],
  ])('keys a Texture inside an own property by identity: %s', (_label, second, merges) => {
    const map = texture();
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: { map } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { map: second(map) } });
    expect(registry.register(a)).toBe(a);
    if (merges) expect(registry.register(b)).toBe(a);
    else expect(registry.register(b)).not.toBe(a);
  });

  it('ignores EventDispatcher listeners: materials with different dispose listeners merge', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial();
    const b = new MeshStandardMaterial();
    a.addEventListener('dispose', () => {});
    b.addEventListener('dispose', () => {});
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
  });

  it('ignores EventDispatcher listeners: a material a renderer has drawn (a dispose listener) merges with an undrawn twin', () => {
    const registry = new MaterialRegistry();
    const drawn = new MeshStandardMaterial();
    drawn.addEventListener('dispose', () => {});
    expect(registry.register(drawn)).toBe(drawn);
    expect(registry.register(new MeshStandardMaterial())).toBe(drawn);
  });
});

/*
 * Subclasses, array properties and BigInt.
 */
class GlowMaterial extends MeshStandardNodeMaterial {
  override setupOutput(
    ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>
  ): ReturnType<MeshStandardNodeMaterial['setupOutput']> {
    return super.setupOutput(...args);
  }
}
class PulseMaterial extends MeshStandardNodeMaterial {
  override setupOutput(
    ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>
  ): ReturnType<MeshStandardNodeMaterial['setupOutput']> {
    const output = super.setupOutput(...args);
    return output;
  }
}
let blinks = 0;
class BlinkMaterial extends MeshStandardMaterial {
  override onBeforeRender(): void {
    blinks++;
  }
}

describe('material keys include a subclass by identity', () => {
  it('a node subclass overriding setupOutput does not merge with its base class', () => {
    const registry = new MaterialRegistry();
    const base = new MeshStandardNodeMaterial();
    const glow = new GlowMaterial();
    expect(glow.type).toBe(base.type); // `type` is inherited: it cannot tell them apart
    expect(registry.register(base)).toBe(base);
    expect(registry.register(glow)).not.toBe(base);
  });

  it('a classic subclass overriding onBeforeRender does not merge with its base class', () => {
    const registry = new MaterialRegistry();
    const base = new MeshStandardMaterial();
    const blink = new BlinkMaterial();
    expect(blink.type).toBe(base.type); // `type` is inherited, and the instances hold the same own properties
    expect(blinks).toBe(0);
    expect(registry.register(base)).toBe(base);
    expect(registry.register(blink)).not.toBe(base);
  });

  it.each([
    [
      'two node subclasses overriding setupOutput differently do not merge with each other',
      () => new PulseMaterial(),
      false,
    ],
    ['two instances of the same subclass still merge', () => new GlowMaterial(), true],
  ])('%s', (_label, other, merges) => {
    const registry = new MaterialRegistry();
    const glow = new GlowMaterial();
    const b = other();
    expect(registry.register(glow)).toBe(glow);
    if (merges) expect(registry.register(b)).toBe(glow);
    else expect(registry.register(b)).not.toBe(glow);
  });

  it("three's own material classes add no identity to their keys", () => {
    for (const namespace of [THREE, WEBGPU] as unknown as Array<Record<string, unknown>>) {
      for (const [name, value] of Object.entries(namespace)) {
        if (typeof value !== 'function' || !name.endsWith('Material')) continue;
        let material: Material;
        try {
          material = new (value as new () => Material)();
        } catch {
          continue;
        }
        if (material.isMaterial !== true) continue;
        expect(materialKeyModule.computeMaterialKeys(material).programKey, name).not.toContain('#');
      }
    }
  });
});

describe('material keys for array properties', () => {
  it('two materials with one clipping plane each, but different planes, do not merge', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(1, 0, 0), 0)] });
    const b = new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(0, 1, 0), 2)] });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
    // The plane count changes the shader; the plane values are uniforms.
    expect(registry.describe(b).programHash).toBe(registry.describe(a).programHash);
    expect(registry.describe(b).variantHash).not.toBe(registry.describe(a).variantHash);
  });

  it('two materials with identical clipping planes (different Plane objects) still merge', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(1, 0, 0), 0.5)] });
    const b = new MeshStandardMaterial({ clippingPlanes: [new Plane(new Vector3(1, 0, 0), 0.5)] });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
  });

  it('a different number of clipping planes is a different program', () => {
    const registry = new MaterialRegistry();
    const plane = new Plane(new Vector3(1, 0, 0), 0);
    const one = registry.register(new MeshStandardMaterial({ clippingPlanes: [plane] }));
    const two = registry.register(new MeshStandardMaterial({ clippingPlanes: [plane, plane] }));
    expect(registry.describe(two).programHash).not.toBe(registry.describe(one).programHash);
  });

  it.each([
    ["own arrays ['warm'] and ['cold'] do not merge", [['warm'], ['cold']], false],
    [
      'equal own arrays (different array objects) still merge',
      [
        ['warm', { on: true }],
        ['warm', { on: true }],
      ],
      true,
    ],
  ] as Array<[string, [unknown[], unknown[]], boolean]>)('%s', (_label, modes, merges) => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { modes: modes[0] });
    const b = Object.assign(new MeshStandardMaterial(), { modes: modes[1] });
    expect(registry.register(a)).toBe(a);
    if (merges) expect(registry.register(b)).toBe(a);
    else expect(registry.register(b)).not.toBe(a);
  });

  it('own arrays of different function objects do not merge', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { hooks: [makeOnBeforeRender(1)] });
    const b = Object.assign(new MeshStandardMaterial(), { hooks: [makeOnBeforeRender(2)] });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
  });
});

describe('material keys for BigInt values', () => {
  it('a BigInt inside an own property registers without throwing and keys by value', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: { id: 1n } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { id: 2n } });
    const c = Object.assign(new MeshStandardMaterial(), { extra: { id: 1n } });
    expect(() => registry.register(a)).not.toThrow();
    expect(registry.register(b)).not.toBe(a);
    expect(registry.register(c)).toBe(a);
  });

  it('a BigInt own property keys by value', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { serial: 1n });
    const b = Object.assign(new MeshStandardMaterial(), { serial: 2n });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
    expect(registry.register(Object.assign(new MeshStandardMaterial(), { serial: 1n }))).toBe(a);
  });
});

describe('computeMaterialKeys: a shared plain sub-object is walked once per key computation', () => {
  it('keys a sub-object reached through several paths once, with the key an every-path walk produced', () => {
    const shared = { a: 1, b: 'two', c: [3, 4], d: { e: 5 } };
    const paths = [0, 1, 2, 3, 4, 5, 6, 7];
    const material = new MeshStandardMaterial();
    // A user-added own property holding plain data: keyed by value, so `stableJson` walks it (materialKey.ts).
    (material as unknown as Record<string, unknown>).wide = Object.fromEntries(paths.map((i) => [`p${i}`, shared]));
    const keys = vi.spyOn(Object, 'keys');
    const computed = materialKeyModule.computeMaterialKeys(material);
    const walks = () => keys.mock.calls.filter(([value]) => value === shared).length;
    expect(walks(), 'the shared object is enumerated once, not once per path').toBe(1);
    // A second computation reads the object again: the memo lives for one call, so a mutated sub-object is seen.
    materialKeyModule.computeMaterialKeys(material);
    expect(walks(), 'the memo does not survive the call').toBe(2);
    keys.mockRestore();
    const one = '{"a":1,"b":"two","c":[3,4],"d":{"e":5}}';
    expect(computed.programKey).toContain(`wide={${paths.map((i) => `"p${i}":${one}`).join(',')}}`);
  });

  it('never caches a sub-object that keyed a cycle: `^d` is the ancestor’s depth on the path it was reached by', () => {
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    const material = new MeshStandardMaterial();
    (material as unknown as Record<string, unknown>).twice = { deep: { inner: cyclic }, shallow: cyclic };
    const key = materialKeyModule.computeMaterialKeys(material).programKey;
    // `twice` is depth 0, `deep` 1, `inner`/`shallow` the cyclic object: its back-reference names its own depth.
    expect(key).toContain('twice={"deep":{"inner":{"n":1,"self":^2}},"shallow":{"n":1,"self":^1}}');
  });
});
