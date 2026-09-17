/**
 * A full biome stress scene assembled from the downloaded CC0 kits: heightfield terrain with vertex colours,
 * three's TSL WaterMesh, thousands of scattered Kenney nature props, a suburban block with roads, Kenney cars and
 * the three.js Ferrari as dynamics, and a few hi-poly Poly Haven props. Browser only (loads GLBs).
 */
import {
  AmbientLight,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  type Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  TextureLoader,
  Vector3,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { tag } from 'threeforge';
import { mulberry32 } from '../scenes/naive.js';

export interface BiomeOptions {
  loader: GLTFLoader;
  /** Scale for the scatter counts (1 = full biome, 0.25 = quick). */
  density?: number;
  seed?: number;
  water?: boolean;
  hiPoly?: boolean;
}

export interface Biome {
  scene: Scene;
  terrain: Mesh;
  water: Object3D | null;
  heightAt(x: number, z: number): number;
  counts: Record<string, number>;
  cars: Object3D[];
  size: number;
}

interface KitIndex {
  name: string;
  kind?: string;
  glbs?: string[];
  entry?: string;
  error?: string;
}

function noise2(x: number, z: number): number {
  // Cheap deterministic value noise: a few sines at different frequencies.
  return (
    Math.sin(x * 0.011) * Math.cos(z * 0.013) * 0.55 +
    Math.sin(x * 0.037 + 1.3) * Math.cos(z * 0.029 + 0.7) * 0.3 +
    Math.sin(x * 0.11 + z * 0.09) * 0.15
  );
}

export async function buildBiome({
  loader,
  density = 1,
  seed = 11,
  water = true,
  hiPoly = true,
}: BiomeOptions): Promise<Biome> {
  const rng = mulberry32(seed);
  const scene = new Scene();
  scene.name = 'biome';
  scene.background = new Color(0x8fb6d9);
  const size = 800;
  const counts: Record<string, number> = {};

  // Terrain: 256 x 256 heightfield, vertex colours by height and slope, one material.
  const segments = 255;
  const geometry = new PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position!;
  const colors = new Float32Array(position.count * 3);
  const heightAt = (x: number, z: number): number => {
    const d = Math.hypot(x, z) / (size / 2);
    const bowl = Math.max(0, 1 - d * d) * 6; // lower centre so the water pools
    return noise2(x, z) * 28 + 12 - bowl;
  };
  const sand = new Color(0xc9b784);
  const grass = new Color(0x4f8a3a);
  const rock = new Color(0x6f6a62);
  const snow = new Color(0xeef2f5);
  const c = new Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const y = heightAt(x, z);
    position.setY(i, y);
    if (y < 1) c.copy(sand);
    else if (y < 18) c.copy(grass).lerp(rock, Math.max(0, (y - 12) / 6));
    else c.copy(rock).lerp(snow, Math.min(1, (y - 18) / 10));
    c.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const terrain = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  terrain.name = 'terrain';
  terrain.receiveShadow = true;
  tag.static(terrain);
  scene.add(terrain);
  counts.terrainVertices = position.count;

  // Water: three's TSL water at y = 0 (the bowl fills).
  let waterMesh: Object3D | null = null;
  if (water) {
    const { WaterMesh } = await import('three/addons/objects/WaterMesh.js');
    const normals = await new TextureLoader().loadAsync('/waternormals/waternormals.jpg');
    normals.wrapS = normals.wrapT = RepeatWrapping;
    const w = new WaterMesh(new PlaneGeometry(size * 1.5, size * 1.5), {
      waterNormals: normals,
      sunDirection: new Vector3(0.5, 0.8, 0.3).normalize(),
      sunColor: 0xffffff,
      waterColor: 0x1f5c7a,
      distortionScale: 3,
    });
    w.rotation.x = -Math.PI / 2;
    w.position.y = 0;
    w.name = 'water';
    waterMesh = w;
    scene.add(w);
  }

  // Kits.
  const lists = (
    await Promise.all(
      ['/index.json', '/kits-index.json'].map((u) =>
        fetch(u)
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
      ),
    )
  ).flat() as KitIndex[];
  const kit = (name: string) => lists.find((k) => k.name === name && k.kind === 'kit' && !k.error)?.glbs ?? [];
  const pickGlbs = (glbs: string[], patterns: RegExp[], max: number) =>
    glbs.filter((g) => patterns.some((p) => p.test(g))).slice(0, max);
  const cache = new Map<string, Group>();
  const load = async (path: string): Promise<Group | null> => {
    if (cache.has(path)) return cache.get(path)!;
    try {
      const gltf = await loader.loadAsync('/' + path);
      cache.set(path, gltf.scene);
      return gltf.scene;
    } catch {
      return null;
    }
  };
  const place = (
    proto: Group,
    x: number,
    z: number,
    y: number,
    rot: number,
    scale: number,
    dynamic = false,
  ): Object3D => {
    const clone = proto.clone();
    clone.position.set(x, y, z);
    clone.rotation.y = rot;
    clone.scale.setScalar(scale);
    clone.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (dynamic) tag.dynamic(o);
        else tag.static(o);
      }
    });
    scene.add(clone);
    return clone;
  };
  const scatter = async (
    glbs: string[],
    count: number,
    label: string,
    scale: [number, number],
    minY = 1.5,
    maxY = 40,
  ): Promise<void> => {
    const protos = (await Promise.all(glbs.map(load))).filter((g): g is Group => g !== null);
    if (protos.length === 0) return;
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 4) {
      attempts++;
      const x = rng() * size - size / 2;
      const z = rng() * size - size / 2;
      const y = heightAt(x, z);
      if (y < minY || y > maxY) continue;
      place(
        protos[Math.floor(rng() * protos.length)]!,
        x,
        z,
        y + 0.03,
        rng() * Math.PI * 2,
        scale[0] + rng() * (scale[1] - scale[0]),
      );
      placed++;
    }
    counts[label] = placed;
  };

  const nature = kit('kenney-nature-kit');
  await scatter(pickGlbs(nature, [/tree_/i, /Tree/], 40), Math.round(2500 * density), 'trees', [2.5, 4.5], 2, 26);
  await scatter(pickGlbs(nature, [/rock/i, /stone/i], 30), Math.round(900 * density), 'rocks', [2, 5], 0.5, 60);
  await scatter(
    pickGlbs(nature, [/grass/i, /flower/i, /plant/i, /mushroom/i, /bush/i], 40),
    Math.round(4000 * density),
    'grass',
    [2, 3.5],
    1.5,
    22,
  );
  await scatter(
    pickGlbs(nature, [/log/i, /stump/i, /fence/i, /crop/i, /cactus/i], 30),
    Math.round(500 * density),
    'clutter',
    [2, 3.5],
    1.5,
    24,
  );
  const survival = kit('kenney-survival-kit');
  await scatter(pickGlbs(survival, [/./], 80), Math.round(400 * density), 'props', [2, 3], 1.5, 22);

  // A suburban block on a flattish area near the centre-east: roads on a grid, houses beside them.
  const roads = kit('kenney-city-kit-roads');
  const suburb = kit('kenney-city-kit-suburban');
  const roadProtos = (
    await Promise.all(pickGlbs(roads, [/road.*straight/i, /road-straight/i, /straight/i], 4).map(load))
  ).filter((g): g is Group => g !== null);
  const houseProtos = (await Promise.all(pickGlbs(suburb, [/house|building|garage|shop/i], 20).map(load))).filter(
    (g): g is Group => g !== null,
  );
  const cx = 150;
  const cz = 60;
  let roadCount = 0;
  let houseCount = 0;
  if (roadProtos.length > 0) {
    for (let i = -8; i <= 8; i++) {
      for (const [dx, dz, rot] of [
        [i * 6, 0, 0],
        [0, i * 6, Math.PI / 2],
      ] as Array<[number, number, number]>) {
        const x = cx + dx;
        const z = cz + dz;
        place(roadProtos[0]!, x, z, heightAt(x, z) + 0.05, rot, 6);
        roadCount++;
      }
    }
  }
  if (houseProtos.length > 0) {
    for (let i = -7; i <= 7; i += 2) {
      const spots: Array<[number, number]> = [
        [i * 6, 12],
        [i * 6, -12],
        [12, i * 6],
        [-12, i * 6],
      ];
      for (const [dx, dz] of spots) {
        const x = cx + dx;
        const z = cz + dz;
        place(houseProtos[Math.floor(rng() * houseProtos.length)]!, x, z, heightAt(x, z), rng() > 0.5 ? 0 : Math.PI, 5);
        houseCount++;
      }
    }
  }
  counts.roads = roadCount;
  counts.houses = houseCount;

  // Cars: Kenney cars on the roads (dynamic) and the Ferrari as a hero car.
  const cars: Object3D[] = [];
  const carProtos = (await Promise.all(pickGlbs(kit('kenney-car-kit'), [/./], 30).map(load))).filter(
    (g): g is Group => g !== null,
  );
  for (let i = 0; i < Math.round(40 * density) && carProtos.length > 0; i++) {
    const along = rng() * 90 - 45;
    const onX = rng() > 0.5;
    const x = cx + (onX ? along : 2.2);
    const z = cz + (onX ? 2.2 : along);
    cars.push(
      place(
        carProtos[Math.floor(rng() * carProtos.length)]!,
        x,
        z,
        heightAt(x, z) + 0.1,
        onX ? Math.PI / 2 : 0,
        5,
        true,
      ),
    );
  }
  const ferrari = await load('ferrari/ferrari.glb');
  if (ferrari) cars.push(place(ferrari, cx + 20, cz + 20, heightAt(cx + 20, cz + 20) + 0.1, 0.8, 4, true));
  counts.cars = cars.length;

  // Hi-poly Poly Haven props, few but heavy.
  if (hiPoly) {
    const entry = (name: string) => lists.find((k) => k.name === name && k.entry && !k.error)?.entry;
    const boulder = entry('polyhaven-boulder_01');
    const sapling = entry('polyhaven-fir_sapling');
    const rocks = entry('polyhaven-coast_rocks_01');
    let heavy = 0;
    for (const [path, n, scale] of [
      [boulder, Math.round(24 * density), 6],
      [rocks, Math.round(6 * density), 4],
      [sapling, Math.round(16 * density), 8],
    ] as Array<[string | undefined, number, number]>) {
      if (!path) continue;
      const proto = await load(path);
      if (!proto) continue;
      for (let i = 0; i < n; i++) {
        const x = rng() * size - size / 2;
        const z = rng() * size - size / 2;
        const y = heightAt(x, z);
        if (y < 1) continue;
        place(proto, x, z, y, rng() * Math.PI * 2, scale);
        heavy++;
      }
    }
    counts.hiPoly = heavy;
  }

  const sun = new DirectionalLight(0xfff2dc, 2.2);
  sun.name = 'sun';
  sun.position.set(200, 320, 120);
  scene.add(new AmbientLight(0xbfd4ff, 0.55), sun, sun.target);
  return { scene, terrain, water: waterMesh, heightAt, counts, cars, size };
}
