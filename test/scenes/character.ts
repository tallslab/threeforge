/**
 * A procedural rigged character: a shared 3-bone skeleton (root -> spine -> head), a body mesh, and gear parts
 * (helmet, chest, legs, sword) each exported "the glTF way": its own SkinnedMesh with its own Skeleton instance
 * whose bones carry the same names as the body's. Textures are small DataTextures so this runs in node.
 */
import {
  Bone,
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  DataTexture,
  Float32BufferAttribute,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  SRGBColorSpace,
  Uint16BufferAttribute,
} from 'three';

export const BONE_NAMES = ['root', 'spine', 'head'] as const;

export function makeRig(): { root: Bone; skeleton: Skeleton } {
  const root = new Bone();
  root.name = 'root';
  const spine = new Bone();
  spine.name = 'spine';
  spine.position.y = 1;
  const head = new Bone();
  head.name = 'head';
  head.position.y = 1;
  root.add(spine);
  spine.add(head);
  root.updateMatrixWorld(true);
  return { root, skeleton: new Skeleton([root, spine, head]) };
}

/** Weight vertices by height: bottom -> root, middle -> spine, top -> head. */
function skin(geometry: BufferGeometry, boneOrder: number[]): BufferGeometry {
  const position = geometry.attributes.position!;
  const n = position.count;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const y = position.getY(i);
    const t = Math.max(0, Math.min(2, y)); // 0..2 along the spine
    const lower = Math.min(1, Math.floor(t));
    const w = t - lower;
    skinIndex[i * 4] = boneOrder[lower]!;
    skinIndex[i * 4 + 1] = boneOrder[lower + 1]!;
    skinWeight[i * 4] = 1 - w;
    skinWeight[i * 4 + 1] = w;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  return geometry;
}

export function solidTexture(rgb: [number, number, number], size = 4): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface CharacterParts {
  body: SkinnedMesh;
  gear: SkinnedMesh[];
  skeleton: Skeleton;
  root: Bone;
}

/**
 * Each part gets its own skeleton instance with bones in a *different order* than the body's, to exercise
 * bone remapping by name. `shuffle` picks that order.
 */
function partSkeleton(order: number[]): Skeleton {
  const { skeleton } = makeRig();
  const bones = order.map((i) => skeleton.bones[i]!);
  return new Skeleton(
    bones,
    bones.map((_, k) => skeleton.boneInverses[order[k]!]!.clone()),
  );
}

export function buildCharacter(): CharacterParts {
  const { root, skeleton } = makeRig();
  const make = (
    geometry: BufferGeometry,
    rgb: [number, number, number],
    order: number[],
    name: string,
  ): SkinnedMesh => {
    const bones = order.map((i) => BONE_NAMES[i]!);
    // skinIndex values refer to the part's own bone order; boneOrder maps rig index -> part index.
    const boneOrder = BONE_NAMES.map((n) => bones.indexOf(n));
    skin(geometry, boneOrder);
    const material = new MeshStandardMaterial({ map: solidTexture(rgb), roughness: 0.6, metalness: 0 });
    const mesh = new SkinnedMesh(geometry, material);
    mesh.name = name;
    mesh.bind(partSkeleton(order));
    return mesh;
  };
  const body = make(new CylinderGeometry(0.4, 0.4, 2, 12, 4).translate(0, 1, 0), [200, 170, 140], [0, 1, 2], 'body');
  body.bind(skeleton); // the body owns the live rig
  body.add(root);
  const gear = [
    make(new SphereGeometry(0.5, 12, 8).translate(0, 2.2, 0), [90, 90, 110], [2, 1, 0], 'helmet'),
    make(new BoxGeometry(1, 0.8, 0.9, 2, 2, 2).translate(0, 1.4, 0), [150, 40, 40], [1, 0, 2], 'chest'),
    make(new CylinderGeometry(0.45, 0.35, 1, 10, 2).translate(0, 0.5, 0), [40, 60, 150], [1, 2, 0], 'legs'),
    make(new BoxGeometry(0.1, 1.2, 0.1, 1, 3, 1).translate(0.7, 1.2, 0), [220, 220, 230], [0, 2, 1], 'sword'),
  ];
  return { body, gear, skeleton, root };
}
