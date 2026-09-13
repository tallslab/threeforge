import { BufferAttribute, BufferGeometry, type InterleavedBufferAttribute } from 'three';

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

function arrayType(attribute: AnyAttribute): string {
  const name = attribute.array.constructor.name; // Float32Array, Uint16Array, ...
  return name.endsWith('Array') ? name.slice(0, -'Array'.length) : name;
}

/**
 * Describes what BatchedMesh.addGeometry() requires to be identical across geometries in one batch:
 * attribute names, item sizes, array types and normalisation. Sorted by name, independent of indexing.
 */
export function attributeSignature(geometry: BufferGeometry): string {
  return Object.keys(geometry.attributes)
    .sort()
    .map((name) => {
      const attribute = geometry.attributes[name] as AnyAttribute;
      return `${name}:${attribute.itemSize}:${arrayType(attribute)}:${attribute.normalized ? 1 : 0}`;
    })
    .join('|');
}

export function isBatchCompatible(a: BufferGeometry, b: BufferGeometry): boolean {
  return attributeSignature(a) === attributeSignature(b);
}

const indexedClones = new WeakMap<BufferGeometry, BufferGeometry>();

/**
 * BatchedMesh needs every geometry in a batch to agree on having an index. Non-indexed geometries
 * (three's polyhedra, many procedural meshes) get a sequential index on a clone that shares the
 * original's attribute arrays; the original is never touched. Memoised per geometry.
 */
export function ensureIndexed(geometry: BufferGeometry): BufferGeometry {
  if (geometry.index !== null) return geometry;
  let clone = indexedClones.get(geometry);
  if (clone) return clone;
  clone = new BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) clone.setAttribute(name, geometry.attributes[name]!);
  const count = geometry.attributes.position?.count ?? 0;
  const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  clone.setIndex(new BufferAttribute(index, 1));
  clone.name = geometry.name ? `${geometry.name} (indexed)` : 'indexed';
  if (geometry.boundingBox) clone.boundingBox = geometry.boundingBox.clone();
  if (geometry.boundingSphere) clone.boundingSphere = geometry.boundingSphere.clone();
  indexedClones.set(geometry, clone);
  return clone;
}
