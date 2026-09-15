import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Plane,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  type Material,
} from 'three';
import * as THREE from 'three';
import * as WEBGPU from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import * as materialKeyModule from '../../src/registry/materialKey.js';
import { groupSprites } from '../../src/compiler/sprites.js';
import { World } from '../../src/compiler/World.js';
import { tag } from '../../src/tags.js';

function texture(): DataTexture {
  const t = new DataTexture(new Uint8Array(4 * 4), 2, 2, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

describe('MaterialRegistry.register', () => {
  it('returns the first instance for materials that are identical by value and counts the merge', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    const b = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
    expect(registry.stats()).toMatchObject({ registered: 2, canonical: 1, merged: 1, programs: 1 });
  });

  it('never mutates the material it is given and is idempotent for a canonical', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ color: 0x00ff00 });
    const b = new MeshStandardMaterial({ color: 0x00ff00 });
    registry.register(a);
    registry.register(b);
    expect(b.color.getHex()).toBe(0x00ff00);
    expect(b.uuid).not.toBe(a.uuid);
    expect(registry.register(a)).toBe(a);
    expect(registry.stats().merged).toBe(1);
  });

  it('keeps materials that differ only by colour as separate canonicals under one variant (batchable via per-instance colour)', () => {
    const registry = new MaterialRegistry();
    const red = registry.register(new MeshStandardMaterial({ color: 0xff0000 }));
    const blue = registry.register(new MeshStandardMaterial({ color: 0x0000ff }));
    expect(red).not.toBe(blue);
    const dr = registry.describe(red);
    const db = registry.describe(blue);
    expect(dr.programHash).toBe(db.programHash);
    expect(dr.variantHash).toBe(db.variantHash);
    expect(dr.colorHex).toBe('ff0000');
    expect(db.outcome).toBe('color-variant');
    expect(registry.stats().byProgram[0]).toMatchObject({ variants: 1, colorVariants: 2, materials: 2 });
  });

  it('treats different uniform values (roughness) as a uniform variant of the same program', () => {
    const registry = new MaterialRegistry();
    registry.register(new MeshStandardMaterial({ roughness: 0.2 }));
    const b = registry.register(new MeshStandardMaterial({ roughness: 0.9 }));
    expect(registry.describe(b).outcome).toBe('uniform-variant');
    expect(registry.stats()).toMatchObject({ programs: 1, canonical: 2 });
    expect(registry.stats().byProgram[0]).toMatchObject({ variants: 2 });
  });

  it('treats a texture slot, transparency, side and material type as shader variants (new programs)', () => {
    const registry = new MaterialRegistry();
    const base = registry.register(new MeshStandardMaterial());
    const mapped = registry.register(new MeshStandardMaterial({ map: texture() }));
    const transparent = registry.register(new MeshStandardMaterial({ transparent: true, opacity: 0.5 }));
    const doubleSided = registry.register(new MeshStandardMaterial({ side: DoubleSide }));
    const basic = registry.register(new MeshBasicMaterial());
    const hashes = new Set([base, mapped, transparent, doubleSided, basic].map((m) => registry.describe(m).programHash));
    expect(hashes.size).toBe(5);
    expect(registry.describe(mapped).outcome).toBe('shader-variant');
    expect(registry.stats().programs).toBe(5);
  });

  it('merges materials sharing the same texture object and separates different texture objects within one program', () => {
    const registry = new MaterialRegistry();
    const t1 = texture();
    const t2 = texture();
    const a = registry.register(new MeshStandardMaterial({ map: t1 }));
    const b = registry.register(new MeshStandardMaterial({ map: t1 }));
    const c = registry.register(new MeshStandardMaterial({ map: t2 }));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(registry.describe(c).programHash).toBe(registry.describe(a).programHash);
    expect(registry.describe(c).outcome).toBe('uniform-variant');
  });

  it('treats texture colorSpace as program-affecting', () => {
    const registry = new MaterialRegistry();
    const srgb = texture();
    srgb.colorSpace = SRGBColorSpace;
    const a = registry.register(new MeshStandardMaterial({ map: texture() }));
    const b = registry.register(new MeshStandardMaterial({ map: srgb }));
    expect(registry.describe(a).programHash).not.toBe(registry.describe(b).programHash);
  });

  it('treats physical feature gates (transmission > 0) as program-affecting but their magnitude as uniform', () => {
    const registry = new MaterialRegistry();
    const off = registry.register(new MeshPhysicalMaterial({ transmission: 0 }));
    const low = registry.register(new MeshPhysicalMaterial({ transmission: 0.3 }));
    const high = registry.register(new MeshPhysicalMaterial({ transmission: 0.9 }));
    expect(registry.describe(off).programHash).not.toBe(registry.describe(low).programHash);
    expect(registry.describe(low).programHash).toBe(registry.describe(high).programHash);
    expect(registry.describe(high).outcome).toBe('uniform-variant');
  });

  it('passes ShaderMaterial through untouched and reports it unsupported', () => {
    const registry = new MaterialRegistry();
    const shader = new ShaderMaterial();
    expect(registry.register(shader)).toBe(shader);
    expect(registry.describe(shader).outcome).toBe('unsupported');
    expect(registry.stats()).toMatchObject({ registered: 1, unsupported: 1, canonical: 0 });
  });

  it('lets userData.forgeKey override hashing entirely', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ color: 0xff0000 });
    const b = new MeshStandardMaterial({ color: 0x0000ff });
    a.userData.forgeKey = 'wall';
    b.userData.forgeKey = 'wall';
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
    expect(registry.stats().merged).toBe(1);
  });
});

