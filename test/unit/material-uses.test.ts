/**
 * Per-frame material uses (`src/ledger/materialUses.ts`), unit-tested without a renderer. It holds the two things the
 * ledger needs per submission: `SubmissionRecord.material` (a per-frame index, in first-draw order) and the mark
 * behind `static-unbatched` — whether another object of the frame's main pass drew the same material. Materials are
 * keyed by the registry's canonical, so instances the registry merged count as one.
 */
import { describe, expect, it, vi } from 'vitest';
import { MeshBasicMaterial, type Material } from 'three';
import { MaterialUses } from '../../src/ledger/materialUses.js';

/** A stand-in registry: `canonicalOf` answers from a map the test controls, with a revision it can move. */
class FakeRegistry {
  keysRevision = 0;
  private readonly canonicals = new Map<Material, Material>();

  /** As `register()` does when `material` is equal by value to one already registered. */
  merge(material: Material, canonical: Material): void {
    this.canonicals.set(material, canonical);
  }

  canonicalOf(material: Material): Material | undefined {
    return this.canonicals.get(material);
  }
}

const material = () => new MeshBasicMaterial();

describe('MaterialUses', () => {
  it('indexes materials in first-use order, one index per canonical, and marks one two objects draw as shared', () => {
    const registry = new FakeRegistry();
    const first = material();
    const second = material();
    const own = material();
    registry.merge(second, first);
    const uses = new MaterialUses(registry);
    uses.beginFrame();

    expect(uses.use(own, 1, true)).toBe(0);
    expect(uses.use(first, 2, true)).toBe(1);
    // A different instance the registry merged into `first`: the same canonical, so the same index and a shared mark.
    expect(uses.use(second, 3, true)).toBe(1);
    expect(uses.shared(1)).toBe(true);
    expect(uses.shared(0)).toBe(false);
  });

  it('does not count an object as sharing a material with itself', () => {
    // The back-side pass of a double-sided transmissive material draws one object twice in the main pass.
    const uses = new MaterialUses(new FakeRegistry());
    uses.beginFrame();
    const glass = material();
    const index = uses.use(glass, 7, true);
    expect(uses.use(glass, 7, true)).toBe(index);
    expect(uses.shared(index)).toBe(false);
  });

  it('adds no use when `counts` is false, so renderer-internal work never makes a material shared', () => {
    const uses = new MaterialUses(new FakeRegistry());
    uses.beginFrame();
    const shared = material();
    const index = uses.use(shared, 1, true);
    // Still indexed — every submission carries a material index — but not counted as a user.
    expect(uses.use(shared, 2, false)).toBe(index);
    expect(uses.shared(index)).toBe(false);
    uses.use(shared, 3, true);
    expect(uses.shared(index)).toBe(true);
  });

  it('resets indices, users and shared marks on beginFrame', () => {
    const uses = new MaterialUses(new FakeRegistry());
    const red = material();
    const blue = material();
    uses.beginFrame();
    expect(uses.use(red, 1, true)).toBe(0);
    expect(uses.use(blue, 2, true)).toBe(1);
    expect(uses.use(blue, 3, true)).toBe(1);
    expect(uses.shared(1)).toBe(true);

    // A frame that draws blue first and only once: blue takes index 0 and is no longer shared.
    uses.beginFrame();
    expect(uses.use(blue, 2, true)).toBe(0);
    expect(uses.shared(0)).toBe(false);
  });

  it('resolves the canonical at most once per material instance per frame, however the materials interleave', () => {
    const registry = new FakeRegistry();
    const materials = [material(), material(), material(), material()];
    const uses = new MaterialUses(registry);
    uses.beginFrame();
    const canonicalOf = vi.spyOn(registry, 'canonicalOf');

    for (let i = 0; i < 40; i++) uses.use(materials[i % 4]!, i, true);
    const resolves = canonicalOf.mock.calls.length;
    canonicalOf.mockRestore();

    expect(resolves).toBeLessThanOrEqual(4);
  });

  it('resolves again after the registry keysRevision moves, even in the middle of a frame', () => {
    const registry = new FakeRegistry();
    const canonical = material();
    const other = material();
    const uses = new MaterialUses(registry);
    uses.beginFrame();
    const index = uses.use(canonical, 1, true);
    expect(uses.use(other, 2, true)).not.toBe(index); // resolves to itself: its own index

    // register()/invalidate() merged `other` into `canonical` and moved the revision.
    registry.merge(other, canonical);
    registry.keysRevision++;

    expect(uses.use(other, 3, true)).toBe(index);
    expect(uses.shared(index)).toBe(true);
  });

  it('keeps the canonical the frame started with when register() merges a material without moving keysRevision', () => {
    // register() files a material against an existing canonical but never moves keysRevision — only invalidate() and
    // forget() do. So within a frame the answer stays the one the frame started with, exactly as the ledger's hash
    // reads behave. This is the one place an output could differ from the pre-memo ledger, so it is pinned.
    const registry = new FakeRegistry();
    const canonical = material();
    const other = material();
    const uses = new MaterialUses(registry);
    uses.beginFrame();
    const index = uses.use(canonical, 1, true);
    const own = uses.use(other, 2, true);
    expect(own).not.toBe(index);

    registry.merge(other, canonical);
    uses.use(canonical, 1, true); // moves the single-material fast path off `other`, so the per-frame memo answers
    expect(uses.use(other, 2, true)).toBe(own);

    // The next frame resolves again and sees the merge.
    uses.beginFrame();
    const merged = uses.use(canonical, 1, true);
    expect(uses.use(other, 2, true)).toBe(merged);
  });
});
