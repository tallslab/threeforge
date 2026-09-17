import { type BatchedMesh, type InstancedMesh, Matrix4, type Mesh } from 'three';
import type { Slot } from '../batchStatics.js';
import { type CullingHandle, prependRenderHook } from '../culling.js';
import type { CulledInstancedMesh } from '../instancing.js';
import type { SceneSpace } from '../space.js';

const _local = new Matrix4();

interface SyncEntry {
  mesh: Mesh;
  instanceId: number;
  last: Float32Array;
}

/**
 * Hooks every batch and instanced group holding synced dynamics so their instance matrices follow the originals'
 * world matrices before each cull. Returns the hook restores, in install order.
 */
export function installSync(
  synced: ReadonlySet<Mesh>,
  slots: Map<Mesh, Slot>,
  cullingHandles: Map<BatchedMesh, CullingHandle>,
  space: SceneSpace,
): (() => void)[] {
  const restores: (() => void)[] = [];
  if (synced.size === 0) return restores;
  const perTarget = new Map<BatchedMesh | InstancedMesh, SyncEntry[]>();
  for (const mesh of synced) {
    const slot = slots.get(mesh)!;
    // Synced dynamics never land in a baked group (batchStatics keeps their groups as BatchedMesh).
    const target = slot.batch as BatchedMesh | InstancedMesh;
    let list = perTarget.get(target);
    if (!list) perTarget.set(target, (list = []));
    list.push({ mesh, instanceId: slot.instanceId, last: Float32Array.from(mesh.matrixWorld.elements) });
  }
  for (const [target, entries] of perTarget) {
    // A synced instance can leave the precomputed bounds; per-instance culling still applies.
    target.frustumCulled = false;
    const batched = (target as BatchedMesh).isBatchedMesh ? (target as BatchedMesh) : null;
    const handle = batched ? cullingHandles.get(batched) : undefined;
    const instanced = batched ? null : (target as CulledInstancedMesh);
    // What is written is inverse(scene) * world: once the scene moved since the last sync every entry is rewritten, also
    // one whose world matrix did not change (a world-anchored mover, a floating-origin shift of the scene root).
    space.update();
    let spaceVersion = space.version;
    const sync = (): void => {
      space.update();
      const sceneMoved = space.version !== spaceVersion;
      spaceVersion = space.version;
      for (const entry of entries) {
        const e = entry.mesh.matrixWorld.elements;
        const last = entry.last;
        let changed = sceneMoved;
        for (let i = 0; !changed && i < 16; i++) {
          if (e[i] !== last[i]) changed = true;
        }
        if (!changed) continue;
        last.set(e);
        // In the scene's space as of this render: three refreshes scene.matrixWorld before any object hook runs.
        const matrix = space.toLocal(entry.mesh.matrixWorld, _local);
        if (batched) {
          batched.setMatrixAt(entry.instanceId, matrix);
          handle?.move(entry.instanceId);
        } else if (instanced) {
          instanced.forgeCulling.setMatrixAt(entry.instanceId, matrix);
        }
      }
    };
    restores.push(prependRenderHook(target, sync));
  }
  return restores;
}