describe('MaterialRegistry.describe / stats', () => {
  it('produces short deterministic hashes and a readable description', () => {
    const r1 = new MaterialRegistry();
    const r2 = new MaterialRegistry();
    const make = () => new MeshStandardMaterial({ map: texture(), transparent: true, side: DoubleSide });
    const d1 = r1.describe(r1.register(make()));
    const d2 = r2.describe(r2.register(make()));
    expect(d1.programHash).toMatch(/^[0-9a-f]{8}$/);
    expect(d1.programHash).toBe(d2.programHash);
    expect(d1.description).toContain('MeshStandardMaterial');
    expect(d1.description).toContain('map');
    expect(d1.description).toContain('transparent');
  });

  it('reports byProgram sorted by material count descending with a stable shape', () => {
    const registry = new MaterialRegistry();
    for (let i = 0; i < 3; i++) registry.register(new MeshStandardMaterial({ color: i }));
    registry.register(new MeshBasicMaterial());
    const stats = registry.stats();
    expect(stats.byProgram).toHaveLength(2);
    expect(stats.byProgram[0]).toMatchObject({ type: 'MeshStandardMaterial', materials: 3, colorVariants: 3, variants: 1 });
    expect(stats.byProgram[1]).toMatchObject({ type: 'MeshBasicMaterial', materials: 1 });
    expect(Object.keys(stats).sort()).toEqual(['byProgram', 'canonical', 'merged', 'programs', 'registered', 'unsupported']);
  });
});

