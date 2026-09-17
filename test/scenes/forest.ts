/**
 * The forest benchmark: a displaced terrain, 5 000 trees of three species (one merged geometry and one material
 * per species, trunk and crown coloured by vertex colour) and 2 000 grass patches. Everything static; the
 * naive assembly is one mesh per tree and per patch. Imports from 'three' and the pure BufferGeometryUtils addon.
 */
import {
  AmbientLight,
  BufferAttribute,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { tag } from '../../src/tags.js';
import { mulberry32 } from './naive.js';

export interface ForestOptions {
  trees?: number;
  grass?: number;
  /** Side length of the square terrain. */
  area?: number;
  seed?: number;
}

export interface ForestScene {
  scene: Scene;
  terrain: Mesh;
  trees: Mesh[];
  grass: Mesh[];
  species: BufferGeometry[];
  counts: { trees: number; grass: number; species: number };
  heightAt(x: number, z: number): number;
}

function colored(geometry: BufferGeometry, rgb: [number, number, number]): BufferGeometry {
  const n = geometry.attributes.position!.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(rgb, i * 3);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

/** Trunk plus crown merged into one indexed geometry; the crown is lifted onto the trunk. */
function tree(
  trunk: BufferGeometry,
  trunkHeight: number,
  crown: BufferGeometry,
  crownLift: number,
  bark: [number, number, number],
  leaf: [number, number, number],
): BufferGeometry {
  trunk.translate(0, trunkHeight / 2, 0);
  crown.translate(0, crownLift, 0);
  // Polyhedra come non-indexed; merging needs every part indexed (and LOD generation prefers it).
  const indexed = (g: BufferGeometry): BufferGeometry => (g.index ? g : mergeVertices(g));
  const merged = mergeGeometries([colored(indexed(trunk), bark), colored(indexed(crown), leaf)], false);
  if (!merged) throw new Error('tree geometries did not merge');
  merged.computeBoundingSphere();
  return merged;
}

export function makeSpecies(): BufferGeometry[] {
  const bark: [number, number, number] = [0.36, 0.25, 0.15];
  return [
    tree(new CylinderGeometry(0.25, 0.35, 3, 7), 3, new ConeGeometry(2, 7, 9), 6.2, bark, [0.12, 0.38, 0.18]),
    tree(new CylinderGeometry(0.4, 0.5, 4, 7), 4, new IcosahedronGeometry(3, 1), 6, bark, [0.25, 0.5, 0.2]),
    tree(
      new CylinderGeometry(0.15, 0.2, 5, 6),
      5,
      new SphereGeometry(1.8, 8, 6),
      6,
      [0.85, 0.85, 0.8],
      [0.55, 0.7, 0.25],
    ),
  ];
}

/** Six radial blades, each a quad: 12 triangles, drawn double-sided. */
export function makeGrassTuft(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let b = 0; b < 6; b++) {
    const a = (b / 6) * Math.PI * 2;
    const dx = Math.cos(a) * 0.15;
    const dz = Math.sin(a) * 0.15;
    const base = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 0.8, dz, -dx, 0.8, -dz);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new (Object.getPrototypeOf(new PlaneGeometry()).constructor as new () => BufferGeometry)();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

export function buildForestScene({
  trees = 5000,
  grass = 2000,
  area = 900,
  seed = 7,
}: ForestOptions = {}): ForestScene {
  const rng = mulberry32(seed);
  const scene = new Scene();
  scene.name = 'forest';
  const heightAt = (x: number, z: number): number =>
    6 * Math.sin(x / 90) * Math.cos(z / 110) + 2 * Math.sin((x + z) / 37);

  const terrainGeometry = new PlaneGeometry(area, area, 96, 96);
  terrainGeometry.rotateX(-Math.PI / 2);
  const pos = terrainGeometry.attributes.position!;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  terrainGeometry.computeVertexNormals();
  const terrain = new Mesh(terrainGeometry, new MeshStandardMaterial({ color: 0x5a6b3a, roughness: 1, metalness: 0 }));
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  tag.static(terrain);
  scene.add(terrain);

  const species = makeSpecies();
  const speciesMaterials = species.map(
    () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
  );
  const treeMeshes: Mesh[] = [];
  const half = area / 2;
  for (let i = 0; i < trees; i++) {
    const k = i % species.length;
    const mesh = new Mesh(species[k]!, speciesMaterials[k]!);
    mesh.name = `tree-${i}`;
    const x = rng() * area - half;
    const z = rng() * area - half;
    mesh.position.set(x, heightAt(x, z) - 0.2, z);
    mesh.rotation.y = rng() * Math.PI * 2;
    mesh.scale.setScalar(0.8 + rng() * 0.6);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    tag.static(mesh);
    treeMeshes.push(mesh);
    scene.add(mesh);
  }

  const tuft = makeGrassTuft();
  const grassMaterial = new MeshStandardMaterial({ color: 0x4f8a3a, roughness: 1, metalness: 0, side: DoubleSide });
  const grassMeshes: Mesh[] = [];
  for (let i = 0; i < grass; i++) {
    const mesh = new Mesh(tuft, grassMaterial);
    mesh.name = `grass-${i}`;
    const x = rng() * area - half;
    const z = rng() * area - half;
    mesh.position.set(x, heightAt(x, z), z);
    mesh.rotation.y = rng() * Math.PI * 2;
    mesh.scale.setScalar(1 + rng());
    tag.static(mesh);
    grassMeshes.push(mesh);
    scene.add(mesh);
  }

  const sun = new DirectionalLight(0xfff2e0, 2.2);
  sun.name = 'sun';
  sun.position.set(200, 300, 100);
  scene.add(new AmbientLight(0xffffff, 0.3), new HemisphereLight(0xbfd7ff, 0x3a4a2a, 0.5), sun);
  return {
    scene,
    terrain,
    trees: treeMeshes,
    grass: grassMeshes,
    species,
    counts: { trees, grass, species: species.length },
    heightAt,
  };
}
