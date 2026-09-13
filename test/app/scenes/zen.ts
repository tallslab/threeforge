import { BoxGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, HemisphereLight, IcosahedronGeometry, Mesh, MeshStandardMaterial, OctahedronGeometry, PlaneGeometry, Scene, TetrahedronGeometry } from 'three';
import { tag } from 'threeforge';
import { mulberry32 } from '../../scenes/naive.js';
import type { BenchBuilder } from './index.js';

const WORLD = 2000;
const CHUNK = 250;

/** A vast low-poly world: 50 000 objects from six shapes and eight pastel materials, spread over 2 km². */
export const zen: BenchBuilder = async ({ camera, params }) => {
  const count = Number(params.get('count') ?? '50000');
  const rng = mulberry32(3);
  const scene = new Scene();
  scene.name = 'zen';
  scene.background = new Color(0xe8ded0);
  const ground = new Mesh(new PlaneGeometry(WORLD, WORLD), new MeshStandardMaterial({ color: 0xd9cdb8, roughness: 1, metalness: 0 }));
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  tag.static(ground);
  scene.add(ground);
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
  camera.far = 1500;
  camera.position.set(0, 30, 0);
  camera.lookAt(300, 0, 300);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return { scene, counts: { objects: count, chunks: (WORLD / CHUNK) ** 2 }, worldOptions: { chunkSize: CHUNK, instanceThreshold: 64 } };
};
