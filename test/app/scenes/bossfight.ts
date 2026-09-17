import { disposeLoader, ShadowBudget } from 'threeforge';
import { buildArena } from '../arena.js';
import type { BenchBuilder } from './index.js';

/** The fight arena with 30 simultaneous particle effects, sprites, decals and shadowed spot and point lights. */
export const bossfight: BenchBuilder = async ({ renderer, camera, params, loader: makeLoader, tier }) => {
  const [{ RoomEnvironment }, { PMREMGenerator }] = await Promise.all([
    import('three/addons/environments/RoomEnvironment.js'),
    import('three/webgpu'),
  ]);
  const loader = await makeLoader();
  renderer.shadowMap.enabled = true;
  const arena = await buildArena({
    loader,
    fighters: Number(params.get('fighters') ?? '12'),
    blocky: 16,
    vfx: true,
    shadows: true,
    effects: Number(params.get('effects') ?? '30'),
  });
  disposeLoader(loader);
  const roomEnvironment = new RoomEnvironment();
  const pmrem = new PMREMGenerator(renderer);
  arena.scene.environment = pmrem.fromScene(roomEnvironment, 0.04).texture;
  arena.scene.environmentIntensity = 0.15;
  pmrem.dispose();
  roomEnvironment.dispose();
  camera.near = 0.5;
  camera.far = 400;
  camera.position.set(-38, 34, 58);
  camera.lookAt(0, 3, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  arena.setTime(1);
  // Tagged dynamics (blocky character parts, weapons on bones) ride in batches and sync their matrices each frame.
  // The optimized variant sizes the shadow maps for the tier (no change on desktop; 262k texels on phone-low).
  const prepare = (): void => {
    new ShadowBudget({ tier }).apply(arena.scene);
  };
  return {
    scene: arena.scene,
    counts: { ...arena.counts, effects: arena.counts.effects ?? 30 },
    animations: arena.animations,
    setTime: arena.setTime,
    worldOptions: { dynamics: 'batch-sync' },
    prepare,
  };
};
