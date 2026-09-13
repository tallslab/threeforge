/**
 * The naive test scene: 500 props, 40 material recipes, a new material instance per prop.
 * Deterministic for a given seed. Imports from 'three' only so it runs in node for unit tests.
 */
import {
  AmbientLight,
  Bone,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DodecahedronGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  OctahedronGeometry,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  RingGeometry,
  Scene,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  SRGBColorSpace,
  TetrahedronGeometry,
  Texture,
  TorusGeometry,
  TorusKnotGeometry,
  Uint16BufferAttribute,
  type MeshStandardMaterialParameters,
} from 'three';
import { tag } from '../../src/tags.js';

export const NAIVE_SCENE = {
  propCount: 500,
  recipeCount: 40,
  dynamicCount: 10,
  geometryCount: 12,
  /** Props are scattered over a square of this side length, centred on the origin. */
  area: 120,
} as const;

export interface MaterialRecipe {
  name: string;
  kind: 'solid' | 'rough-metal' | 'textured' | 'normal-mapped' | 'transparent';
  params: MeshStandardMaterialParameters;
}

export interface NaiveOptions {
  /** Props to scatter (default 500). */
  count?: number;
  /** Distinct geometries: the 12 primitives, then parameter variants of them (default 12). */
  shapes?: number;
}

export interface NaiveScene {
  scene: Scene;
  counts: { props: number; materials: number; shapes: number };
  props: Mesh[];
  dynamics: Mesh[];
  skinned: SkinnedMesh[];
  ground: Mesh;
  geometries: BufferGeometry[];
  recipes: MaterialRecipe[];
  textures: Texture[];
  lights: { ambient: AmbientLight; directional: DirectionalLight };
}

/** Small, fast, deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPE_FACTORIES: Array<(f: number) => BufferGeometry> = [
  (f) => new BoxGeometry(2 * f, 2 / f, 2),
  (f) => new SphereGeometry(1.2 * f, 12, 8),
  (f) => new CylinderGeometry(0.8 * f, 1, 2.5 / f, 12),
  (f) => new ConeGeometry(1 * f, 2.5, 10),
  (f) => new TorusGeometry(1 * f, 0.35, 8, 16),
  (f) => new TorusKnotGeometry(0.8 * f, 0.25, 48, 8),
  (f) => new CapsuleGeometry(0.6 * f, 1.2, 4, 8),
  // Polyhedra are non-indexed in three.js: they exercise index normalisation in the batcher.
  (f) => new DodecahedronGeometry(1.2 * f),
  (f) => new IcosahedronGeometry(1.2 * f),
  (f) => new OctahedronGeometry(1.3 * f),
  (f) => new TetrahedronGeometry(1.4 * f),
  (f) => new RingGeometry(0.5 * f, 1.3 * f, 16),
];

/** The 12 primitives, then parameter variants of them (each further dozen is a different proportion). */
function makeGeometries(shapes: number = NAIVE_SCENE.geometryCount): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let k = 0; k < shapes; k++) out.push(SHAPE_FACTORIES[k % SHAPE_FACTORIES.length]!(1 + 0.15 * Math.floor(k / SHAPE_FACTORIES.length)));
  return out;
}

function makeTexture(rng: () => number, pattern: 'checker' | 'stripes' | 'noise', colorSpace: boolean): DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  const a = [64 + rng() * 191, 64 + rng() * 191, 64 + rng() * 191];
  const b = [64 + rng() * 191, 64 + rng() * 191, 64 + rng() * 191];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let c: number[];
      if (pattern === 'checker') c = ((x >> 2) + (y >> 2)) % 2 === 0 ? a : b;
      else if (pattern === 'stripes') c = (x >> 1) % 2 === 0 ? a : b;
      else c = [a[0]! + (rng() - 0.5) * 60, a[1]! + (rng() - 0.5) * 60, a[2]! + (rng() - 0.5) * 60];
      data[i] = c[0]!;
      data[i + 1] = c[1]!;
      data[i + 2] = c[2]!;
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.magFilter = NearestFilter;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  if (colorSpace) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeNormalMap(rng: () => number): DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 128 + (rng() - 0.5) * 40;
    data[i * 4 + 1] = 128 + (rng() - 0.5) * 40;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 40 recipes: 24 solid colours (identical roughness/metalness, so they merge into one batch via per-instance colour),
 * 4 distinct roughness/metalness pairs, 6 textured, 2 map + normalMap, 4 transparent (2 opacities x 2 colours).
 * Expected static batches after compile: 1 + 4 + 6 + 2 + 2 = 15.
 */
