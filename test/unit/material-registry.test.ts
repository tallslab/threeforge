import {
  BoxGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { World } from '../../src/compiler/World.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import * as materialKeyModule from '../../src/registry/materialKey.js';

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
    const hashes = new Set(
      [base, mapped, transparent, doubleSided, basic].map((m) => registry.describe(m).programHash),
    );
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
    expect(stats.byProgram[0]).toMatchObject({
      type: 'MeshStandardMaterial',
      materials: 3,
      colorVariants: 3,
      variants: 1,
    });
    expect(stats.byProgram[1]).toMatchObject({ type: 'MeshBasicMaterial', materials: 1 });
    expect(Object.keys(stats).sort()).toEqual([
      'byProgram',
      'canonical',
      'merged',
      'programs',
      'registered',
      'unsupported',
    ]);
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
    expect(hashSpy.mock.calls.length).toBe(hashCallsAfterRegister); // hashKey(programKey/variantKey) must be cached too
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

  it('stats().registered counts materials, not register() calls: a repeat registration adds nothing and one forget() undoes it', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ color: 0xff0000 });
    const unsupported = new ShaderMaterial();
    const duplicate = new MeshStandardMaterial({ color: 0xff0000 });
    for (let i = 0; i < 3; i++) {
      registry.register(a);
      registry.register(unsupported);
      registry.register(duplicate);
    }
    expect(registry.stats()).toMatchObject({ registered: 3, canonical: 1, merged: 1, unsupported: 1 });
    registry.forget(a);
    registry.forget(unsupported);
    registry.forget(duplicate);
    expect(registry.stats()).toMatchObject({ registered: 0, canonical: 0, merged: 0, unsupported: 0 });
  });

  it('stats() registered, merged and unsupported follow the records through register, merge, invalidate and forget', () => {
    const registry = new MaterialRegistry();
    const counts = () => {
      const { registered, canonical, merged, unsupported } = registry.stats();
      return { registered, canonical, merged, unsupported };
    };
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    const b = new MeshStandardMaterial({ roughness: 0.2 });
    const c = new MeshStandardMaterial({ roughness: 0.9 });
    const shader = new ShaderMaterial();
    expect(registry.register(a)).toBe(a);
    expect(counts()).toEqual({ registered: 1, canonical: 1, merged: 0, unsupported: 0 });
    expect(registry.register(b)).toBe(a); // merged into a
    registry.register(c);
    registry.register(shader);
    expect(counts()).toEqual({ registered: 4, canonical: 2, merged: 1, unsupported: 1 });

    // invalidate: a canonical demoted into another (c now matches a), a merged one promoted (b no longer matches a).
    c.roughness = 0.2;
    registry.invalidate(c);
    expect(counts()).toEqual({ registered: 4, canonical: 1, merged: 2, unsupported: 1 });
    b.roughness = 0.5;
    registry.invalidate(b);
    expect(counts()).toEqual({ registered: 4, canonical: 2, merged: 1, unsupported: 1 });
    // invalidate of a canonical that stays one, of an unsupported material and of an unregistered one: nothing moves.
    a.roughness = 0.3;
    registry.invalidate(a);
    registry.invalidate(shader);
    registry.invalidate(new MeshStandardMaterial());
    expect(counts()).toEqual({ registered: 4, canonical: 2, merged: 1, unsupported: 1 });

    // forget: a merged record, an unsupported one, a canonical; an unknown material is a no-op.
    registry.forget(c);
    expect(counts()).toEqual({ registered: 3, canonical: 2, merged: 0, unsupported: 1 });
    registry.forget(shader);
    expect(counts()).toEqual({ registered: 2, canonical: 2, merged: 0, unsupported: 0 });
    registry.forget(a);
    registry.forget(new MeshStandardMaterial());
    expect(counts()).toEqual({ registered: 1, canonical: 1, merged: 0, unsupported: 0 });
    // Re-registering a forgotten material counts it again.
    registry.register(a);
    expect(counts()).toEqual({ registered: 2, canonical: 2, merged: 0, unsupported: 0 });
  });

  it('stats().registered does not grow across compile and decompile cycles of one World', () => {
    const registry = new MaterialRegistry();
    const scene = new Scene();
    const material = new MeshStandardMaterial({ color: 0x808080 });
    for (let i = 0; i < 4; i++) {
      const mesh = new Mesh(
        new BoxGeometry(1, 1, 1),
        i % 2 === 0 ? material : new MeshStandardMaterial({ color: 0x404040 + i }),
      );
      mesh.position.x = i * 2;
      mesh.userData.forge = 'static';
      scene.add(mesh);
    }
    scene.updateMatrixWorld(true);
    const world = new World(scene, { registry });
    const counts: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      counts.push(world.compile().registry.registered);
      world.decompile();
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[0]);
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

describe('MaterialRegistry.keys', () => {
  it('returns the hashes describe() reports from the key cache: the same object on every call, no key or hash recomputed', () => {
    const registry = new MaterialRegistry();
    const computeSpy = vi.spyOn(materialKeyModule, 'computeMaterialKeys');
    const hashSpy = vi.spyOn(materialKeyModule, 'hashKey');
    const material = new MeshStandardMaterial({ roughness: 0.2, transparent: true });
    registry.register(material);
    const computed = computeSpy.mock.calls.length;
    const hashed = hashSpy.mock.calls.length;
    const first = registry.keys(material);
    for (let i = 0; i < 5; i++) expect(registry.keys(material)).toBe(first);
    const described = registry.describe(material);
    expect(computeSpy.mock.calls.length).toBe(computed);
    expect(hashSpy.mock.calls.length).toBe(hashed);
    computeSpy.mockRestore();
    hashSpy.mockRestore();
    expect({
      programHash: first.programHash,
      variantHash: first.variantHash,
      description: first.description,
      unsupported: first.unsupported,
    }).toEqual({
      programHash: described.programHash,
      variantHash: described.variantHash,
      description: described.description,
      unsupported: false,
    });
    const shader = new ShaderMaterial();
    expect(registry.keys(shader).unsupported).toBe(true);
    expect(registry.keys(shader).programHash).toBe(registry.describe(shader).programHash);
  });

  it('returns the re-filed hashes after invalidate(), and leaves a result held from before unchanged', () => {
    const registry = new MaterialRegistry();
    const material = new MeshStandardMaterial({ roughness: 0.2 });
    registry.register(material);
    const before = registry.keys(material);
    const beforeProgram = before.programHash;
    material.flatShading = true; // mutation outside the immutable-once-registered contract
    expect(registry.keys(material).programHash).toBe(beforeProgram);
    registry.invalidate(material);
    const after = registry.keys(material);
    const fresh = materialKeyModule.computeMaterialKeys(material);
    expect(after.programHash).toBe(materialKeyModule.hashKey(fresh.programKey));
    expect(after.variantHash).toBe(materialKeyModule.hashKey(fresh.variantKey));
    expect(after.description).toBe(fresh.description);
    expect(after.programHash).not.toBe(beforeProgram);
    expect(registry.describe(material).programHash).toBe(after.programHash);
    expect(before.programHash).toBe(beforeProgram);
    expect(registry.keys(material)).toBe(after);
  });

  it('keysRevision moves whenever invalidate() or forget() drops cached keys, and only then', () => {
    const registry = new MaterialRegistry();
    const a = new MeshStandardMaterial({ roughness: 0.2 });
    const b = new MeshStandardMaterial({ roughness: 0.7 });
    const start = registry.keysRevision;
    registry.register(a);
    registry.keys(b);
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
