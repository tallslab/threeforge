import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, DirectionalLight, Fog, HemisphereLight, IcosahedronGeometry, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, OctahedronGeometry, PlaneGeometry, RGBAFormat, Scene, SRGBColorSpace, TetrahedronGeometry, UnsignedByteType, type BufferAttribute } from 'three';
import { Streamer, tag } from 'threeforge';
import { mulberry32 } from '../../scenes/naive.js';
import type { BenchBuilder, BenchScene } from './index.js';

const WORLD = 2000;
const CHUNK = 250;
const TILE_SEGMENTS = 24;
const TILE_TEXTURE = 512;
const FAR = 600;

/** A unique 512 × 512 pastel noise texture per ground tile: 1 MB each (1.33 MB with mipmaps), 64 MB for the world. */
function tileTexture(cx: number, cz: number, rng: () => number): DataTexture {
  const data = new Uint8Array(TILE_TEXTURE * TILE_TEXTURE * 4);
  const base = [200 + rng() * 40, 190 + rng() * 40, 170 + rng() * 40] as const;
  for (let i = 0; i < TILE_TEXTURE * TILE_TEXTURE; i++) {
    const x = i % TILE_TEXTURE;
    const y = (i / TILE_TEXTURE) | 0;
    const n = 0.85 + 0.15 * Math.sin((x + cx * 7) * 0.11) * Math.cos((y + cz * 5) * 0.13);
    data[i * 4] = base[0] * n;
    data[i * 4 + 1] = base[1] * n;
    data[i * 4 + 2] = base[2] * n;
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, TILE_TEXTURE, TILE_TEXTURE, RGBAFormat, UnsignedByteType);
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A vast low-poly world: 50 000 objects from six shapes and eight pastel materials over 2 km², on 64 ground tiles
 * (one per 250 m chunk, each with its own texture and gently displaced geometry). Fog hides the far plane at 600 m.
 * The optimized variant compiles in 250 m chunks and streams them with the camera (`Streamer`).
 */
export const zen: BenchBuilder = async ({ camera, params }) => {
  const count = Number(params.get('count') ?? '50000');
  const rng = mulberry32(3);
  const scene = new Scene();
  scene.name = 'zen';
  scene.background = new Color(0xe8ded0);
  scene.fog = new Fog(0xe8ded0, 350, FAR);
  const cells = WORLD / CHUNK;
  for (let cz = 0; cz < cells; cz++) {
    for (let cx = 0; cx < cells; cx++) {
      const geometry = new PlaneGeometry(CHUNK, CHUNK, TILE_SEGMENTS, TILE_SEGMENTS);
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.attributes.position as BufferAttribute;
      const ox = (cx + 0.5) * CHUNK - WORLD / 2;
      const oz = (cz + 0.5) * CHUNK - WORLD / 2;
      for (let i = 0; i < position.count; i++) position.setY(i, 0.5 * Math.sin((position.getX(i) + ox) / 40) * Math.cos((position.getZ(i) + oz) / 40));
      geometry.computeVertexNormals();
      const tile = new Mesh(geometry, new MeshStandardMaterial({ map: tileTexture(cx, cz, rng), roughness: 1, metalness: 0 }));
      tile.name = `tile-${cx}-${cz}`;
      tile.position.set(ox, 0, oz);
      tag.static(tile);
      scene.add(tile);
    }
  }
  const shapes = [new IcosahedronGeometry(1, 0), new ConeGeometry(0.8, 2, 5), new BoxGeometry(1.2, 1.2, 1.2), new CylinderGeometry(0.4, 0.4, 1.5, 6), new TetrahedronGeometry(1.1), new OctahedronGeometry(1)];
  const palette = [0xf2b5a7, 0xa7d8f2, 0xb8e0b0, 0xf2e2a7, 0xd9b8f2, 0xa7f2e6, 0xf2c8a7, 0xc4c9d6];
  const materials = palette.map((color) => new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 }));
  for (let i = 0; i < count; i++) {
    const mesh = new Mesh(shapes[i % shapes.length]!, materials[(i * 7) % materials.length]!);
    mesh.name = `zen-${i}`;
    mesh.position.set(rng() * WORLD - WORLD / 2, 0.6 + rng() * 0.8, rng() * WORLD - WORLD / 2);
    mesh.rotation.y = rng() * Math.PI * 2;
    mesh.scale.setScalar(0.6 + rng() * 1.6);
    tag.static(mesh);
    scene.add(mesh);
  }
  const sun = new DirectionalLight(0xfff4e6, 2);
  sun.name = 'sun';
  sun.position.set(300, 500, 200);
  scene.add(sun, new HemisphereLight(0xdde8ff, 0xb0a090, 0.7));
  camera.near = 0.5;
  camera.far = FAR;
  camera.position.set(0, 30, 0);
  camera.lookAt(300, 0, 300);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  let streamer: Streamer | null = null;
  const result: BenchScene = {
    scene,
    counts: { objects: count, chunks: cells * cells },
    worldOptions: { chunkSize: CHUNK, instanceThreshold: 64, originals: 'detach' },
    setTime: () => {
      streamer?.update();
    },
    after: (world) => {
      streamer = new Streamer({ world, camera, radius: FAR });
      result.streamer = streamer;
      streamer.update();
    },
  };
  return result;
};
