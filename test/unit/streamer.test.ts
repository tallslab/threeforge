import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Mesh, MeshStandardMaterial, PerspectiveCamera, RGBAFormat, Scene, UnsignedByteType, type Object3D } from 'three';
import { World } from '../../src/compiler/World.js';
import { Streamer } from '../../src/streaming/Streamer.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();
const tex = () => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);

/** Every object the streamer still holds in a chunk. */
const placed = (streamer: Streamer): Object3D[] =>
  [...(streamer as unknown as { chunks: Map<string, { placed: Array<{ object: Object3D }> }> }).chunks.values()].flatMap((c) => c.placed.map((p) => p.object));

/** The chunk the streamer's object index maps an object to, if any. */
const indexed = (streamer: Streamer, object: Object3D): unknown => (streamer as unknown as { index: WeakMap<Object3D, unknown> }).index.get(object);

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
    const tile = tag.static(new Mesh(new BoxGeometry(20, 1, 20), new MeshStandardMaterial({ map: c % 2 === 0 ? shared : tex() })));
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

  it('indexes compiled objects and static tiles by cell, loads within radius and unloads past radius + margin', () => {
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

  it('releases its chunks and its object index on dispose, so a decompiled World is not kept alive by the streamer', () => {
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
   * object index (d614d4e) it found that by iterating every chunk and running `findIndex` over that chunk's `placed`
   * array, so a construction walked every chunk once per object and its cost grew with the world. Counting the two
   * primitives such a walk needs — iterating a Map, and `Array.findIndex` — measures exactly that, with no clock in it:
   * deterministic, instant, and unaffected by what else the machine is doing.
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

  it('places every object without walking the chunks, so construction scans do not grow with the object count', () => {
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
