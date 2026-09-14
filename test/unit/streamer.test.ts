import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Mesh, MeshStandardMaterial, PerspectiveCamera, RGBAFormat, Scene, UnsignedByteType } from 'three';
import { World } from '../../src/compiler/World.js';
import { Streamer } from '../../src/streaming/Streamer.js';
import { tag } from '../../src/tags.js';

const box = new BoxGeometry();
const tex = () => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat, UnsignedByteType);

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
    // Camera x = 10: cells 0 (0..20) and 1 (20..40, distance 10) are within 25; cell 2 (distance 30) stays by hysteresis; cell 3 (distance 50) unloads.
    streamer.update();
    expect(streamer.stats()).toEqual({ chunks: 4, resident: 3, loads: 0, unloads: 1 });
    expect(events).toEqual(['unload 3,0,0']);
    expect(tiles[3]!.parent).toBeNull();
    expect(scene.getObjectByName('tile-3')).toBeUndefined();
    camera.position.x = 70;
    camera.updateMatrixWorld();
    // Cell 3 (distance 0) loads; cell 0 (distance 50) unloads; cell 1 (distance 30) stays.
    streamer.update();
    expect(streamer.stats()).toEqual({ chunks: 4, resident: 3, loads: 1, unloads: 2 });
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
