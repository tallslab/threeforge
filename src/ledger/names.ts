import type { Object3D } from 'three';

/** What one cached path was built from: it is still `displayName()`'s answer while every field matches the graph. */
interface PathEntry {
  name: string;
  type: string;
  /** The sibling index, or -1 for a named object (its name stands in for `Type[index]`). */
  index: number;
  /** The parent's path, or '' when the parent is the root or there is none (a path is never empty). */
  prefix: string;
  path: string;
}

/** Cached paths of the objects rendered under one root. */
export type PathCache = WeakMap<Object3D, PathEntry>;

/**
 * `displayName(object, root)` (`reasons.ts`) for the ledger's hot path: the same string, without `children.indexOf`
 * and without allocating while the graph is unchanged.
 *
 * - Every read checks the cached path against the live graph: the object's name, type, sibling index, and its parent's
 *   path (checked the same way, up to the root). A rename, reorder, reparent or removal, even from a hook between two
 *   submissions of one frame, gives the answer `displayName()` would give at that instant.
 * - A sibling index is cached per object and trusted only while `parent.children[index] === object`. On a miss every
 *   child of that parent is indexed again in one pass, since one insertion or removal moves all of them.
 * - Paths are cached per root (`forRoot`), and both maps are weak: nothing here keeps an object alive.
 */
export class DisplayNames {
  private readonly siblings = new WeakMap<Object3D, number>();
  private readonly roots = new WeakMap<Object3D, PathCache>();

  /** The path cache of one root; the ledger holds it for a render call instead of looking it up per submission. */
  forRoot(root: Object3D): PathCache {
    let paths = this.roots.get(root);
    if (paths === undefined) this.roots.set(root, (paths = new WeakMap()));
    return paths;
  }

  of(object: Object3D, root: Object3D, paths: PathCache = this.forRoot(root)): string {
    if (object.name) return object.name;
    return object === root ? '' : this.path(object, root, paths);
  }

  /** The `/`-joined parts from `object` up to, not including, `root` (or the top of its graph); `object` is not `root`. */
  private path(object: Object3D, root: Object3D, paths: PathCache): string {
    const parent = object.parent;
    const prefix = parent && parent !== root ? this.path(parent, root, paths) : '';
    const name = object.name;
    const index = name ? -1 : parent ? this.siblingIndex(object, parent) : 0;
    const type = object.type;
    const entry = paths.get(object);
    if (entry !== undefined && entry.index === index && entry.name === name && entry.prefix === prefix && entry.type === type) return entry.path;
    const part = name || `${type}[${index}]`;
    const path = prefix ? `${prefix}/${part}` : part;
    if (entry === undefined) {
      paths.set(object, { name, type, index, prefix, path });
    } else {
      entry.name = name;
      entry.type = type;
      entry.index = index;
      entry.prefix = prefix;
      entry.path = path;
    }
    return path;
  }

  /** `parent.children.indexOf(object)`, -1 when absent. three's `add()` lists an object in one children array, once. */
  private siblingIndex(object: Object3D, parent: Object3D): number {
    const children = parent.children;
    const cached = this.siblings.get(object);
    if (cached !== undefined && children[cached] === object) return cached;
    let index = -1;
    // Backwards, so an object listed twice keeps its first position, as indexOf reports it.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      this.siblings.set(child, i);
      if (child === object) index = i;
    }
    return index;
  }
}
