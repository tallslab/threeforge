import type { Object3D, Scene } from 'three';
import { tag } from '../tags.js';

export interface FreezeInput {
  /** Batched originals parked on the hidden layer (World freezes their matrices itself). */
  hidden: Set<Object3D>;
  /** Hidden originals whose matrices are synced into batches every frame: they must keep auto-updating. */
  synced: Set<Object3D>;
  /** Nodes animation clips target (`animatedRoots`): they and their ancestors keep auto-updating. */
  animated: Set<Object3D>;
}

type Kinded = Object3D & { isMesh?: boolean; isSkinnedMesh?: boolean; isLight?: boolean; isCamera?: boolean; isBone?: boolean; isSprite?: boolean; isPoints?: boolean; isLine?: boolean; isScene?: boolean };

/** A node that only ever holds other nodes: Group, Object3D, LOD roots without their own draw. */
function isContainer(o: Kinded): boolean {
  return !(o.isMesh || o.isLight || o.isCamera || o.isBone || o.isSprite || o.isPoints || o.isLine || o.isScene);
}

/**
 * Which objects `World.compile()` may set `matrixAutoUpdate = false` on: unbatched static-tagged meshes and the
 * topmost ancestors whose whole subtree is static (hidden unsynced originals, static meshes, plain containers with
 * nothing dynamic, animated, lit, skinned or sprite-like inside). Hidden originals are left out of the result:
 * World handles their flags with the rest of the hidden state. The scene itself is never frozen.
 */
export function freezableObjects(scene: Scene, input: FreezeInput): Object3D[] {
  const out: Object3D[] = [];
  const isStaticMesh = (o: Kinded): boolean => Boolean(o.isMesh) && !o.isSkinnedMesh && tag.of(o) === 'static' && !input.animated.has(o) && !input.synced.has(o);
  // Returns whether the subtree rooted at `o` is entirely static; collects freezable roots on the way up.
  const visit = (o: Kinded, ancestorFrozen: boolean): boolean => {
    const hidden = input.hidden.has(o);
    const leafStatic = hidden ? !input.synced.has(o) : isStaticMesh(o);
    if (o.isScene) {
      for (const child of o.children) visit(child as Kinded, false);
      return false;
    }
    let allStatic: boolean;
    if (hidden || o.isMesh) {
      // A mesh's children (attachments) decide with it; a static mesh with a dynamic child is not freezable.
      let childrenStatic = true;
      for (const child of o.children) if (!visit(child as Kinded, ancestorFrozen)) childrenStatic = false;
      allStatic = leafStatic && childrenStatic;
      if (allStatic && !hidden && !ancestorFrozen && !o.isScene) out.push(o);
      return allStatic;
    }
    if (!isContainer(o) || tag.of(o) === 'dynamic' || input.animated.has(o)) {
      for (const child of o.children) visit(child as Kinded, false);
      return false;
    }
    // A container: freezable only if every child is; decide after the children, but children must not be frozen
    // individually when the container will be, so visit twice at most: probe first, then collect.
    const probe = o.children.every((child) => probeStatic(child as Kinded));
    if (probe) {
      if (!ancestorFrozen) out.push(o);
      return true;
    }
    for (const child of o.children) visit(child as Kinded, false);
    return false;
  };
  const probeStatic = (o: Kinded): boolean => {
    const hidden = input.hidden.has(o);
    if (hidden) return !input.synced.has(o) && o.children.every((c) => probeStatic(c as Kinded));
    if (o.isMesh) return isStaticMesh(o) && o.children.every((c) => probeStatic(c as Kinded));
    if (!isContainer(o) || tag.of(o) === 'dynamic' || input.animated.has(o)) return false;
    return o.children.every((c) => probeStatic(c as Kinded));
  };
  visit(scene as Kinded, false);
  return out;
}
