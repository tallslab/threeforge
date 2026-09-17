import {
  type BatchedMesh,
  type Box3,
  BoxGeometry,
  type InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Vector3,
} from 'three';
import type { Slot } from '../batchStatics.js';
import { prependAfterRenderHook, prependRenderHook } from '../culling.js';
import type { CulledInstancedMesh, InstanceCullingHandle } from '../instancing.js';
import { cameraNearProxy } from '../occlusionProxy.js';
import type { PassTracker } from '../passTracker.js';
import type { SceneSpace } from '../space.js';

const _size = new Vector3();
const _center = new Vector3();

interface OcclusionEntry {
  proxy: Mesh;
  targets: Object3D[];
  /** Its query was turned off in a render at tracker depth 0; a microtask turns it back on. */
  parked: boolean;
}

export interface OcclusionTargets {
  scene: Object3D;
  passes: PassTracker;
  space: SceneSpace;
  batches: BatchedMesh[];
  instanced: InstancedMesh[];
  /** The batch-synced movers and where each landed. */
  synced: ReadonlySet<Mesh>;
  slots: Map<Mesh, Slot>;
}

/** The occlusion proxies of one compile: one invisible box per batch or instanced group, installed, refitted and torn down here. */
export class OcclusionProxies {
  private entries: OcclusionEntry[] = [];
  /** Batches and instanced groups `install` gave no proxy because they hold batch-synced movers. */
  skippedSynced = 0;
  private resumeQueued = false;
  /** Turns the query of proxies parked at tracker depth 0 back on. Queued as a microtask, so it never runs inside a render. */
  readonly resumeParked = (): void => {
    this.resumeQueued = false;
    for (const entry of this.entries) {
      if (!entry.parked) continue;
      entry.parked = false;
      entry.proxy.occlusionTest = true;
    }
  };
  private restores: (() => void)[] = [];

  get count(): number {
    return this.entries.length;
  }

  get proxies(): Mesh[] {
    return this.entries.map((entry) => entry.proxy);
  }

  materials(): Material[] {
    return this.entries.map(({ proxy }) => proxy.material as Material);
  }

