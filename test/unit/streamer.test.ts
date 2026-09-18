import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  Sprite,
  UnsignedByteType,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { Streamer } from '../../src/streaming/Streamer.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();
const tex = () => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);

/** Every object the streamer still holds in a chunk. */
const placed = (streamer: Streamer): Object3D[] =>
  [
    ...(streamer as unknown as { chunks: Map<string, { placed: Array<{ object: Object3D }> }> }).chunks.values(),
  ].flatMap((c) => c.placed.map((p) => p.object));

/** The chunk the streamer's object index maps an object to, if any. */
const indexed = (streamer: Streamer, object: Object3D): unknown =>
  (streamer as unknown as { index: WeakMap<Object3D, unknown> }).index.get(object);

/** Cells 0..3 along x (chunkSize 20): two batched meshes per cell plus one unique ground tile per cell; tiles 0 and 2 share a texture. */
function world() {
  const scene = new Scene();
  const shared = tex();
  const tiles: Mesh[] = [];
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 2; k++) {
      const m = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x336699 })));
      m.position.set(c * 20 + k * 5, 0, 0);
      scene.add(m);
    }
    const tile = tag.static(
      new Mesh(new BoxGeometry(20, 1, 20), new MeshStandardMaterial({ map: c % 2 === 0 ? shared : tex() })),
    );
    tile.name = `tile-${c}`;
    tile.position.set(c * 20 + 10, -1, 0);
    scene.add(tile);
    tiles.push(tile);
  }
  const camera = new PerspectiveCamera(60, 1, 0.1, 25);
  camera.position.set(10, 5, 0);
  camera.updateMatrixWorld();
  const w = new World(scene, { chunkSize: 20 });
  w.compile();
  return { scene, camera, world: w, tiles, shared };
}

describe('Streamer', () => {
  it('needs a chunked world', () => {
    expect(() => new Streamer({ world: new World(new Scene()), camera: new PerspectiveCamera() })).toThrow(/chunkSize/);
  });

  it('indexes objects by cell, loads within radius and unloads past radius + margin', () => {
    const { scene, camera, world: w, tiles } = world();
    const streamer = new Streamer({ world: w, camera }); // radius = camera.far = 25, margin one cell (20)
    const events: string[] = [];
    streamer.onChange((e) => events.push(`${e.kind} ${e.cell.join(',')}`));
    expect(streamer.stats()).toEqual({ chunks: 4, resident: 4, loads: 0, unloads: 0 });
    // Camera x = 10: cells 0 (0..20) and 1 (20..40, distance 10) are within 25; the first update places strictly, so cells 2 (distance 30) and 3 (distance 50) unload.
    streamer.update();
    expect(streamer.stats()).toEqual({ chunks: 4, resident: 2, loads: 0, unloads: 2 });
    expect(events).toEqual(['unload 2,0,0', 'unload 3,0,0']);
    expect(tiles[3]!.parent).toBeNull();
    expect(scene.getObjectByName('tile-3')).toBeUndefined();
    camera.position.x = 70;
    camera.updateMatrixWorld();
    // Cells 3 (distance 0) and 2 (distance 10) load; cell 0 (distance 50 > 25 + 20) unloads; cell 1 (distance 30) stays by hysteresis.
    streamer.update();
    expect(streamer.stats()).toEqual({ chunks: 4, resident: 3, loads: 2, unloads: 3 });
    expect(tiles[3]!.parent).toBe(scene);
    expect(tiles[0]!.parent).toBeNull();
  });

  it("disposes a chunk's GPU copies on unload unless a resident chunk shares them, and never materials", () => {
    const { camera, world: w, tiles, shared } = world();
    const streamer = new Streamer({ world: w, camera, radius: 15, margin: 0 }); // cells 0 and 1 stay
    const ownTexture = (tiles[3]!.material as MeshStandardMaterial).map!;
    const own = vi.spyOn(ownTexture, 'dispose');
    const sharedSpy = vi.spyOn(shared, 'dispose');
    const geometry = vi.spyOn(tiles[3]!.geometry, 'dispose');
    const material = vi.spyOn(tiles[3]!.material as MeshStandardMaterial, 'dispose');
    streamer.update();
    expect(streamer.stats().resident).toBe(2);
    expect(own).toHaveBeenCalledTimes(1);
    expect(geometry).toHaveBeenCalledTimes(1);
    expect(sharedSpy).not.toHaveBeenCalled(); // tile-0 (resident) shares it with tile-2 (unloaded)
    expect(material).not.toHaveBeenCalled();
    const batch = w.chunks().get('3,0,0')![0]!;
    expect(batch.parent).toBeNull();
    expect((batch as unknown as { _matricesTexture: unknown })._matricesTexture).toBeTruthy(); // not BatchedMesh.dispose()
  });

  it('releases its chunks and object index on dispose', () => {
    const { scene, camera, world: w, tiles } = world();
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 }); // only cell 0 stays
    streamer.update();
    expect(streamer.stats().chunks).toBe(4);
    const batch = w.chunks().get('3,0,0')![0]!;
    w.decompile();
    streamer.dispose();
    // Residency is restored first: what the streamer removed is back under the parent it had.
    expect(tiles[3]!.parent).toBe(scene);
    // Then the streamer lets go: no chunk, no placed object, and nothing of the decompiled World left in the index.
    expect(streamer.stats()).toMatchObject({ chunks: 0, resident: 0 });
    expect(placed(streamer)).toEqual([]);
    expect(indexed(streamer, batch)).toBeUndefined();
    expect(indexed(streamer, tiles[3]!)).toBeUndefined();
    streamer.update(); // nothing left to load or unload
    expect(streamer.stats()).toMatchObject({ chunks: 0, resident: 0 });
  });

  it('honours assign, userData.forgeStream = false, and dispose restores everything', () => {
    const { scene, camera, world: w, tiles } = world();
    tiles[2]!.userData.forgeStream = false;
    const extra = tag.static(new Mesh(box, new MeshStandardMaterial()));
    scene.add(extra);
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 });
    streamer.assign(extra, [3, 0, 0]);
    streamer.update();
    expect(tiles[2]!.parent).toBe(scene);
    expect(extra.parent).toBeNull();
    streamer.dispose();
    expect(extra.parent).toBe(scene);
    expect(tiles[3]!.parent).toBe(scene);
    expect(w.chunks().get('3,0,0')![0]!.parent).toBe(scene);
  });
});

