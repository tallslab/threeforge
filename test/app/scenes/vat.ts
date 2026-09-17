import {
  AmbientLight,
  AnimationMixer,
  Color,
  DirectionalLight,
  Matrix4,
  type Object3D,
  Scene,
  type SkinnedMesh,
  Vector3,
} from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { AnimatedInstances, bakeAnimationTexture, disposeLoader } from 'threeforge';
import { assetIndex } from '../assets.js';
import type { BenchBuilder } from './index.js';

/**
 * One skinned Kenney character (left, driven by a mixer) next to its AnimatedInstances twin (right): the two must
 * match at `vatClip` and `vatTime`. `vatPartOffset=x,y,z` moves every skinned part after the first off the character
 * root (the Kenney parts all sit at the root): bound in attached mode the original draws the same wherever its parts
 * sit, so the twin has to draw each part at its own offset to match it.
 */
export const vatScene: BenchBuilder = async ({ camera, params, loader: makeLoader }) => {
  const loader = await makeLoader();
  const kit = (await assetIndex()).find((k) => k.name === 'kenney-mini-characters');
  const file = kit?.glbs?.find((g) => g.toLowerCase().endsWith(`/${params.get('asset') ?? 'character-male-a'}.glb`));
  if (!file) throw new Error('kenney-mini-characters kit not found (run pnpm assets)');
  const gltf = await loader.loadAsync(`/${file}`);
  disposeLoader(loader);
  const scene = new Scene();
  scene.background = new Color(0x202830);
  const clipName = params.get('vatClip') ?? 'idle';
  const partOffset = params.get('vatPartOffset');
  if (partOffset) {
    const [x = 0, y = 0, z = 0] = partOffset.split(',').map(Number);
    const parts: Object3D[] = [];
    gltf.scene.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) parts.push(o);
    });
    for (const part of parts.slice(1)) part.position.add(new Vector3(x, y, z));
    gltf.scene.updateMatrixWorld(true);
  }
  const original = SkeletonUtils.clone(gltf.scene) as Object3D;
  original.position.set(-1, 0, 0);
  scene.add(original);
  const mixer = new AnimationMixer(original);
  const clip = gltf.animations.find((c) => c.name === clipName) ?? gltf.animations[0]!;
  mixer.clipAction(clip).play();
  const animation = bakeAnimationTexture(gltf.scene, gltf.animations, { fps: 30 });
  const vat = new AnimatedInstances({ animation, count: 1 });
  vat.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
  vat.setClipAt(0, clip.name);
  vat.addTo(scene);
  const key = new DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(new AmbientLight(0xffffff, 0.5), key);
  camera.position.set(0, 1.4, 4.5);
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrixWorld();
  const t = Number(params.get('vatTime') ?? '0');
  mixer.setTime(t);
  vat.setTime(t);
  return { scene, counts: {}, vat };
};