  install({ scene, passes, space, batches, instanced, synced: syncedMeshes, slots }: OcclusionTargets): void {
    // No proxy for a target holding batch-synced movers: a mover can leave the compile-time box, and while the proxy keeps
    // the target hidden three never calls the target's onBeforeRender (`Renderer._projectObject` returns at
    // `object.visible === false`), where the sync runs, so nothing could grow the box before the mover is on screen.
    const synced = new Set<Object3D>();
    for (const mesh of syncedMeshes) {
      const slot = slots.get(mesh);
      if (slot) synced.add(slot.batch);
    }
    const groups: Object3D[][] = batches.filter((b) => !synced.has(b)).map((b) => [b]);
    let skippedSynced = batches.length - groups.length;
    for (const mesh of instanced) {
      const levels = (mesh as CulledInstancedMesh).levels ?? [mesh];
      if (levels[0] !== mesh) continue;
      if (levels.some((level) => synced.has(level))) skippedSynced++;
      else groups.push(levels);
    }
    this.skippedSynced = skippedSynced;
    const size = new Vector3();
    const center = new Vector3();
    for (const targets of groups) {
      const target = targets[0] as Object3D & {
        boundingBox?: { getSize(v: Vector3): Vector3; getCenter(v: Vector3): Vector3 } | null;
      };
      const box = target.boundingBox;
      if (!box) continue;
      box.getSize(size);
      box.getCenter(center);
      const geometry = new BoxGeometry(Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      const proxy = new Mesh(geometry, material);
      proxy.name = `forge:occluder:${target.name}`;
      proxy.position.copy(center);
      proxy.occlusionTest = true;
      proxy.renderOrder = 1; // after the opaque occluders it is tested against
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      proxy.raycast = () => {};
      proxy.userData.forge = { kind: 'occlusion-proxy' };
      scene.add(proxy);
      const entry: OcclusionEntry = { proxy, targets, parked: false };
      this.entries.push(entry);
      const resume = (): void => {
        proxy.occlusionTest = true;
      };
      this.restores.push(
        // Before the proxy's draw in the outermost render: when a query from this camera could miss a visible target (the
        // eye inside the box, the near plane cutting into it: `cameraNearProxy`), issue none. three begins a query at the
        // draw and ends it at the next draw or at the end of the render, reading `occlusionTest` both times
        // (WebGPUBackend.draw / finishRender, WebGLBackend.draw / finishRender), so the flag stays off until the
        // outermost render is over (PassTracker.atEnd runs in the scene's onAfterRender, after finishRender). The render
        // list has already counted the proxy; its unused query slot is skipped when the results are read. A result set
        // without the proxy never reports it occluded, so no late answer from this render can hide the targets.
        prependRenderHook(proxy, (_renderer, _scene, camera) => {
          if (!proxy.occlusionTest) return;
          if (passes.depth === 0) {
            // Drawn without the scene's own hooks (the scene is a child of another root passed to render()): no pass to
            // tell the outermost render by, and no end-of-render hook. Fail safe: issue no query, and the after-render hook
            // shows the targets. The flag comes back in a microtask, once render() has returned: never inside a render,
            // where three reads it again to end the query.
            proxy.occlusionTest = false;
            entry.parked = true;
            if (!this.resumeQueued) {
              this.resumeQueued = true;
              queueMicrotask(this.resumeParked);
            }
            return;
          }
          if (passes.depth !== 1 || !cameraNearProxy(camera, proxy, space)) return;
          proxy.occlusionTest = false;
          passes.atEnd(resume);
        }),
        // Ask inside the proxy's own after-render hook: that runs within renderObject(), while the render context is
        // current (the scene-level hook runs after three has restored the outer context and would see nothing), and
        // returns the last result set published for that context, from a render at least two renders back. Only the
        // outermost render decides: a nested pass (a reflection, a portal) reads its own context's results. At depth 0 the
        // query was parked above, so the targets are shown.
        prependAfterRenderHook(proxy, (renderer) => {
          if (passes.depth > 1) return;
          const query = (renderer as { isOccluded?: (object: Object3D) => boolean }).isOccluded;
          if (typeof query !== 'function') return;
          const occluded = proxy.occlusionTest && query.call(renderer, proxy) === true;
          for (const t of targets) t.visible = !occluded;
        }),
      );
    }
  }

  /** Refits the proxy of every target `markDirty` moved instances in (the batches by mesh, the instanced groups by culling handle). */
  refit(batches: ReadonlySet<BatchedMesh>, handles: ReadonlySet<InstanceCullingHandle>): void {
    if (batches.size + handles.size === 0) return;
    for (const entry of this.entries) {
      const target = entry.targets[0] as BatchedMesh | CulledInstancedMesh;
      if (batches.has(target as BatchedMesh) || handles.has((target as CulledInstancedMesh).forgeCulling))
        this.fitProxy(entry);
    }
  }

  /**
   * Fits an occlusion proxy to its target's bounding box again, the way `install` sized it (the box's centre, each
   * extent 1 mm at least; target and proxy are both children of the scene). The proxy moves and the corners of its
   * one-segment box geometry are rewritten in place: every position component of such a box is plus or minus half an
   * extent, so no geometry is created and the values match a new `BoxGeometry` of that size exactly.
   */
  private fitProxy(entry: OcclusionEntry): void {
    const box = (entry.targets[0] as Object3D & { boundingBox?: Box3 | null }).boundingBox;
    if (!box) return;
    box.getSize(_size);
    box.getCenter(_center);
    const hx = Math.max(_size.x, 1e-3) / 2;
    const hy = Math.max(_size.y, 1e-3) / 2;
    const hz = Math.max(_size.z, 1e-3) / 2;
    const geometry = entry.proxy.geometry;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++)
      position.setXYZ(
        i,
        Math.sign(position.getX(i)) * hx,
        Math.sign(position.getY(i)) * hy,
        Math.sign(position.getZ(i)) * hz,
      );
    position.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    entry.proxy.position.copy(_center);
  }

  /** Uninstalls the hooks, removes every proxy from the graph (its material through `release`) and shows its targets. */
  teardown(release: (material: Material) => void): void {
    for (const restore of this.restores) restore();
    this.restores = [];
    for (const { proxy, targets } of this.entries) {
      proxy.removeFromParent();
      proxy.geometry.dispose();
      release(proxy.material as Material);
      for (const t of targets) t.visible = true;
    }
    this.entries = [];
    this.skippedSynced = 0;
  }
}
