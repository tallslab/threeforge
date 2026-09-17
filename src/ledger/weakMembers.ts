import type { AllowedRenderTarget } from './memory.js';
import type { DrawnTarget, LedgerRenderer } from './rendererPatch.js';

/** A `dispose` listener of a geometry or render target three holds. */
export type DisposeListener = (event: { target: unknown }) => void;

/**
 * A set that holds its members weakly and can still be walked: what the memory section notes about three's own resources
 * must not keep a resource the app dropped alive. `add` says whether the member is new.
 */
export class WeakMembers<T extends object> {
  private refs = new Set<WeakRef<T>>();
  private byMember = new WeakMap<T, WeakRef<T>>();

  has(member: T): boolean {
    return this.byMember.has(member);
  }

  add(member: T): boolean {
    if (this.byMember.has(member)) return false;
    const ref = new WeakRef(member);
    this.refs.add(ref);
    this.byMember.set(member, ref);
    return true;
  }

  delete(member: T): void {
    const ref = this.byMember.get(member);
    if (ref === undefined) return;
    this.refs.delete(ref);
    this.byMember.delete(member);
  }

  /** The members still alive (collected ones are dropped). */
  live(): T[] {
    const out: T[] = [];
    for (const ref of this.refs) {
      const member = ref.deref();
      if (member === undefined) this.refs.delete(ref);
      else out.push(member);
    }
    return out;
  }

  clear(): void {
    this.refs = new Set();
    this.byMember = new WeakMap();
  }
}

/** Remembers a geometry three draws for itself in `geometries` until it is disposed. */
export function noteGeometry(geometries: WeakMembers<object>, geometry: object, onDispose: DisposeListener): void {
  if (geometries.add(geometry)) (geometry as DrawnTarget).addEventListener?.('dispose', onDispose);
}

/** Drops the noted geometries and targets and their dispose listeners (attach and detach). */
export function forgetInternalResources(
  geometries: WeakMembers<object>,
  targets: WeakMembers<DrawnTarget>,
  onDispose: DisposeListener,
): void {
  for (const geometry of geometries.live()) (geometry as DrawnTarget).removeEventListener?.('dispose', onDispose);
  for (const target of targets.live()) target.removeEventListener?.('dispose', onDispose);
  geometries.clear();
  targets.clear();
}

/**
 * The renderer's frame-buffer targets in three r186's shape (`renderer._frameBufferTargets`: a Map whose values are
 * RenderTargets), or null. A private field: anything else — absent, renamed, not a Map, or holding values that are not
 * render targets — is not read, so the estimate keeps its fixed allowance instead of counting a reshaped field wrong.
 * The canary in test/unit/memory.test.ts pins the shape against three itself.
 */
export function frameBufferTargetsOf(renderer: LedgerRenderer | null): AllowedRenderTarget[] | null {
  const map = (renderer as { _frameBufferTargets?: unknown } | null)?._frameBufferTargets;
  if (!(map instanceof Map)) return null;
  const targets: AllowedRenderTarget[] = [];
  for (const value of map.values()) {
    if ((value as { isRenderTarget?: boolean } | null)?.isRenderTarget !== true) return null;
    targets.push(value as AllowedRenderTarget);
  }
  return targets;
}
