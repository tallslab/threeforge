/**
 * The per-frame memo (`src/ledger/memo.ts`) behind the ledger's registry reads and the material uses' canonical
 * resolves: a material is resolved at most once per frame, the material just seen answers without a Map lookup, and
 * a move of `registry.keysRevision` (`invalidate()`, `forget()`) drops every answer, even in the middle of a frame.
 */
import { type Material, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { PerFrameMemo } from '../../src/ledger/memo.js';

const material = () => new MeshBasicMaterial();

/** A memo whose resolve counts its calls and answers with a fresh object each time, so a reused answer is visible. */
function counted(registry: { keysRevision: number }) {
  const resolves: Material[] = [];
  const memo = new PerFrameMemo(registry, (m: Material) => {
    resolves.push(m);
    return { of: m, n: resolves.length };
  });
  return { memo, resolves };
}

describe('PerFrameMemo', () => {
  it('resolves each material once, however they interleave, and repeats its answer', () => {
    const registry = { keysRevision: 0 };
    const { memo, resolves } = counted(registry);
    const materials = [material(), material(), material(), material()];
    const first = materials.map((m) => memo.get(m));
    for (let i = 0; i < 40; i++) expect(memo.get(materials[i % 4]!)).toBe(first[i % 4]);
    // The single-entry fast path: the same material again, and again.
    for (let i = 0; i < 5; i++) expect(memo.get(materials[0]!)).toBe(first[0]);
    expect(resolves).toEqual(materials);
  });

  it('resolves again after clear(): the frame boundary', () => {
    const registry = { keysRevision: 0 };
    const { memo, resolves } = counted(registry);
    const m = material();
    const before = memo.get(m);
    memo.clear();
    const after = memo.get(m);
    expect(after).not.toBe(before);
    expect(resolves).toHaveLength(2);
  });

  it('drops every answer when keysRevision moves, even mid-frame', () => {
    const registry = { keysRevision: 0 };
    const { memo, resolves } = counted(registry);
    const a = material();
    const b = material();
    const a1 = memo.get(a);
    const b1 = memo.get(b);
    memo.get(b); // `b` is the single-entry fast path now
    expect(resolves).toHaveLength(2);

    registry.keysRevision++;
    // The very next read is the fast-path material: it must resolve again, not answer from `last`.
    const b2 = memo.get(b);
    expect(b2).not.toBe(b1);
    const a2 = memo.get(a);
    expect(a2).not.toBe(a1);
    expect(resolves).toHaveLength(4);
    // Settled again until the revision moves once more.
    expect(memo.get(b)).toBe(b2);
    expect(memo.get(a)).toBe(a2);
    expect(resolves).toHaveLength(4);
  });
});
