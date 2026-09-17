import { BackSide, BufferAttribute, BufferGeometry, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { BuriedOptions } from '../bake.js';
import { type Gathered, triangleLocked } from './gather.js';
import { perpendicularBasis } from './topology.js';

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Buried faces: every ray from the face's front, over the hemisphere, hits opaque geometry within `distance`. Only
 * faces of `occludes` entries block, only on their back side (see the raycast), and only faces of `removable` entries
 * are removed. Marks them in `removedTriangle` and returns their count.
 */
export function removeBuriedFaces(
  g: Gathered,
  removedTriangle: Uint8Array,
  options: Required<BuriedOptions>,
  tolerance: number,
  occludes: (entry: number) => boolean,
  removable: (entry: number) => boolean,
): number {
  const occluders: number[] = [];
  for (let t = 0; t < g.triangleEntry.length; t++) {
    if (!removedTriangle[t] && occludes(g.triangleEntry[t]!)) occluders.push(t);
  }
  if (occluders.length === 0) return 0;
  const occluder = new BufferGeometry();
  occluder.setAttribute('position', new BufferAttribute(g.position, 3));
  const occIndex = new Uint32Array(occluders.length * 3);
  occluders.forEach((t, i) => occIndex.set([g.index[t * 3]!, g.index[t * 3 + 1]!, g.index[t * 3 + 2]!], i * 3));
  occluder.setIndex(new BufferAttribute(occIndex, 1));
  const bvh = new MeshBVH(occluder);
  const ray = new Ray();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const t1 = new Vector3();
  const t2 = new Vector3();
  // Scratch for the per-candidate edge and ray origin: the loop below runs once per surviving face.
  const edge = new Vector3();
  const origin = new Vector3();
  const eps = Math.max(tolerance * 10, 1e-5);
  const blocked = (origin: Vector3, normal: Vector3): boolean => {
    perpendicularBasis(normal, t1, t2);
    for (let i = 0; i < options.samples; i++) {
      const z = 0.15 + (0.85 * (i + 0.5)) / options.samples;
      const r = Math.sqrt(1 - z * z);
      const phi = i * GOLDEN;
      ray.origin.copy(origin);
      ray.direction
        .set(0, 0, 0)
        .addScaledVector(t1, r * Math.cos(phi))
        .addScaledVector(t2, r * Math.sin(phi))
        .addScaledVector(normal, z)
        .normalize();
      // A hit blocks only when a viewer beyond it, looking back along the ray, would see that triangle drawn: the ray
      // meets its back side (three-mesh-bvh's BackSide test culls triangles facing the ray origin). A front-side card
      // facing the face shows that viewer its culled back, so it hides nothing.
      const hit = bvh.raycastFirst(ray, BackSide);
      // Depth along the face normal: a parallel wall at gap g that faces away from the face (the ray meets its back
      // side) blocks at g from every angle; one facing the face blocks nothing, so a face pressed against a
      // neighbouring solid's front face is buried only when that solid's far side is within `distance`.
      if (!hit || hit.distance * z > options.distance) return false;
    }
    return true;
  };
  let buried = 0;
  // Candidates: the surviving faces of opaque, front-side entries, all of which are occluders.
  for (const t of occluders) {
    if (triangleLocked(g, t) || !removable(g.triangleEntry[t]!)) continue;
    a.fromArray(g.position, g.index[t * 3]! * 3);
    b.fromArray(g.position, g.index[t * 3 + 1]! * 3);
    c.fromArray(g.position, g.index[t * 3 + 2]! * 3);
    n.copy(b).sub(a).cross(edge.copy(c).sub(a)).normalize();
    // The centroid, lifted `eps` along the face normal.
    origin
      .copy(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3)
      .addScaledVector(n, eps);
    if (!blocked(origin, n)) continue;
    removedTriangle[t] = 1;
    buried++;
  }
  occluder.dispose();
  return buried;
}