describe('MaterialRegistry exact colour keys', () => {
  it('keeps HDR emissive colours distinct even though they clamp to the same 8-bit hex', () => {
    const registry = new MaterialRegistry();
    const dim = new MeshStandardMaterial({ emissive: new Color(2, 2, 2) });
    const bright = new MeshStandardMaterial({ emissive: new Color(5, 5, 5) });
    // three's Color.getHex() clamps each channel to [0, 255]; both HDR emissives round to the same hex.
    expect(dim.emissive.getHexString()).toBe('ffffff');
    expect(bright.emissive.getHexString()).toBe('ffffff');
    const a = registry.register(dim);
    const b = registry.register(bright);
    expect(registry.describe(a).programHash).toBe(registry.describe(b).programHash);
    expect(registry.describe(a).variantHash).not.toBe(registry.describe(b).variantHash);
  });

  it('keeps colours 0.3/255 apart as separate canonicals, not merged, even though they share an 8-bit hex', () => {
    const registry = new MaterialRegistry();
    const base = new Color().setRGB(0.5, 0.5, 0.5);
    const near = new Color().setRGB(0.5 + 0.3 / 255, 0.5, 0.5);
    const a = registry.register(new MeshStandardMaterial({ color: base }));
    const b = registry.register(new MeshStandardMaterial({ color: near }));
    const da = registry.describe(a);
    const db = registry.describe(b);
    expect(da.colorHex).toBe(db.colorHex); // same rounded 8-bit display hex
    expect(da.colorKey).not.toBe(db.colorKey); // exact keys still differ
    expect(a).not.toBe(b); // not merged into one canonical
    expect(db.outcome).toBe('color-variant');
  });

  it('joins the variant key with `visible` only when it is false, so a hidden material never merges with a visible twin', () => {
    const registry = new MaterialRegistry();
    const visible = registry.register(new MeshStandardMaterial({ color: 0xff0000 }));
    const invisible = registry.register(new MeshStandardMaterial({ color: 0xff0000, visible: false }));
    expect(invisible).not.toBe(visible);
    const dVisible = registry.describe(visible);
    const dInvisible = registry.describe(invisible);
    expect(dInvisible.programHash).toBe(dVisible.programHash); // visible does not affect the program
    expect(dInvisible.variantHash).not.toBe(dVisible.variantHash);
    // two invisible materials that are otherwise identical still merge with each other.
    const invisibleTwin = registry.register(new MeshStandardMaterial({ color: 0xff0000, visible: false }));
    expect(invisibleTwin).toBe(invisible);
  });
});

describe('MaterialRegistry caching', () => {
  it('describe() does not re-hash on repeated calls: computeMaterialKeys and hashKey each run once per material', () => {
    const registry = new MaterialRegistry();
    const computeSpy = vi.spyOn(materialKeyModule, 'computeMaterialKeys');
    const hashSpy = vi.spyOn(materialKeyModule, 'hashKey');
    const material = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(material);
    const computeCallsAfterRegister = computeSpy.mock.calls.length;
    const hashCallsAfterRegister = hashSpy.mock.calls.length;
    expect(computeCallsAfterRegister).toBeGreaterThan(0);
    expect(hashCallsAfterRegister).toBeGreaterThan(0);
    registry.describe(material);
    registry.describe(material);
    registry.describe(material);
    expect(computeSpy.mock.calls.length).toBe(computeCallsAfterRegister);
    expect(hashSpy.mock.calls.length).toBe(hashCallsAfterRegister); // hashKey(programKey/variantKey) must be cached too (R6)
    computeSpy.mockRestore();
    hashSpy.mockRestore();
  });

  it('invalidate() re-keys a mutated material: describe() keeps returning stale hashes until invalidate is called', () => {
    const registry = new MaterialRegistry();
    const material = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(material);
    const before = registry.describe(material);
    material.roughness = 0.9; // mutation outside the immutable-once-registered contract
    const stillStale = registry.describe(material);
    expect(stillStale.variantHash).toBe(before.variantHash);
    registry.invalidate(material);
    const after = registry.describe(material);
    expect(after.variantHash).not.toBe(before.variantHash);
    expect(after.programHash).toBe(before.programHash); // roughness is a uniform, not a program key
  });

  it('forget() drops a canonical material: describe() reports it unregistered and stats shrink back', () => {
    const registry = new MaterialRegistry();
    const a = registry.register(new MeshStandardMaterial({ color: 0xff0000 }));
    const before = registry.stats();
    registry.forget(a);
    expect(registry.describe(a).outcome).toBe('unregistered');
    expect(registry.canonicalOf(a)).toBeUndefined();
    const after = registry.stats();
    expect(after.registered).toBe(before.registered - 1);
    expect(after.canonical).toBe(before.canonical - 1);
  });

  it('forget() on a merged duplicate leaves its canonical untouched', () => {
    const registry = new MaterialRegistry();
    const a = registry.register(new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 }));
    // register() returns the canonical for a merge, not the instance passed in: keep that instance to forget it.
    const duplicate = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    const b = registry.register(duplicate);
    expect(b).toBe(a);
    expect(registry.stats().merged).toBe(1);
    registry.forget(duplicate);
    expect(registry.stats().merged).toBe(0);
    expect(registry.describe(a).outcome).toBe('new');
    expect(registry.describe(duplicate).outcome).toBe('unregistered');
    const c = registry.register(new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 }));
    expect(c).toBe(a); // still findable as the canonical for that key
  });
});

