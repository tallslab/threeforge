import { type BufferGeometry, type Camera, type Mesh, type Object3D, type Texture, Vector3 } from 'three';
import type { World } from '../compiler/World.js';
import { collectResources, emptyResourceSets, isInterleavedGeometry, type ResourceSets } from '../memory/resources.js';
import { tag } from '../tags.js';

export interface StreamerOptions {
  world: World;
  camera: Camera;
  /** Load distance in world units from the camera to a cell's box (default `camera.far`, so nothing visible ever pops). */
  radius?: number;
  /** Cells of hysteresis: a resident chunk unloads only past `radius + margin × chunkSize` (default 1). */
  margin?: number;
}

export interface StreamerStats {
  chunks: number;
  resident: number;
  loads: number;
  unloads: number;
}

export interface StreamerEvent {
  kind: 'load' | 'unload';
  cell: [number, number, number];
  objects: Object3D[];
}

interface Placed {
  object: Object3D;
  parent: Object3D | null;
}

interface Chunk {
  key: string;
  cell: [number, number, number];
  placed: Placed[];
  resources: ResourceSets;
  resident: boolean;
}

const _position = new Vector3();

/**
 * Residency of compiled chunks by distance from the camera. The index is `world.chunks()` (batches, instanced
 * groups and baked meshes per cell) plus every static mesh that is a direct child of the scene and was not compiled
 * (terrain tiles, singletons), placed by the cell of its world position. A non-resident chunk's objects leave the
 * scene and their geometries and textures are disposed unless a resident chunk still references them; three
 * re-uploads them when the chunk comes back. Interleaved geometries (glTF bufferViews with a byteStride, and the one
 * every Sprite shares) are the exception and stay uploaded: three r186 on WebGPU cannot upload one a second time, see
 * `isInterleavedGeometry`. Materials are never disposed (the registry owns them), and the CPU copies stay in the JS
 * heap: nothing is re-fetched. Cells are keyed by x and z (y is ignored: streaming is horizontal), so compiled cells
 * stacked vertically load and unload together.
 */
export class Streamer {
  private readonly world: World;
  private readonly camera: Camera;
  private readonly size: number;
  private readonly radius: number;
  private readonly margin: number;
  private readonly chunks = new Map<string, Chunk>();
  /**
   * The chunk each placed object sits in, so placing one costs a lookup instead of a scan of every chunk. Weak on
   * purpose: the index alone never keeps an object alive, so the batches a `World.decompile()` drops are not held by it.
   */
  private readonly index = new WeakMap<Object3D, Chunk>();
  private readonly listeners = new Set<(event: StreamerEvent) => void>();
  private loads = 0;
  private unloads = 0;
  /** The first update places every chunk strictly by `radius`; hysteresis applies to the transitions after it. */
  private placed = false;

  constructor(options: StreamerOptions) {
    const size = options.world.chunkSize;
    if (!size) throw new Error('Streamer needs World({ chunkSize })');
    this.world = options.world;
    this.camera = options.camera;
    this.size = size;
    this.radius = options.radius ?? (options.camera as { far?: number }).far ?? Infinity;
    this.margin = (options.margin ?? 1) * size;
    for (const [key, objects] of options.world.chunks()) {
      const cell = key.split(',').map(Number) as [number, number, number];
      for (const object of objects) this.place(object, cell);
    }
    for (const child of [...options.world.scene.children])
      if (this.streamable(child)) this.place(child, this.cellOf(child));
  }

  /** Static meshes the compiler left as their own draws; compiled originals and outputs are handled through the index. */
  private streamable(object: Object3D): boolean {
    const mesh = object as Object3D & { isMesh?: boolean; isSprite?: boolean };
    if (!mesh.isMesh || mesh.isSprite) return false;
    if (tag.of(object) !== 'static' || object.userData.forgeStream === false) return false;
    if (this.world.slotOf(object as Mesh)) return false;
    return object.userData.forgeChunk === undefined;
  }

  private cellOf(object: Object3D): [number, number, number] {
    object.updateWorldMatrix(true, false);
    const e = object.matrixWorld.elements;
    return [Math.floor(e[12]! / this.size), Math.floor(e[13]! / this.size), Math.floor(e[14]! / this.size)];
  }

  private place(object: Object3D, cellIn: [number, number, number]): void {
    // Streaming is horizontal: chunks are keyed by x and z, so a tile below y = 0 joins the batches above it.
    const cell: [number, number, number] = [cellIn[0], 0, cellIn[2]];
    // An object is placed in at most one chunk, so only the one the index names has to give it up.
    const previous = this.index.get(object);
    if (previous) {
      const i = previous.placed.findIndex((p) => p.object === object);
      if (i >= 0) previous.placed.splice(i, 1);
      previous.resources = this.resourcesOf(previous);
    }
    const key = cell.join(',');
    let chunk = this.chunks.get(key);
    if (!chunk)
      this.chunks.set(key, (chunk = { key, cell, placed: [], resources: emptyResourceSets(), resident: true }));
    chunk.placed.push({ object, parent: object.parent });
    this.index.set(object, chunk);
    collectResources(object, chunk.resources);
    if (!chunk.resident) object.removeFromParent();
  }

