import type { Object3D } from 'three';

/** Values threeforge understands under `object.userData.forge`. */
export type ForgeTag = 'static' | 'dynamic';

/** The `userData` key used for tags. Lives in userData so it survives `clone()`, `toJSON()` and loaders. */
export const FORGE_TAG_KEY = 'forge';

function set<T extends Object3D>(object: T, value: ForgeTag): T {
  object.userData[FORGE_TAG_KEY] = value;
  return object;
}

/**
 * Tag helpers. Statics are batched by `world.compile()`; dynamics are left alone and counted.
 * Untagged meshes are reported by the ledger as `untagged`.
 */
export const tag = {
  static<T extends Object3D>(object: T): T {
    return set(object, 'static');
  },
  dynamic<T extends Object3D>(object: T): T {
    return set(object, 'dynamic');
  },
  /** The object's own tag, if any. Ancestors are not consulted here; `classify()` does that. */
  of(object: Object3D): ForgeTag | undefined {
    const value: unknown = object.userData[FORGE_TAG_KEY];
    return value === 'static' || value === 'dynamic' ? value : undefined;
  },
};
