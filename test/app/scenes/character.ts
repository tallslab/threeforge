import {
  AmbientLight,
  Color,
  DataTexture,
  DirectionalLight,
  type MeshStandardMaterial,
  NearestFilter,
  type Object3D,
  Scene,
} from 'three';
import { texture, uniform, uv } from 'three/tsl';
import { MeshStandardNodeMaterial, MeshToonNodeMaterial } from 'three/webgpu';
import { assembleCharacter } from 'threeforge';
import { buildCharacter } from '../../scenes/character.js';
import type { BenchBuilder } from './index.js';

/** An 8 x 8 checker of two colours, sampled nearest, so a UV that moves shows. */
function checker(): DataTexture {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    const on = ((i % 8) + Math.floor(i / 8)) % 2 === 0;
    data.set(on ? [240, 200, 40, 255] : [40, 90, 220, 255], i * 4);
  }
  const map = new DataTexture(data, 8, 8);
  map.magFilter = NearestFilter;
  map.minFilter = NearestFilter;
  map.needsUpdate = true;
  return map;
}

/**
 * The synthetic modular character (`test/scenes/character.ts`); `assemble=1` merges its parts into one skinned mesh,
 * `vertexColors=1` colours its gear per vertex instead of by texture, and `textures=0` gives every part a flat colour
 * and no map. `ornament=1` draws it, parts or assembled, with a node material that samples a checker by `uv()`;
 * `dye=1` assembles two characters side by side with one toon material whose colour is a per-object uniform read from
 * each mesh's `userData.dye`.
 */
export const characterScene: BenchBuilder = async ({ camera, params }) => {
  const scene = new Scene();
  scene.background = new Color(0x202830);
  const options = { vertexColors: params.get('vertexColors') === '1', textures: params.get('textures') !== '0' };
  const character = buildCharacter(options);
  let material: MeshStandardNodeMaterial | MeshToonNodeMaterial | undefined;
  const ornament = params.get('ornament') === '1' ? checker() : null;
  if (ornament) {
    material = new MeshStandardNodeMaterial();
    material.colorNode = texture(ornament, uv());
  }
  if (params.get('dye') === '1') {
    material = new MeshToonNodeMaterial();
    material.colorNode = uniform(new Color()).onObjectUpdate(({ object }) => (object as Object3D).userData.dye);
  }
  const assemble = (parts: ReturnType<typeof buildCharacter>) =>
    assembleCharacter({
      skeleton: parts.skeleton,
      wardrobe: [parts.body, ...parts.gear],
      equipped: [parts.body, ...parts.gear],
      atlas: { size: Number(params.get('atlas') ?? '256') },
      material,
    });
  let assembled: ReturnType<typeof assembleCharacter> | undefined;
  if (params.get('dye') === '1') {
    assembled = assemble(character);
    const twin = assemble(buildCharacter(options));
    assembled.mesh.position.x = -0.9;
    twin.mesh.position.x = 0.9;
    assembled.mesh.userData.dye = new Color(0xff2020);
    twin.mesh.userData.dye = new Color(0x2040ff);
    scene.add(assembled.mesh, twin.mesh);
  } else if (params.get('assemble') === '1') {
    assembled = assemble(character);
    scene.add(assembled.mesh);
  } else {
    // The assembled mesh multiplies the checker by each part's colour, carried in its vertices: here each part does it
    // with its own material colour.
    if (material && ornament)
      for (const part of [character.body, ...character.gear]) {
        const own = material.clone();
        own.colorNode = texture(ornament, uv()).mul(uniform((part.material as MeshStandardMaterial).color));
        part.material = own;
      }
    scene.add(character.body, ...character.gear);
  }
  const key = new DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(new AmbientLight(0xffffff, 0.6), key);
  camera.position.set(0, 1.6, params.get('dye') === '1' ? 6.5 : 4.5);
  camera.lookAt(0, 1.1, 0);
  camera.updateMatrixWorld();
  return { scene, counts: {}, character, assembled };
};
