import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';

/**
 * A two-bone rig for node tests: bone `a` at the origin, bone `b` one unit up; a box 0..2 tall whose lower vertices
 * follow `a` and upper vertices follow `b`; one 1 s clip `spin` that turns `b` 90° about x.
 */
export function buildRig(): { root: Group; mesh: SkinnedMesh; a: Bone; b: Bone; clip: AnimationClip } {
  const root = new Group();
  root.name = 'rig';
  const a = new Bone();
  a.name = 'a';
  const b = new Bone();
  b.name = 'b';
  b.position.set(0, 1, 0);
  a.add(b);
  const geometry = new BoxGeometry(0.2, 2, 0.2, 1, 2, 1).translate(0, 1, 0);
  const position = geometry.getAttribute('position');
  const skinIndex = new Uint16BufferAttribute(new Uint16Array(position.count * 4), 4);
  const skinWeight = new Float32BufferAttribute(new Float32Array(position.count * 4), 4);
  for (let i = 0; i < position.count; i++) {
    skinIndex.setXYZW(i, position.getY(i) < 1 ? 0 : 1, 0, 0, 0);
    skinWeight.setXYZW(i, 1, 0, 0, 0);
  }
  geometry.setAttribute('skinIndex', skinIndex);
  geometry.setAttribute('skinWeight', skinWeight);
  const material = new MeshStandardMaterial({ color: 0x336699, roughness: 0.4 });
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'body';
  mesh.add(a);
  mesh.bind(new Skeleton([a, b]));
  root.add(mesh);
  root.updateMatrixWorld(true);
  const q0 = new Quaternion();
  const q1 = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  const clip = new AnimationClip('spin', 1, [new QuaternionKeyframeTrack('b.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w])]);
  return { root, mesh, a, b, clip };
}