describe('MaterialRegistry.hashesOf', () => {
  it('returns the hashes describe() reports from the key cache: the same object on every call, no key or hash recomputed', () => {
    const registry = new MaterialRegistry();
    const computeSpy = vi.spyOn(materialKeyModule, 'computeMaterialKeys');
    const hashSpy = vi.spyOn(materialKeyModule, 'hashKey');
    const material = new MeshStandardMaterial({ roughness: 0.2, transparent: true });
    registry.register(material);
    const computed = computeSpy.mock.calls.length;
    const hashed = hashSpy.mock.calls.length;
    const first = registry.hashesOf(material);
    for (let i = 0; i < 5; i++) expect(registry.hashesOf(material)).toBe(first);
    const described = registry.describe(material);
    expect(computeSpy.mock.calls.length).toBe(computed);
    expect(hashSpy.mock.calls.length).toBe(hashed);
    computeSpy.mockRestore();
    hashSpy.mockRestore();
    expect({ programHash: first.programHash, variantHash: first.variantHash, description: first.description, unsupported: first.unsupported }).toEqual({
      programHash: described.programHash,
      variantHash: described.variantHash,
      description: described.description,
      unsupported: false,
    });
    const shader = new ShaderMaterial();
    expect(registry.hashesOf(shader).unsupported).toBe(true);
    expect(registry.hashesOf(shader).programHash).toBe(registry.describe(shader).programHash);
  });

  it('returns the re-filed hashes after invalidate(), and leaves a result held from before unchanged', () => {
    const registry = new MaterialRegistry();
    const material = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(material);
    const before = registry.hashesOf(material);
    const beforeProgram = before.programHash;
    material.flatShading = true; // mutation outside the immutable-once-registered contract
    expect(registry.hashesOf(material).programHash).toBe(beforeProgram);
    registry.invalidate(material);
    const after = registry.hashesOf(material);
    const fresh = materialKeyModule.computeMaterialKeys(material);
    expect(after.programHash).toBe(materialKeyModule.hashKey(fresh.programKey));
    expect(after.variantHash).toBe(materialKeyModule.hashKey(fresh.variantKey));
    expect(after.description).toBe(fresh.description);
    expect(after.programHash).not.toBe(beforeProgram);
    expect(registry.describe(material).programHash).toBe(after.programHash);
    expect(before.programHash).toBe(beforeProgram);
    expect(registry.hashesOf(material)).toBe(after);
  });

  it('keysRevision moves whenever invalidate() or forget() drops cached keys, and only then', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    const b = new MeshStandardMaterial({ roughness: 0.7 });
    const start = registry.keysRevision;
    registry.register(a);
    registry.hashesOf(b);
    registry.describe(a);
    registry.stats();
    expect(registry.keysRevision).toBe(start);
    registry.invalidate(a);
    const afterInvalidate = registry.keysRevision;
    expect(afterInvalidate).not.toBe(start);
    registry.invalidate(b); // never registered: its cached keys are dropped all the same
    const afterUnregistered = registry.keysRevision;
    expect(afterUnregistered).not.toBe(afterInvalidate);
    registry.forget(a);
    expect(registry.keysRevision).not.toBe(afterUnregistered);
  });
});

