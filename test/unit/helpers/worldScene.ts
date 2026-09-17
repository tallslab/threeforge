import {
  type BatchedMesh,
  BoxGeometry,
  DataTexture,
  DodecahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  SkinnedMesh,
} from 'three';
import { tag } from '../../../src/tags.js';

export const box = new BoxGeometry(1, 1, 1);
export const dodeca = new DodecahedronGeometry(0.5); // non-indexed
export const texture = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);

export function solid(color: number, extra: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) {
  return new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...extra });
}

/** 4 colour-variant statics (2 geometries), 2 textured statics, 1 dynamic, 1 skinned, 1 untagged: 9 meshes. */
export function mixedScene() {
  const scene = new Scene();
  const statics = [
    tag.static(new Mesh(box, solid(0xff0000))),
    tag.static(new Mesh(dodeca, solid(0x00ff00))),
    tag.static(new Mesh(box, solid(0x0000ff))),
    tag.static(new Mesh(dodeca, solid(0xffff00))),
  ];
  statics.forEach((m, i) => {
    m.name = `static-${i}`;
    m.position.set(i * 3, 0, 0);
    m.rotation.y = i;
  });
  const textured = [
    tag.static(new Mesh(box, new MeshStandardMaterial({ map: texture }))),
    tag.static(new Mesh(box, new MeshStandardMaterial({ map: texture }))),
  ];
  textured.forEach((m, i) => {
    m.name = `textured-${i}`;
    m.position.set(0, 0, 5 + i * 3);
  });
  const dynamic = tag.dynamic(new Mesh(box, solid(0xff0000)));
  dynamic.name = 'dynamic';
  const skinned = new SkinnedMesh(box, solid(0x123456));
  skinned.name = 'skinned';
  const untagged = new Mesh(box, solid(0x654321));
  untagged.name = 'untagged';
  scene.add(...statics, ...textured, dynamic, skinned, untagged);
  return { scene, statics, textured, dynamic, skinned, untagged };
}

export function meshesIn(scene: Scene): Mesh[] {
  const out: Mesh[] = [];
  scene.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

export function batchesIn(scene: Scene): BatchedMesh[] {
  return meshesIn(scene).filter((m): m is BatchedMesh => (m as BatchedMesh).isBatchedMesh);
}
