import { BoxGeometry, BufferAttribute, BufferGeometry, DodecahedronGeometry, Float32BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { attributeSignature, ensureIndexed, isBatchCompatible } from '../../src/compiler/geometryCompat.js';

describe('attributeSignature', () => {
  it('describes attribute names, sizes, types and normalisation in any insertion order', () => {
    const a = new BufferGeometry();
    a.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
    a.setAttribute('uv', new Float32BufferAttribute([0, 0], 2));
    const b = new BufferGeometry();
    b.setAttribute('uv', new Float32BufferAttribute([0, 0], 2));
    b.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
    expect(attributeSignature(a)).toBe('position:3:Float32:0|uv:2:Float32:0');
    expect(attributeSignature(b)).toBe(attributeSignature(a));
  });

  it('differs when an attribute is missing, sized differently, typed differently or normalised', () => {
    const base = new BoxGeometry();
    const noUv = base.clone();
    noUv.deleteAttribute('uv');
    expect(attributeSignature(noUv)).not.toBe(attributeSignature(base));

    const quantised = base.clone();
    const uv = base.attributes.uv!;
    quantised.setAttribute('uv', new BufferAttribute(new Uint16Array(uv.count * 2), 2, true));
    expect(attributeSignature(quantised)).not.toBe(attributeSignature(base));
  });

  it('does not depend on whether the geometry is indexed', () => {
    const indexed = new BoxGeometry();
    const nonIndexed = indexed.toNonIndexed();
    expect(attributeSignature(nonIndexed)).toBe(attributeSignature(indexed));
  });
});

describe('ensureIndexed', () => {
  it('returns the same object for an indexed geometry', () => {
    const g = new BoxGeometry();
    expect(ensureIndexed(g)).toBe(g);
  });

  it('returns an indexed clone for a non-indexed geometry and leaves the original untouched', () => {
    const g = new DodecahedronGeometry(1);
    expect(g.index).toBeNull();
    const indexed = ensureIndexed(g);
    expect(indexed).not.toBe(g);
    expect(g.index).toBeNull();
    expect(indexed.index?.count).toBe(g.attributes.position!.count);
    expect(indexed.attributes.position!.array).toBe(g.attributes.position!.array);
    const idx = indexed.index!;
    for (let i = 0; i < idx.count; i++) expect(idx.getX(i)).toBe(i);
  });

  it('returns the same clone when asked twice for the same geometry', () => {
    const g = new DodecahedronGeometry(1);
    expect(ensureIndexed(g)).toBe(ensureIndexed(g));
  });
});

describe('isBatchCompatible', () => {
  it('is true for the same attribute signature whatever the vertex count or indexing', () => {
    expect(isBatchCompatible(new BoxGeometry(), new DodecahedronGeometry(2))).toBe(true);
  });

  it('is false when attribute sets differ', () => {
    const noNormal = new BoxGeometry();
    noNormal.deleteAttribute('normal');
    expect(isBatchCompatible(new BoxGeometry(), noNormal)).toBe(false);
  });
});
