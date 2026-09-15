import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';

/** Bone `a` at the origin and its child `b` one unit up. */
function twoBones(): { a: Bone; b: Bone } {
  const a = new Bone();
  a.name = 'a';
  const b = new Bone();
  b.name = 'b';
  b.position.set(0, 1, 0);
  a.add(b);
  return { a, b };
}

/** A box 0..2 tall whose lower vertices follow bone 0 (`a`) and upper vertices bone 1 (`b`), not yet bound. */
function skinnedBox(name: string, color: number): SkinnedMesh {
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
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color, roughness: 0.4 }));
  mesh.name = name;
  return mesh;
}

/** One 1 s clip `spin` that turns `b` 90° about x. */
function spinClip(): AnimationClip {
  const q0 = new Quaternion();
  const q1 = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  return new AnimationClip('spin', 1, [new QuaternionKeyframeTrack('b.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w])]);
}

/**
 * A two-bone rig for node tests: bone `a` at the origin, bone `b` one unit up; a box 0..2 tall whose lower vertices
 * follow `a` and upper vertices follow `b`; one 1 s clip `spin` that turns `b` 90° about x.
 */
export function buildRig(): { root: Group; mesh: SkinnedMesh; a: Bone; b: Bone; clip: AnimationClip } {
  const root = new Group();
  root.name = 'rig';
  const { a, b } = twoBones();
  const mesh = skinnedBox('body', 0x336699);
  mesh.add(a);
  mesh.bind(new Skeleton([a, b]));
  root.add(mesh);
  root.updateMatrixWorld(true);
  return { root, mesh, a, b, clip: spinClip() };
}

/**
 * A two-part rig shaped like the Kenney mini characters: one bone chain under the root (`a` and `b` as in buildRig)
 * skinning two boxes, `body` and `head`, each bound where it stands to its own Skeleton over those bones. The parts
 * sit at different offsets from the root: the body 0.25 along x, the head raised 1.5, shifted and tilted 0.5 rad
 * about z. The same `spin` clip.
 */
export function buildTwoPartRig(): { root: Group; body: SkinnedMesh; head: SkinnedMesh; a: Bone; b: Bone; clip: AnimationClip } {
  const root = new Group();
  root.name = 'two-part-rig';
  const { a, b } = twoBones();
  root.add(a);
  const body = skinnedBox('body', 0x336699);
  body.position.set(0.25, 0, 0);
  const head = skinnedBox('head', 0x993322);
  new Matrix4().compose(new Vector3(-0.2, 1.5, 0.1), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5), new Vector3(1, 1, 1)).decompose(head.position, head.quaternion, head.scale);
  root.add(body, head);
  root.updateMatrixWorld(true);
  body.bind(new Skeleton([a, b]));
  head.bind(new Skeleton([a, b]));
  return { root, body, head, a, b, clip: spinClip() };
}
