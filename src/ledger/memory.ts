import { ByteType, FloatType, HalfFloatType, IntType, ShortType, UnsignedByteType, UnsignedIntType, UnsignedShortType, type BufferGeometry, type Object3D, type Texture } from 'three';
import type { MemorySnapshot } from './snapshot.js';
import { collectResources } from '../memory/resources.js';

const BYTES_PER_CHANNEL: Record<number, number> = {
  [UnsignedByteType]: 1,
  [ByteType]: 1,
  [ShortType]: 2,
  [UnsignedShortType]: 2,
  [IntType]: 4,
  [UnsignedIntType]: 4,
  [FloatType]: 4,
  [HalfFloatType]: 2,
};

/** GPU bytes of one texture: RGBA at the texture's channel type, ×4/3 with mipmaps, ×6 for cubes; compressed = Σ mip bytes. */
export function textureBytes(texture: Texture): number {
  const t = texture as Texture & { isCompressedTexture?: boolean; isCubeTexture?: boolean; mipmaps?: Array<{ data?: ArrayBufferView }> };
  if (t.isCompressedTexture && Array.isArray(t.mipmaps)) return t.mipmaps.reduce((n, m) => n + (m.data?.byteLength ?? 0), 0);
  const faces = t.isCubeTexture ? 6 : 1;
  const image = (Array.isArray(t.image) ? t.image[0] : t.image) as { width?: number; height?: number } | null | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  const base = width * height * 4 * (BYTES_PER_CHANNEL[texture.type as number] ?? 1) * faces;
  return Math.round(texture.generateMipmaps ? (base * 4) / 3 : base);
}

export function geometryBytes(geometry: BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  return bytes;
}

/**
 * Estimated GPU memory held by a scene: unique textures (materials, background, environment), unique geometries,
 * shadow maps of shadow-casting lights, and the renderer's half-float frame-buffer target for the viewport.
 */
export function estimateMemory(scene: Object3D, info: { textures: number; geometries: number }, viewport: [number, number]): MemorySnapshot {
  const { textures, geometries } = collectResources(scene);
  let rtCount = 0;
  let rtBytes = 0;
  scene.traverse((o) => {
    const light = o as Object3D & { isLight?: boolean; isPointLight?: boolean; castShadow: boolean; shadow?: { mapSize: { x: number; y: number } } };
    if (light.isLight && light.castShadow && light.shadow) {
      rtCount++;
      rtBytes += light.shadow.mapSize.x * light.shadow.mapSize.y * 4 * (light.isPointLight ? 6 : 1);
    }
  });
  let textureTotal = 0;
  for (const t of textures) textureTotal += textureBytes(t);
  let geometryTotal = 0;
  for (const g of geometries) geometryTotal += geometryBytes(g);
  if (viewport[0] > 0 && viewport[1] > 0) {
    rtCount++;
    rtBytes += viewport[0] * viewport[1] * 8;
  }
  return {
    textures: { count: Math.max(info.textures, textures.size), bytes: textureTotal },
    geometries: { count: Math.max(info.geometries, geometries.size), bytes: geometryTotal },
    renderTargets: { count: rtCount, bytes: rtBytes },
    // Render-target textures (shadow maps, the frame buffer) count in info.memory.textures without being in the scene.
    unreferenced: { geometries: Math.max(0, info.geometries - geometries.size), textures: Math.max(0, info.textures - textures.size - rtCount) },
    chunks: { total: 0, resident: 0 },
    estimated: true,
  };
}
