/**
 * The scale scene: many instances of a few geometries under one material recipe, spread over a large field so a
 * camera at ground level sees only a small fraction. Exercises per-instance culling and instancing.
 */
import { AmbientLight, BoxGeometry, BufferGeometry, ConeGeometry, DirectionalLight, Mesh, MeshStandardMaterial, Scene, SphereGeometry } from 'three';
import { tag } from '../../src/tags.js';
import { mulberry32 } from './naive.js';

export interface FieldOptions {
  count?: number;
  area?: number;
  seed?: number;
}

export interface FieldScene {
  scene: Scene;
  props: Mesh[];
  geometries: BufferGeometry[];
  area: number;
}

export function buildFieldScene({ count = 20_000, area = 2000, seed = 7 }: FieldOptions = {}): FieldScene {
  const rng = mulberry32(seed);
  const scene = new Scene();
  scene.name = 'field';
  const geometries = [new BoxGeometry(2, 2, 2), new SphereGeometry(1.2, 8, 6), new ConeGeometry(1, 3, 8)];
  const props: Mesh[] = [];
  const half = area / 2;
  for (let i = 0; i < count; i++) {
    const mesh = new Mesh(geometries[i % geometries.length]!, new MeshStandardMaterial({ color: Math.floor(rng() * 0xffffff), roughness: 0.8, metalness: 0 }));
    mesh.name = `field-${i}`;
    mesh.position.set(rng() * area - half, 1 + rng() * 2, rng() * area - half);
    mesh.rotation.y = rng() * Math.PI * 2;
    tag.static(mesh);
    props.push(mesh);
    scene.add(mesh);
  }
  scene.add(new AmbientLight(0xffffff, 0.5), new DirectionalLight(0xffffff, 2));
  return { scene, props, geometries, area };
}
