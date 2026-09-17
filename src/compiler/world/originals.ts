import type { Matrix4, Object3D } from 'three';

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
  private states: OriginalState[] = [];
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
    return this.states;
  }

  /** Records where `mesh` sits in the graph (nothing when it has no parent), so detach/restore round-trips exactly. */
  record(mesh: Object3D, synced: boolean): void {
    const parent = mesh.parent;
    if (!parent) return;
    this.states.push({
      mesh,
      parent,
      index: parent.children.indexOf(mesh),
      layersMask: mesh.layers.mask,
      matrixAutoUpdate: mesh.matrixAutoUpdate,
      synced,
    });
  }

  hideAll(): void {
    for (const state of this.states) this.hide(state);
  }

  private hide(state: OriginalState): void {
    const { mesh, parent, synced } = state;
    if (this.mode === 'detach' && !synced) {
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
   */
  updateSubtree(object: Object3D, visit: (node: Object3D) => void): void {
    // A detached original's own children are off the graph too (removeFromParent leaves its subtree intact under
    // it), so they need the same manual matrixWorld composition, seeded from the parent's just-computed matrixWorld.
    // Nested detach (a detached original whose recorded former parent is itself detached) composes the same way.
    const rebuildDetached = (node: Object3D, parentWorld: Matrix4): void => {
      node.updateMatrix();
      node.matrixWorld.multiplyMatrices(parentWorld, node.matrix);
      // updateMatrix() left the flag set: an unforced updateMatrixWorld() on the parentless node would copy `matrix` over
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
      object.traverse((o) => o.updateMatrix());
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
    const restore = [...this.states].sort((a, b) => a.index - b.index);
    for (const state of restore) {
      state.mesh.layers.mask = state.layersMask;
      state.mesh.matrixAutoUpdate = state.matrixAutoUpdate;
      if (this.mode === 'detach' && !state.synced) {
        state.parent.add(state.mesh);
        const children = state.parent.children;
        children.splice(children.indexOf(state.mesh), 1);
        children.splice(Math.min(state.index, children.length), 0, state.mesh);
      }
    }
    this.states = [];
    this.detachedParents = new Map();
    this.detachedByParent = new Map();
  }
}
