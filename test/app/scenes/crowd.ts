import { AnimationMixer, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PlaneGeometry, type AnimationClip, type Group } from 'three';
import { tag } from 'threeforge';
import type { BenchBuilder } from './index.js';

interface KitIndex {
  name: string;
  error?: string;
  glbs?: string[];
}

const NAMES = ['character-male-a', 'character-male-b', 'character-male-c', 'character-female-a', 'character-female-b', 'character-female-c', 'character-male-d', 'character-female-d'];

/** 200 skinned Kenney mini characters on a grid, every one animating a different clip with its own time offset. */
export const crowd: BenchBuilder = async ({ camera, params, loader: makeLoader }) => {
  const count = Number(params.get('count') ?? '200');
  const loader = await makeLoader();
  const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');
  const kits = (await fetch('/kits-index.json').then((r) => (r.ok ? r.json() : [])).catch(() => [])) as KitIndex[];
  const kit = kits.find((k) => k.name === 'kenney-mini-characters' && !k.error);
  if (!kit?.glbs) throw new Error('kenney-mini-characters kit not found in test/assets/files (run pnpm assets)');
  const protos = await Promise.all(
    NAMES.map(async (name) => {
      const path = kit.glbs!.find((g) => g.toLowerCase().endsWith(`/${name}.glb`));
      if (!path) throw new Error(`${name}.glb missing from the mini-characters kit`);
      const gltf = await loader.loadAsync('/' + path);
      return { scene: gltf.scene, animations: gltf.animations };
    }),
  );
  const { Scene } = await import('three');
  const scene = new Scene();
  scene.name = 'crowd';
  scene.background = new Color(0x1b2028);
  const ground = new Mesh(new PlaneGeometry(80, 50), new MeshStandardMaterial({ color: 0x2f3a44, roughness: 1, metalness: 0 }));
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  tag.static(ground);
  scene.add(ground);
  const mixers: Array<{ mixer: AnimationMixer; offset: number }> = [];
  const animations: Array<{ root: Group; clips: AnimationClip[] }> = [];
  const columns = 20;
  for (let i = 0; i < count; i++) {
    const proto = protos[i % protos.length]!;
    const character = SkeletonUtils.clone(proto.scene) as Group;
    character.name = `character-${i}`;
    character.position.set((i % columns) * 1.6 - (columns - 1) * 0.8, 0, Math.floor(i / columns) * 1.8 - 8);
    character.rotation.y = Math.PI;
    scene.add(character);
    const mixer = new AnimationMixer(character);
    const clip = proto.animations[i % proto.animations.length]!;
    mixer.clipAction(clip).play();
    mixers.push({ mixer, offset: i * 0.13 });
    animations.push({ root: character, clips: proto.animations });
  }
  const sun = new DirectionalLight(0xfff1e0, 2.5);
  sun.name = 'sun';
  sun.position.set(20, 40, 30);
  scene.add(sun, new HemisphereLight(0xbfd7ff, 0x3a3a3a, 0.6));
  camera.near = 0.5;
  camera.far = 300;
  camera.position.set(0, 14, 26);
  camera.lookAt(0, 1, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const setTime = (t: number): void => {
    for (const { mixer, offset } of mixers) mixer.setTime(t + offset);
  };
  setTime(0);
  return { scene, counts: { characters: count }, animations, setTime };
};
