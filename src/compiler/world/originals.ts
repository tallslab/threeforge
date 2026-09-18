import type { Matrix4, Object3D } from 'three';
import { isContainer } from '../freeze.js';

/** Hidden originals live on this layer: invisible to default cameras and default raycasters, matrices still valid. */
export const FORGE_HIDDEN_LAYER = 31;

export interface OriginalState {
  mesh: Object3D;
  parent: Object3D;
  index: number;
  layersMask: number;
  matrixAutoUpdate: boolean;
  /** Synced dynamics stay in the graph with auto-updating matrices even in detach mode. */
  synced: boolean;
}

/** The originals one compile hid or detached, where each came from, and the way back. */
export class Originals {
  private readonly mode: 'hide' | 'detach';
  /** Keyed by the original, in record order. */
  private states = new Map<Object3D, OriginalState>();
  /**
   * `originals: 'detach'` only: each detached original's former parent (still in the graph; only slotted originals
   * are ever detached). `markDirty` reads this instead of the parentless `matrixWorld` `updateMatrixWorld` would give.
   */
  private detachedParents = new Map<Object3D, Object3D>();
  /**
   * The reverse index: former parent -> its detached originals, so `markDirty` on that parent (or an ancestor
   * reached through the still-attached graph) can reach them even though they are no longer its children.
   */
  private detachedByParent = new Map<Object3D, Set<Object3D>>();

  constructor(mode: 'hide' | 'detach') {
    this.mode = mode;
  }

  /** Every recorded original, in record order. */
  get hidden(): readonly OriginalState[] {
    return [...this.states.values()];
  }

  /** Records where `mesh` sits in the graph (nothing when it has no parent), so detach/restore round-trips exactly. */
  record(mesh: Object3D, synced: boolean): void {
    const parent = mesh.parent;
    if (!parent) return;
    this.states.set(mesh, {
      mesh,
      parent,
      index: parent.children.indexOf(mesh),
      layersMask: mesh.layers.mask,
      matrixAutoUpdate: mesh.matrixAutoUpdate,
      synced,
    });
  }

  hideAll(): void {
    // Decided for every original before the first one leaves, so the answer does not depend on record order.
    const detach = new Set<Object3D>();
    if (this.mode === 'detach') {
      const leaving = new Set(this.hidden.filter((state) => !state.synced).map((state) => state.mesh));
      for (const mesh of leaving) if (mesh.children.every((child) => leavesWith(child, leaving))) detach.add(mesh);
    }
    for (const state of this.states.values()) this.hide(state, detach.has(state.mesh));
  }

  private hide(state: OriginalState, detach: boolean): void {
    const { mesh, parent, synced } = state;
    if (detach) {
      mesh.removeFromParent();
      this.detachedParents.set(mesh, parent);
      let siblings = this.detachedByParent.get(parent);
      if (!siblings) this.detachedByParent.set(parent, (siblings = new Set()));
      siblings.add(mesh);
    } else {
      mesh.layers.set(FORGE_HIDDEN_LAYER);
      if (!synced) mesh.matrixAutoUpdate = false;
    }
  }

  /**
   * Recomposes the matrices under `object` and calls `visit` on every node reached, detached originals included: a
   * detached original's world matrix is composed from its former parent's current one and its own recomposed local
   * matrix, so a walk from a former parent reaches its detached descendants.
   *
   * Only a node that composed its own matrix before compile is recomposed: one placed through `matrix` with
   * `matrixAutoUpdate` off keeps what was written there, as three leaves it. Hiding switched the flag off on the
   * originals, so theirs is read from the record; `frozenBefore` answers for the nodes the freeze pass switched off
   * (undefined for any other).
   */
  updateSubtree(
    object: Object3D,
    visit: (node: Object3D) => void,
    frozenBefore: (node: Object3D) => boolean | undefined,
  ): void {
    const recompose = (node: Object3D): void => {
      const before = this.states.get(node)?.matrixAutoUpdate ?? frozenBefore(node) ?? node.matrixAutoUpdate;
      if (before) node.updateMatrix();
    };
    // A detached original's own children are off the graph too (removeFromParent leaves its subtree intact under
    // it), so they need the same manual matrixWorld composition, seeded from the parent's just-computed matrixWorld.
    // Nested detach (a detached original whose recorded former parent is itself detached) composes the same way.
    const rebuildDetached = (node: Object3D, parentWorld: Matrix4): void => {
      recompose(node);
      node.matrixWorld.multiplyMatrices(parentWorld, node.matrix);
      // updateMatrix() leaves the flag set: an unforced updateMatrixWorld() on the parentless node would copy `matrix` over
      // what was just composed (Object3D.updateMatrixWorld). A node with matrixAutoUpdate on recomposes and sets it again.
      node.matrixWorldNeedsUpdate = false;
      visit(node);
      const nested = this.detachedByParent.get(node);
      if (nested) for (const child of nested) rebuildDetached(child, node.matrixWorld);
      for (const child of node.children) rebuildDetached(child, node.matrixWorld);
    };

    const formerParent = this.detachedParents.get(object);
    if (formerParent) {
      // `object` is itself a detached original: rebuild it (and any of its own descendants) from its former parent.
      rebuildDetached(object, formerParent.matrixWorld);
    } else {
      object.traverse(recompose);
      object.updateMatrixWorld(true);
      object.traverse((o) => {
        visit(o);
        const detachedChildren = this.detachedByParent.get(o);
        if (detachedChildren) for (const child of detachedChildren) rebuildDetached(child, o.matrixWorld);
      });
    }
  }

  /** Puts every original back where it was (layer, matrix flag, and for detached ones its place among the siblings) and forgets it. */
  restore(): void {
    const restore = [...this.states.values()].sort((a, b) => a.index - b.index);
    for (const state of restore) {
      state.mesh.layers.mask = state.layersMask;
      state.mesh.matrixAutoUpdate = state.matrixAutoUpdate;
      if (this.detachedParents.has(state.mesh)) {
        state.parent.add(state.mesh);
        const children = state.parent.children;
        children.splice(children.indexOf(state.mesh), 1);
        children.splice(Math.min(state.index, children.length), 0, state.mesh);
      }
    }
    this.states = new Map();
    this.detachedParents = new Map();
    this.detachedByParent = new Map();
  }
}

/**
 * Whether `node` may leave the graph with a detached ancestor: it is an unsynced original itself, or a container that
 * holds only such nodes. Anything else under a batched parent (a dynamic mesh, a synced original, a light, a camera, an
 * unbatched static, an empty anchor) still needs the graph to draw or to get its world matrix, so that parent is hidden
 * on the reserved layer instead.
 */
function leavesWith(node: Object3D, leaving: Set<Object3D>): boolean {
  if (!leaving.has(node) && !(isContainer(node) && node.children.length > 0)) return false;
  return node.children.every((child) => leavesWith(child, leaving));
}
