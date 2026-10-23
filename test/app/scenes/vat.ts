import {
  AmbientLight,
  AnimationMixer,
  Color,
  DirectionalLight,
  LoopOnce,
  Matrix4,
  type Object3D,
  Scene,
  type SkinnedMesh,
  Vector3,
} from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { uniform } from 'three/tsl';
import { MeshToonNodeMaterial } from 'three/webgpu';
import { AnimatedInstances, bakeAnimationTexture, disposeLoader } from 'threeforge';
import { assetIndex } from '../assets.js';
import type { BenchBuilder } from './index.js';

/**
 * One skinned Kenney character (left, driven by a mixer) next to its AnimatedInstances twin (right): the two must
 * match at `vatClip` and `vatTime` (`setTime` moves both clocks; `vatFps` is the bake rate, 30 by default).
 * `vatPartOffset=x,y,z` moves every skinned part after the first off the character root (the Kenney parts all sit at
 * the root): bound in attached mode the original draws the same wherever its parts sit, so the twin has to draw each
 * part at its own offset to match it. `vatShading=standard|lambert|unlit` picks the twin's lighting model, and
 * `vatOnce=1` plays the clip once on both, the original's action clamped where it finishes, and `vatNodeMaterial=1`
 * draws the twin with a toon node material whose colour is a uniform (`colorNode`), passed as `nodeMaterial`.
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
  const once = params.get('vatOnce') === '1';
  const action = mixer.clipAction(clip);
  if (once) {
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
  }
  action.play();
  const animation = bakeAnimationTexture(gltf.scene, gltf.animations, { fps: Number(params.get('vatFps') ?? '30') });
  const shading = (params.get('vatShading') ?? 'standard') as 'standard' | 'lambert' | 'unlit';
  let nodeMaterial: MeshToonNodeMaterial | undefined;
  if (params.get('vatNodeMaterial') === '1') {
    nodeMaterial = new MeshToonNodeMaterial();
    nodeMaterial.colorNode = uniform(new Color(0xff2020));
  }
  const vat = new AnimatedInstances(
    nodeMaterial ? { animation, count: 1, nodeMaterial } : { animation, count: 1, shading },
  );
  vat.setMatrixAt(0, new Matrix4().makeTranslation(1, 0, 0));
  vat.setClipAt(0, clip.name, { once });
  vat.addTo(scene);
  const key = new DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(new AmbientLight(0xffffff, 0.5), key);
  camera.position.set(0, 1.4, 4.5);
  camera.lookAt(0, 0.9, 0);
  camera.updateMatrixWorld();
  const setTime = (t: number): void => {
    mixer.setTime(t);
    vat.setTime(t);
  };
  setTime(Number(params.get('vatTime') ?? '0'));
  return { scene, counts: {}, vat, setTime };
};