  private resourcesOf(chunk: Chunk): ResourceSets {
    const sets = emptyResourceSets();
    for (const p of chunk.placed) collectResources(p.object, sets);
    return sets;
  }

  /** Puts an object under a cell: one the compiler did not place, or one whose position cell is not where it belongs. */
  assign(object: Object3D, cell: [number, number, number]): void {
    this.place(object, cell);
  }

  /** Distance from the camera to the cell's box in the ground plane (y ignored). */
  private distance(cell: [number, number, number]): number {
    _position.setFromMatrixPosition(this.camera.matrixWorld);
    const dx = Math.max(cell[0] * this.size - _position.x, 0, _position.x - (cell[0] + 1) * this.size);
    const dz = Math.max(cell[2] * this.size - _position.z, 0, _position.z - (cell[2] + 1) * this.size);
    return Math.hypot(dx, dz);
  }

  /** Loads and unloads chunks for the camera's current position; call it every frame or from a camera watcher. */
  update(): StreamerStats {
    const unloadBeyond = this.placed ? this.radius + this.margin : this.radius;
    this.placed = true;
    for (const chunk of this.chunks.values()) {
      const d = this.distance(chunk.cell);
      if (!chunk.resident && d <= this.radius) this.load(chunk);
      else if (chunk.resident && d > unloadBeyond) this.unload(chunk);
    }
    return this.stats();
  }

  private load(chunk: Chunk): void {
    for (const p of chunk.placed) p.parent?.add(p.object);
    chunk.resident = true;
    this.loads++;
    this.emit({ kind: 'load', cell: chunk.cell, objects: chunk.placed.map((p) => p.object) });
  }

  private unload(chunk: Chunk): void {
    for (const p of chunk.placed) {
      p.parent = p.object.parent;
      p.object.removeFromParent();
    }
    chunk.resident = false;
    this.unloads++;
    const resident = [...this.chunks.values()].filter((c) => c.resident);
    const held = <T>(pick: (s: ResourceSets) => Set<T>, item: T): boolean =>
      resident.some((c) => pick(c.resources).has(item));
    for (const g of chunk.resources.geometries)
      if (!held((s) => s.geometries, g) && !isInterleavedGeometry(g)) g.dispose();
    for (const t of chunk.resources.textures) if (!held((s) => s.textures, t)) t.dispose();
    for (const p of chunk.placed) {
      // BatchedMesh.dispose() nulls these; disposing them directly frees the GPU copies and three re-uploads on the next render.
      const batch = p.object as Object3D & {
        isBatchedMesh?: boolean;
        _matricesTexture?: Texture | null;
        _indirectTexture?: Texture | null;
        _colorsTexture?: Texture | null;
      };
      if (batch.isBatchedMesh)
        for (const t of [batch._matricesTexture, batch._indirectTexture, batch._colorsTexture]) t?.dispose();
    }
    this.emit({ kind: 'unload', cell: chunk.cell, objects: chunk.placed.map((p) => p.object) });
  }

  stats(): StreamerStats {
    let resident = 0;
    for (const c of this.chunks.values()) if (c.resident) resident++;
    return { chunks: this.chunks.size, resident, loads: this.loads, unloads: this.unloads };
  }

  /** Geometries of non-resident chunks that stayed on the GPU; an attached ledger allows them instead of reporting a leak. */
  retainedGeometries(): BufferGeometry[] {
    const kept = new Set<BufferGeometry>();
    for (const chunk of this.chunks.values())
      if (!chunk.resident) for (const g of chunk.resources.geometries) if (isInterleavedGeometry(g)) kept.add(g);
    return [...kept];
  }

  onChange(listener: (event: StreamerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StreamerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Every chunk resident again, then the chunks and the index released (`stats()` reports none) and listeners dropped. */
  dispose(): void {
    for (const chunk of this.chunks.values()) {
      if (chunk.resident) continue;
      for (const p of chunk.placed) p.parent?.add(p.object);
      chunk.resident = true;
    }
    // Let go of the World's objects: a disposed Streamer holds none of what a later `decompile()` wants to drop.
    for (const chunk of this.chunks.values()) for (const p of chunk.placed) this.index.delete(p.object);
    this.chunks.clear();
    this.listeners.clear();
  }
}