function makeRecipes(rng: () => number, textures: Texture[]): MaterialRecipe[] {
  const recipes: MaterialRecipe[] = [];
  for (let i = 0; i < 24; i++) {
    const hue = i / 24;
    recipes.push({ name: `solid-${i}`, kind: 'solid', params: { color: hsl(hue, 0.6, 0.55), roughness: 0.8, metalness: 0 } });
  }
  const pairs: Array<[number, number]> = [
    [0.2, 0],
    [0.5, 0.5],
    [0.9, 1],
    [0.05, 0.2],
  ];
  pairs.forEach(([roughness, metalness], i) => {
    recipes.push({ name: `rough-metal-${i}`, kind: 'rough-metal', params: { color: 0xb0b8c0, roughness, metalness } });
  });
  const patterns = ['checker', 'stripes', 'noise', 'checker', 'stripes', 'noise'] as const;
  patterns.forEach((pattern, i) => {
    const map = makeTexture(rng, pattern, true);
    textures.push(map);
    recipes.push({ name: `textured-${i}`, kind: 'textured', params: { color: 0xffffff, map, roughness: 0.8, metalness: 0 } });
  });
  for (let i = 0; i < 2; i++) {
    const map = makeTexture(rng, 'checker', true);
    const normalMap = makeNormalMap(rng);
    textures.push(map, normalMap);
    recipes.push({ name: `normal-mapped-${i}`, kind: 'normal-mapped', params: { color: 0xffffff, map, normalMap, roughness: 0.7, metalness: 0 } });
  }
  const transparent: Array<[number, number]> = [
    [0.5, 0x4fa3ff],
    [0.5, 0xff6b6b],
    [0.25, 0x7cff6b],
    [0.25, 0xffd166],
  ];
  transparent.forEach(([opacity, color], i) => {
    recipes.push({ name: `transparent-${i}`, kind: 'transparent', params: { color, opacity, transparent: true, roughness: 0.4, metalness: 0 } });
  });
  return recipes;
}

function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

function makeSkinnedDummy(name: string, x: number, z: number): SkinnedMesh {
  const geometry = new CylinderGeometry(0.5, 0.5, 4, 8, 4);
  const position = geometry.attributes.position!;
  const count = position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const t = (position.getY(i) + 2) / 4;
    skinIndex[i * 4] = 0;
    skinIndex[i * 4 + 1] = 1;
    skinWeight[i * 4] = 1 - t;
    skinWeight[i * 4 + 1] = t;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));

  const root = new Bone();
  const tip = new Bone();
  root.position.y = -2;
  tip.position.y = 4;
  root.add(tip);

  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: 0xffa040, roughness: 0.6, metalness: 0 }));
  mesh.name = name;
  mesh.add(root);
  mesh.bind(new Skeleton([root, tip]));
  mesh.position.set(x, 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildNaiveScene(seed = 1, { count = NAIVE_SCENE.propCount, shapes = NAIVE_SCENE.geometryCount }: NaiveOptions = {}): NaiveScene {
  const rng = mulberry32(seed);
  const scene = new Scene();
  scene.name = 'naive';

  const textures: Texture[] = [];
  const geometries = makeGeometries(shapes);
  const recipes = makeRecipes(rng, textures);

  const dynamicIndices = new Set<number>();
  while (dynamicIndices.size < Math.min(NAIVE_SCENE.dynamicCount, count)) {
    dynamicIndices.add(Math.floor(rng() * count));
  }

  const props: Mesh[] = [];
  const dynamics: Mesh[] = [];
  const half = NAIVE_SCENE.area / 2;
  for (let i = 0; i < count; i++) {
    const geometry = geometries[i % geometries.length]!;
    const recipe = recipes[Math.floor(rng() * recipes.length)]!;
    // The naive part: a brand-new material per prop, never shared.
    const mesh = new Mesh(geometry, new MeshStandardMaterial(recipe.params));
    mesh.name = `prop-${i}`;
    mesh.userData.recipe = recipe.name;
    mesh.position.set(rng() * NAIVE_SCENE.area - half, 0.5 + rng() * 6, rng() * NAIVE_SCENE.area - half);
    mesh.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
    mesh.scale.setScalar(0.8 + rng() * 1.8);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (dynamicIndices.has(i)) {
      tag.dynamic(mesh);
      dynamics.push(mesh);
    } else {
      tag.static(mesh);
    }
    props.push(mesh);
    scene.add(mesh);
  }

  const ground = new Mesh(new PlaneGeometry(NAIVE_SCENE.area * 2, NAIVE_SCENE.area * 2), new MeshStandardMaterial({ color: 0x3a3f47, roughness: 1, metalness: 0 }));
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  tag.static(ground);
  scene.add(ground);

  const skinned = [makeSkinnedDummy('skinned-0', -8, 10), makeSkinnedDummy('skinned-1', 8, 10)];
  for (const s of skinned) scene.add(s);

  const ambient = new AmbientLight(0xffffff, 0.5);
  const directional = new DirectionalLight(0xffffff, 2);
  directional.name = 'sun';
  directional.position.set(40, 60, 30);
  directional.target.position.set(0, 0, 0);
  scene.add(ambient, directional, directional.target);

  return { scene, counts: { props: count, materials: recipes.length, shapes }, props, dynamics, skinned, ground, geometries, recipes, textures, lights: { ambient, directional } };
}
