import { AmbientLight, Color, DirectionalLight, Scene } from 'three';
import { assembleCharacter } from 'threeforge';
import { buildCharacter } from '../../scenes/character.js';
import type { BenchBuilder } from './index.js';

/** The synthetic modular character (`test/scenes/character.ts`); `assemble=1` merges its parts into one skinned mesh. */
export const characterScene: BenchBuilder = async ({ camera, params }) => {
  const scene = new Scene();
  scene.background = new Color(0x202830);
  const character = buildCharacter();
  let assembled: ReturnType<typeof assembleCharacter> | undefined;
  if (params.get('assemble') === '1') {
    assembled = assembleCharacter({
      skeleton: character.skeleton,
      wardrobe: [character.body, ...character.gear],
      equipped: [character.body, ...character.gear],
      atlas: { size: 256 },
    });
    scene.add(assembled.mesh);
  } else {
    scene.add(character.body, ...character.gear);
  }
  const key = new DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(new AmbientLight(0xffffff, 0.6), key);
  camera.position.set(0, 1.6, 4.5);
  camera.lookAt(0, 1.1, 0);
  camera.updateMatrixWorld();
  return { scene, counts: {}, character, assembled };
};