describe('MaterialRegistry.invalidate: re-files under the new keys, not just the describe() cache', () => {
  it('removes the stale canonicalByFullKey entry: a fresh material matching the OLD state no longer merges into the mutated canonical', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    expect(registry.register(a)).toBe(a);
    const originalHashes = registry.describe(a);

    a.roughness = 0.9; // mutation outside the immutable-once-registered contract
    registry.invalidate(a);
    const rekeyedHashes = registry.describe(a);
    expect(rekeyedHashes.variantHash).not.toBe(originalHashes.variantHash);
    expect(rekeyedHashes.programHash).toBe(originalHashes.programHash); // roughness is a uniform, not a program key

    // A fresh material matching A's ORIGINAL (pre-mutation) state must NOT merge into the re-keyed A: if the old
    // canonicalByFullKey entry were still there, B would render with A's mutated roughness.
    const b = registry.register(new MeshStandardMaterial({ roughness: 0.2 }));
    expect(b).not.toBe(a);
    expect(registry.describe(b).variantHash).toBe(originalHashes.variantHash);
    expect(registry.describe(b).outcome).not.toBe('merged');

    // A fresh material matching A's NEW state merges into the re-filed canonical.
    const c = registry.register(new MeshStandardMaterial({ roughness: 0.9 }));
    expect(c).toBe(a);
    expect(registry.describe(c).variantHash).toBe(rekeyedHashes.variantHash);
  });

  it('demotes to a merged record when another canonical already holds the new key', () => {
    const registry = new MaterialRegistry();
    const target = registry.register(new MeshStandardMaterial({ roughness: 0.9 })); // the key A mutates into
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    expect(registry.register(a)).toBe(a);
    expect(a).not.toBe(target);

    a.roughness = 0.9; // now matches `target`'s key exactly
    registry.invalidate(a);

    expect(registry.canonicalOf(a)).toBe(target);
    expect(registry.describe(a).outcome).toBe('merged');
    expect(registry.stats().merged).toBe(1); // stats().merged is a live count, shrunk by forget() too: it moves here
    // `target` stays the canonical everyone else resolves to.
    const d = registry.register(new MeshStandardMaterial({ roughness: 0.9 }));
    expect(d).toBe(target);
    expect(registry.stats().merged).toBe(2);
  });

  it('promotes a merged duplicate back to its own canonical once its mutation no longer matches', () => {
    const registry = new MaterialRegistry();
    const canonical = registry.register(new MeshStandardMaterial({ roughness: 0.2 }));
    const duplicate = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(duplicate);
    expect(registry.canonicalOf(duplicate)).toBe(canonical);
    expect(registry.stats().merged).toBe(1);

    duplicate.roughness = 0.7; // no longer matches `canonical`'s key
    registry.invalidate(duplicate);

    expect(registry.canonicalOf(duplicate)).toBe(duplicate); // its own canonical again
    expect(registry.describe(duplicate).outcome).not.toBe('merged');
    expect(registry.stats().merged).toBe(0);
    const another = registry.register(new MeshStandardMaterial({ roughness: 0.7 }));
    expect(another).toBe(duplicate); // findable at its new key
  });

  it('leaves a material already merged into the old canonical resolving to it, even after the canonical mutates', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    expect(registry.register(a)).toBe(a);
    const dependent = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(dependent);
    expect(registry.canonicalOf(dependent)).toBe(a);

    a.roughness = 0.9;
    registry.invalidate(a);

    // `dependent` is not re-keyed by invalidating `a`: it still resolves to the same (now mutated) Material
    // object, per invalidate()'s documented caveat — the app's choice once it mutates a shared canonical.
    expect(registry.canonicalOf(dependent)).toBe(a);
    expect(registry.stats().merged).toBe(1); // `a` stayed canonical throughout; `dependent`'s merge is untouched
  });
});

describe('MaterialRegistry.forget: disposal hazard and re-registration', () => {
  it('forgetting a canonical does not clear its dependents: they keep resolving to the (still live) forgotten object', () => {
    const registry = new MaterialRegistry();
    const a = registry.register(new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 }));
    const duplicate = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    registry.register(duplicate);
    expect(registry.canonicalOf(duplicate)).toBe(a);
    registry.forget(a);
    expect(registry.canonicalOf(duplicate)).toBe(a); // untouched bookkeeping; disposing `a` now would break `duplicate`
  });

  it('forgetting a canonical, then registering an identical new material, creates a fresh distinct canonical', () => {
    const registry = new MaterialRegistry();
    const a = registry.register(new MeshStandardMaterial({ color: 0xff0000 }));
    registry.forget(a);
    const b = registry.register(new MeshStandardMaterial({ color: 0xff0000 }));
    expect(b).not.toBe(a);
    expect(registry.describe(b).outcome).toBe('new');
    expect(registry.canonicalOf(b)).toBe(b);
  });
});