describe('Streamer and sprites', () => {
  it('keeps the geometry every Sprite shares when a chunk holding one unloads', () => {
    const { scene, camera, world: w } = world();
    const sprite = new Sprite();
    scene.add(sprite);
    const shared = vi.spyOn(sprite.geometry, 'dispose');
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 });
    streamer.assign(sprite, [3, 0, 0]);
    streamer.update();
    expect(sprite.parent).toBeNull();
    expect(shared).not.toHaveBeenCalled();
    shared.mockRestore();
  });
});

describe('Streamer and interleaved geometries', () => {
  /** A triangle whose position and uv read from `buffer`, as GLTFLoader builds a bufferView with a byteStride. */
  function interleaved(
    buffer = new InterleavedBuffer(new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 5),
  ): BufferGeometry {
    return new BufferGeometry()
      .setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0))
      .setAttribute('uv', new InterleavedBufferAttribute(buffer, 2, 3));
  }
  const at = (x: number, geometry: BufferGeometry): Mesh => {
    const mesh = tag.static(new Mesh(geometry, new MeshStandardMaterial()));
    mesh.position.set(x, 0, 0);
    return mesh;
  };

  it('frees an interleaved geometry on unload and leaves it drawable', () => {
    const { scene, camera, world: w } = world();
    const packed = at(70, interleaved());
    scene.add(packed);
    const before = packed.geometry.getAttribute('position') as InterleavedBufferAttribute;
    const bufferBefore = before.data;
    const disposed = vi.spyOn(packed.geometry, 'dispose');
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 });
    streamer.update();
    expect(packed.parent).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(streamer.retainedGeometries()).toEqual([]);
    // three r186 cannot upload the same interleaved objects twice: new ones, over the same array.
    const after = packed.geometry.getAttribute('position') as InterleavedBufferAttribute;
    expect(after).not.toBe(before);
    expect(after.data === bufferBefore).toBe(false);
    expect(after.data.array).toBe(bufferBefore.array);
  });

  it('keeps a geometry uploaded while a resident chunk reads its buffer', () => {
    const { scene, camera, world: w } = world();
    const near = at(2, interleaved());
    const shared = (near.geometry.getAttribute('position') as InterleavedBufferAttribute).data;
    const far = at(70, interleaved(shared));
    scene.add(near, far);
    const nearDisposed = vi.spyOn(near.geometry, 'dispose');
    const farDisposed = vi.spyOn(far.geometry, 'dispose');
    camera.position.x = 2;
    camera.updateMatrixWorld();
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 });
    streamer.update();
    // Disposing it would destroy the buffer the resident mesh still draws from.
    expect(far.parent).toBeNull();
    expect(farDisposed).not.toHaveBeenCalled();
    expect(streamer.retainedGeometries()).toEqual([far.geometry]);
    camera.position.x = 500;
    camera.updateMatrixWorld();
    streamer.update();
    expect(nearDisposed).toHaveBeenCalledTimes(1);
    expect(farDisposed).toHaveBeenCalledTimes(1);
    expect(streamer.retainedGeometries()).toEqual([]);
    const buffer = (g: BufferGeometry) => (g.getAttribute('position') as InterleavedBufferAttribute).data;
    expect(buffer(near.geometry), 'still one buffer between them').toBe(buffer(far.geometry));
  });
});

