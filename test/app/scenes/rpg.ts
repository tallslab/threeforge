import { AmbientLight, Color, DirectionalLight, Scene, type SkinnedMesh } from 'three';
import { type AssembledCharacter, assembleCharacter } from 'threeforge';
import { buildCharacter } from '../../scenes/character.js';
import type { BenchBuilder } from './index.js';

/**
 * Portrait mobile RPG: one character with four gear pieces, one of them swapped every 30 frames. Naive draws body and
 * gear as separate skinned meshes; optimized merges them onto the shared skeleton (one skinned mesh, one atlas) and
 * swaps gear through the assembler, which changes the vertex buffer, never the draw count.
 */
export const rpg: BenchBuilder = async ({ camera }) => {
  const scene = new Scene();
  scene.name = 'rpg';
  scene.background = new Color(0x202830);
  const character = buildCharacter();
  const parts: SkinnedMesh[] = [character.body, ...character.gear];
  scene.add(...parts);
  const key = new DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(new AmbientLight(0xffffff, 0.6), key);
  camera.position.set(0, 1.6, 4.5);
  camera.lookAt(0, 1.1, 0);
  camera.updateMatrixWorld();
  let assembled: AssembledCharacter | null = null;
  let hidden = -1;
  const setTime = (t: number): void => {
    // A different piece of gear is taken off every 30 frames (at 60 fps).
    const next = Math.floor(t * 2) % character.gear.length;
    if (next === hidden) return;
    if (assembled) {
      if (hidden >= 0) assembled.equip(character.gear[hidden]!);
      assembled.unequip(character.gear[next]!);
    } else {
      character.gear.forEach((g, i) => {
        g.visible = i !== next;
      });
    }
    hidden = next;
  };
  setTime(0);
  return {
    scene,
    counts: { gear: character.gear.length },
    portrait: true,
    setTime,
    after: () => {
      for (const g of character.gear) g.visible = true;
      const equipped = character.gear.filter((_, i) => i !== hidden);
      assembled = assembleCharacter({
        skeleton: character.skeleton,
        wardrobe: parts,
        equipped: [character.body, ...equipped],
        atlas: { size: 256 },
      });
      for (const part of parts) scene.remove(part);
      scene.add(assembled.mesh);
    },
  };
};