describe('MaterialRegistry.dependentsOf', () => {
  it('counts materials merged into a canonical, so a caller can check before disposing it', () => {
    const registry = new MaterialRegistry();
    const a = registry.register(new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 }));
    expect(registry.dependentsOf(a)).toBe(0);
    const dup1 = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    const dup2 = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
    registry.register(dup1);
    registry.register(dup2);
    expect(registry.dependentsOf(a)).toBe(2);
    registry.forget(dup1);
    expect(registry.dependentsOf(a)).toBe(1);
    expect(registry.dependentsOf(dup2)).toBe(0); // dup2 is not itself a canonical anyone merged into
  });
});

describe('sprite grouping uses the exact colorKey', () => {
  it('does not merge sprites whose colours are 0.3/255 apart, even though they share an 8-bit display hex', () => {
    const registry = new MaterialRegistry();
    const base = new Color().setRGB(0.5, 0.5, 0.5);
    const near = new Color().setRGB(0.5 + 0.3 / 255, 0.5, 0.5);
    const a = new Sprite(new SpriteMaterial({ color: base }));
    const b = new Sprite(new SpriteMaterial({ color: near }));
    expect(registry.describe(a.material).colorHex).toBe(registry.describe(b.material).colorHex);
    const { groups } = groupSprites([a, b], 1, (m) => registry.describe(m));
    expect(groups).toHaveLength(2);
  });

  it('merges sprites with the exact same colour into one group', () => {
    const registry = new MaterialRegistry();
    const a = new Sprite(new SpriteMaterial({ color: 0x336699 }));
    const b = new Sprite(new SpriteMaterial({ color: 0x336699 }));
    const { groups } = groupSprites([a, b], 1, (m) => registry.describe(m));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sprites).toHaveLength(2);
  });
});

/*
 * Material code and user-added own properties (Task 23b). Every factory below returns a new function (or class) with
 * the same source text on every call: only the captured `tint` differs, which `toString()` cannot see.
 */
function makeSetupOutput(tint: number) {
  return function (this: MeshStandardNodeMaterial, ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>) {
    void tint;
    return MeshStandardNodeMaterial.prototype.setupOutput.apply(this, args);
  };
}
function makeOnBeforeCompile(tint: number) {
  return function (shader: { fragmentShader: string }): void {
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\ngl_FragColor.rgb *= ${tint.toFixed(3)};`);
  };
}
function makeCustomProgramCacheKey(tint: number) {
  return function (): string {
    void tint;
    return 'tinted';
  };
}
function makeOnBeforeRender(tint: number) {
  return function (): void {
    void tint;
  };
}
function makeHookedClass(tint: number) {
  return class HookedMaterial extends MeshStandardMaterial {
    override onBeforeCompile(shader: { fragmentShader: string }): void {
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>\ngl_FragColor.rgb *= ${tint.toFixed(3)};`);
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
  ['an instance setupOutput on a MeshStandardNodeMaterial', { level: 'program', code: makeSetupOutput, make: (code) => Object.assign(new MeshStandardNodeMaterial(), { setupOutput: code as ReturnType<typeof makeSetupOutput> }) }],
  ['an instance onBeforeCompile closure on a MeshStandardMaterial', { level: 'program', code: makeOnBeforeCompile, make: (code) => Object.assign(new MeshStandardMaterial(), { onBeforeCompile: code as ReturnType<typeof makeOnBeforeCompile> }) }],
  ['an instance customProgramCacheKey on a MeshStandardMaterial', { level: 'program', code: makeCustomProgramCacheKey, make: (code) => Object.assign(new MeshStandardMaterial(), { customProgramCacheKey: code as ReturnType<typeof makeCustomProgramCacheKey> }) }],
  ['an instance onBeforeRender on a MeshStandardMaterial', { level: 'variant', code: makeOnBeforeRender, make: (code) => Object.assign(new MeshStandardMaterial(), { onBeforeRender: code as ReturnType<typeof makeOnBeforeRender> }) }],
  ['an onBeforeCompile declared on a subclass prototype (a class factory)', { level: 'program', code: makeHookedClass, make: (code) => new (code as ReturnType<typeof makeHookedClass>)() }],
  ['a customProgramCacheKey declared on a subclass prototype (a class factory)', { level: 'program', code: makeCacheKeyClass, make: (code) => new (code as ReturnType<typeof makeCacheKeyClass>)() }],
];

