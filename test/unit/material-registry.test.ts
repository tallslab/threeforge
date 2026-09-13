import { describe, expect, it } from 'vitest';
import {
  DataTexture,
  DoubleSide,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  ShaderMaterial,
  SRGBColorSpace,
} from 'three';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';

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