describe('Streamer and buffers read from outside its chunks', () => {
  const packed = (buffer: InterleavedBuffer): BufferGeometry =>
    new BufferGeometry().setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));

  it('keeps a geometry uploaded while a mesh it does not stream draws from its buffer', () => {
    const { scene, camera, world: w } = world();
    const buffer = new InterleavedBuffer(new Float32Array(9), 3);
    const far = tag.static(new Mesh(packed(buffer), new MeshStandardMaterial()));
    far.position.set(70, 0, 0);
    const mover = tag.dynamic(new Mesh(packed(buffer), new MeshStandardMaterial()));
    scene.add(far, mover);
    const disposed = vi.spyOn(far.geometry, 'dispose');
    const streamer = new Streamer({ world: w, camera, radius: 5, margin: 0 });
    streamer.update();
    expect(far.parent).toBeNull();
    expect(disposed).not.toHaveBeenCalled();
    expect(streamer.retainedGeometries()).toEqual([far.geometry]);
  });

  it('frees it when the only other reader is an original hidden from the camera', () => {
    const { scene, camera, world: w } = world();
    const buffer = new InterleavedBuffer(new Float32Array(9), 3);
    const far = tag.static(new Mesh(packed(buffer), new MeshStandardMaterial()));
    far.position.set(70, 0, 0);
    const hidden = tag.dynamic(new Mesh(packed(buffer), new MeshStandardMaterial()));
    hidden.layers.set(FORGE_HIDDEN_LAYER);
    scene.add(far, hidden);
    const disposed = vi.spyOn(far.geometry, 'dispose');
    new Streamer({ world: w, camera, radius: 5, margin: 0 }).update();
    // Nothing draws a hidden original, so three holds no buffer for it to lose.
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});

describe('Streamer construction cost', () => {
  /** `n` static meshes over a 40 x 40 grid of cells in an uncompiled chunked World: construction places every one of them. */
  function spread(n: number): { world: World; camera: PerspectiveCamera } {
    const scene = new Scene();
    const material = new MeshStandardMaterial();
    for (let i = 0; i < n; i++) {
      const mesh = tag.static(new Mesh(box, material));
      mesh.position.set((i % 40) * 20, 0, (Math.floor(i / 40) % 40) * 20);
      scene.add(mesh);
    }
    const camera = new PerspectiveCamera(60, 1, 0.1, 10_000);
    camera.updateMatrixWorld();
    return { world: new World(scene, { chunkSize: 20 }), camera };
  }

  /**
   * How many collection walks `run` performs. `place()` has to know which chunk an object already sits in; before the
   * object index it found that by iterating every chunk and running `findIndex` over that chunk's `placed`
   * array, so a construction walked every chunk once per object and its cost grew with the world. Counting the two
   * primitives such a walk needs — iterating a Map, and `Array.findIndex` — measures exactly that, with no clock in it:
   * deterministic, instant, and unaffected by what else the machine is doing.
   *
   * Limitation, so the proxy is not over-trusted: it counts only those two primitives, so a future rescan written as an
   * indexed `for` loop over an array would not be counted at all. The absolute `< 10` bound below covers that only
   * insofar as such a loop still had to reach the chunks through one of these; a walk built entirely from indexed loops
   * would need a different probe.
   */
  function chunkScans(run: () => void): number {
    let scans = 0;
    const mapProto = Map.prototype as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>;
    const arrayProto = Array.prototype as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>;
    const keys: PropertyKey[] = ['values', 'entries', 'forEach', Symbol.iterator];
    const originals = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    for (const key of [...keys, 'findIndex'] as PropertyKey[]) {
      const proto = key === 'findIndex' ? arrayProto : mapProto;
      const original = proto[key]!;
      originals.set(key, original);
      proto[key] = function (this: unknown, ...args: unknown[]) {
        scans++;
        return original.apply(this, args);
      };
    }
    try {
      run();
    } finally {
      for (const [key, original] of originals) (key === 'findIndex' ? arrayProto : mapProto)[key] = original;
    }
    return scans;
  }

  it('places every object without walking the chunks at construction', () => {
    // Built outside the counted region: only the Streamer's own construction is measured.
    const small = spread(2000);
    const large = spread(20_000);
    let smallStreamer: Streamer | undefined;
    let largeStreamer: Streamer | undefined;
    const smallScans = chunkScans(() => void (smallStreamer = new Streamer(small)));
    const largeScans = chunkScans(() => void (largeStreamer = new Streamer(large)));

    expect(smallStreamer!.stats().chunks).toBe(1600);
    expect(largeStreamer!.stats().chunks).toBe(1600);
    // Ten times the objects over the same 1600 cells must cost the same number of walks. Before the index this was one
    // walk of every chunk per placed object, so these counts were roughly the object count and grew tenfold with it.
    expect(largeScans, `${smallScans} scans placing 2k objects, ${largeScans} placing 20k`).toBe(smallScans);
    expect(smallScans, `${smallScans} scans placing 2k objects`).toBeLessThan(10);
  });
});