describe('material keys include material code by identity, not by source text', () => {
  it.each(CODE_CASES)('%s: different function objects with identical source text do not merge', (_name, { code, make, level }) => {
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
  });

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
      const mesh = tag.static(new Mesh(geometry, Object.assign(new MeshStandardNodeMaterial({ color }), { setupOutput: i === 2 ? other : shared })));
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
    ['a plain object that references itself', () => {
      const extra: Record<string, unknown> = { tint: 1 };
      extra.self = extra;
      return extra;
    }],
    ['an array that contains itself', () => {
      const list: unknown[] = [1];
      list.push(list);
      return { list };
    }],
    ['an Object3D in a scene graph (parent and children reference each other)', () => {
      const scene = new Scene();
      const target = new Object3D();
      scene.add(target);
      return { target };
    }],
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
    const a = Object.assign(new MeshStandardMaterial(), { extra: { uTint: [1, 0.5, 0], mode: 'warm', nested: { on: true } } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { nested: { on: true }, mode: 'warm', uTint: [1, 0.5, 0] } });
    const c = Object.assign(new MeshStandardMaterial(), { extra: { nested: { on: false }, mode: 'warm', uTint: [1, 0.5, 0] } });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
    expect(registry.register(c)).not.toBe(a);
  });

  it('keys a Texture inside an own property by identity: a distinct texture with the same uuid and content does not merge', () => {
    const map = texture();
    const twin = map.clone();
    twin.uuid = map.uuid; // what ObjectLoader does when it parses the same JSON twice
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: { map } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { map: twin } });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
  });

  it('keys a Texture inside an own property by identity: the same texture object in different `extra` objects merges', () => {
    const map = texture();
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { extra: { map } });
    const b = Object.assign(new MeshStandardMaterial(), { extra: { map } });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
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
 * Fix round 1: subclasses, array properties and BigInt (Task 23b).
 */
class GlowMaterial extends MeshStandardNodeMaterial {
  override setupOutput(...args: Parameters<MeshStandardNodeMaterial['setupOutput']>): ReturnType<MeshStandardNodeMaterial['setupOutput']> {
    return super.setupOutput(...args);
  }
}
class PulseMaterial extends MeshStandardNodeMaterial {
  override setupOutput(...args: Parameters<MeshStandardNodeMaterial['setupOutput']>): ReturnType<MeshStandardNodeMaterial['setupOutput']> {
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

  it('two node subclasses overriding setupOutput differently do not merge with each other', () => {
    const registry = new MaterialRegistry();
    const glow = new GlowMaterial();
    const pulse = new PulseMaterial();
    expect(registry.register(glow)).toBe(glow);
    expect(registry.register(pulse)).not.toBe(glow);
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

  it('two instances of the same subclass still merge', () => {
    const registry = new MaterialRegistry();
    const a = new GlowMaterial();
    const b = new GlowMaterial();
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
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

  it("own arrays ['warm'] and ['cold'] do not merge", () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { modes: ['warm'] });
    const b = Object.assign(new MeshStandardMaterial(), { modes: ['cold'] });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).not.toBe(a);
  });

  it('equal own arrays (different array objects) still merge', () => {
    const registry = new MaterialRegistry();
    const a = Object.assign(new MeshStandardMaterial(), { modes: ['warm', { on: true }] });
    const b = Object.assign(new MeshStandardMaterial(), { modes: ['warm', { on: true }] });
    expect(registry.register(a)).toBe(a);
    expect(registry.register(b)).toBe(a);
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
