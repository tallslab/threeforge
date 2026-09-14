import { AmbientLight, Color, DataTexture, DirectionalLight, DodecahedronGeometry, Fog, HemisphereLight, Mesh, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, RGBAFormat, Scene, Sprite, SpriteMaterial, TextureLoader, Vector3 } from 'three';
import { tag } from 'threeforge';
import { mulberry32 } from '../../scenes/naive.js';
import type { BenchBuilder } from './index.js';

/** A 16x16 vertical streak with soft ends: one texture for every raindrop sprite. */
function streakTexture(): DataTexture {
  const size = 16;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = Math.sin((y / (size - 1)) * Math.PI);
    for (let x = 0; x < size; x++) {
      const h = 1 - Math.abs(x - size / 2 + 0.5) / (size / 2);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 235;
      data[o + 3] = Math.round(255 * v * Math.max(0, h) * 0.9);
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

/** Reflective water, 2 000 raindrop sprites, fog, wet ground and rocks: fill rate, not draw calls, is the cost. */
export const lake: BenchBuilder = async ({ camera, params, url }) => {
  const rainCount = Number(params.get('rain') ?? '2000');
  const rng = mulberry32(5);
  const scene = new Scene();
  scene.name = 'lake';
  const fogColor = new Color(0x8a97a8);
  scene.background = fogColor;
  scene.fog = new Fog(fogColor.getHex(), 20, 260);

  const { WaterMesh } = await import('three/addons/objects/WaterMesh.js');
  const normals = await new TextureLoader().loadAsync(url('waternormals/waternormals.jpg'));
  normals.wrapS = normals.wrapT = RepeatWrapping;
  const water = new WaterMesh(new PlaneGeometry(300, 300), { waterNormals: normals, sunDirection: new Vector3(0.3, 0.8, 0.5).normalize(), sunColor: 0xffffff, waterColor: 0x1f4c66, distortionScale: 2.5 });
  water.rotation.x = -Math.PI / 2;
  water.name = 'water';
  scene.add(water);

  const ground = new Mesh(new PlaneGeometry(600, 600), new MeshStandardMaterial({ color: 0x3b4450, roughness: 0.25, metalness: 0 }));
  ground.name = 'wet-ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  tag.static(ground);
  scene.add(ground);

  const rockGeometry = new DodecahedronGeometry(1.5, 0);
  const rockMaterial = new MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.9, metalness: 0 });
  const rocks = 40;
  for (let i = 0; i < rocks; i++) {
    const rock = new Mesh(rockGeometry, rockMaterial);
    rock.name = `rock-${i}`;
    const a = rng() * Math.PI * 2;
    const r = 60 + rng() * 80;
    rock.position.set(Math.cos(a) * r, -0.3, Math.sin(a) * r);
    rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    rock.scale.setScalar(0.8 + rng() * 2);
    tag.static(rock);
    scene.add(rock);
  }

  const drop = new SpriteMaterial({ map: streakTexture(), transparent: true, depthWrite: false, opacity: 0.6 });
  const drops: Array<{ sprite: Sprite; y0: number }> = [];
  for (let i = 0; i < rainCount; i++) {
    const s = new Sprite(drop);
    s.name = `rain-${i}`;
    // The rain volume sits inside the camera's view: fill rate is the point, culled drops cost nothing.
    const y0 = rng() * 28;
    s.position.set(rng() * 44 - 22, y0, rng() * 46 - 28);
    s.scale.set(0.12, 1.4, 1);
    drops.push({ sprite: s, y0 });
    scene.add(s);
  }

  const sun = new DirectionalLight(0xdfe8f5, 1.2);
  sun.name = 'sun';
  sun.position.set(30, 80, 50);
  scene.add(sun, new HemisphereLight(0xa8b6c8, 0x2f3640, 0.7), new AmbientLight(0xffffff, 0.15));
  camera.near = 0.5;
  camera.far = 600;
  camera.position.set(0, 8, 40);
  camera.lookAt(0, 2, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const setTime = (t: number): void => {
    for (const { sprite, y0 } of drops) sprite.position.y = (((y0 - t * 25) % 28) + 28) % 28;
  };
  return { scene, counts: { rain: rainCount, rocks }, setTime };
};
