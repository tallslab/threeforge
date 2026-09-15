import {
  AlphaFormat,
  DepthFormat,
  DepthStencilFormat,
  FloatType,
  HalfFloatType,
  IntType,
  RedFormat,
  RedIntegerFormat,
  RGBFormat,
  RGBIntegerFormat,
  RGFormat,
  RGIntegerFormat,
  ShortType,
  UnsignedInt101111Type,
  UnsignedInt248Type,
  UnsignedInt5999Type,
  UnsignedIntType,
  UnsignedShort4444Type,
  UnsignedShort5551Type,
  UnsignedShortType,
  VSMShadowMap,
  type BufferGeometry,
  type Object3D,
  type Texture,
} from 'three';
import type { MeasuredMemory, MemorySnapshot } from './snapshot.js';
import { collectResources } from '../memory/resources.js';

/** The texture fields the estimate reads; structural, so any texture class (and a plain test object) fits. */
interface TextureFields {
  format: number;
  type: number;
  generateMipmaps: boolean;
  image: unknown;
  /** CubeTexture's image array. */
  images?: unknown;
  mipmaps?: unknown;
  isCompressedTexture?: boolean;
  isCubeTexture?: boolean;
  isHTMLTexture?: boolean;
}

/** A texture image as three r186's Textures.getSize reads it: an image, a video element, a VideoFrame, or a data object. */
interface TextureImage {
  width?: number;
  height?: number;
  depth?: number;
  image?: TextureImage | null;
  videoWidth?: number;
  videoHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  offsetWidth?: number;
  offsetHeight?: number;
}

interface MipLevel {
  data?: ArrayBufferView | null;
  width?: number;
  height?: number;
}

/**
 * Bytes per texel as three r186 reckons them (renderers/common/Info.js `_getTextureMemorySize`, ~459-476): channels from
 * the format, bytes per channel from the type, and the packed types whole.
 */
function texelBytes(format: number, type: number): number {
  if (type === UnsignedShort4444Type || type === UnsignedShort5551Type) return 2;
  if (type === UnsignedInt248Type || type === UnsignedInt5999Type || type === UnsignedInt101111Type) return 4;
  const channel = type === ShortType || type === UnsignedShortType || type === HalfFloatType ? 2 : type === IntType || type === UnsignedIntType || type === FloatType ? 4 : 1;
  let channels = 4;
  if (format === AlphaFormat || format === RedFormat || format === RedIntegerFormat || format === DepthFormat || format === DepthStencilFormat) channels = 1;
  else if (format === RGFormat || format === RGIntegerFormat) channels = 2;
  else if (format === RGBFormat || format === RGBIntegerFormat) channels = 3;
  return channel * channels;
}

/**
 * The size three r186 allocates a texture at (renderers/common/Textures.js `getSize`, ~450-492): a cube's first face, a
 * video's frame, 6 faces for a cube, the layers of a 3D or array texture, and 1 for a dimension it cannot read.
 */
function allocatedSize(t: TextureFields): { width: number; height: number; depth: number } {
  let image = (Array.isArray(t.images) ? t.images[0] : t.image) as TextureImage | null | undefined;
  if (image && image.image !== undefined) image = image.image;
  if (!image) return { width: 1, height: 1, depth: 1 };
  if (t.isHTMLTexture) return { width: image.offsetWidth || 1, height: image.offsetHeight || 1, depth: 1 };
  if (typeof image.videoWidth === 'number') return { width: image.videoWidth || 1, height: image.videoHeight || 1, depth: 1 };
  if (typeof image.displayWidth === 'number') return { width: image.displayWidth || 1, height: image.displayHeight || 1, depth: 1 };
  return { width: image.width || 1, height: image.height || 1, depth: t.isCubeTexture ? 6 : image.depth || 1 };
}

function mipDataBytes(mipmaps: unknown): number {
  if (!Array.isArray(mipmaps)) return 0;
  let bytes = 0;
  for (const level of mipmaps as Array<MipLevel | null>) bytes += level?.data?.byteLength ?? 0;
  return bytes;
}

/**
 * GPU bytes of one texture, following three r186's `Info._getTextureMemorySize` (renderers/common/Info.js ~449):
 * `width · height · depth · texel bytes` (channels from the format, bytes per channel from the type), depth being 6 faces
 * for a cube and the layers of a 3D or array texture, ×1.333 for a generated mip chain. Where that function does not
 * describe what three allocates, this follows the allocation:
 * - a compressed texture is the sum of its mip data (Info counts 1 byte), a compressed cube's six faces included;
 * - the size is the one Textures.getSize allocates: a cube's first face and a video's frame (Info reads `texture.width`,
 *   which is 1 for a cube's image array);
 * - explicit mipmaps are the levels the backends upload: a 2D, 3D or array texture's `mipmaps` hold every level from the
 *   base (Textures.getMipLevels), a cube's hold the levels after it (Textures.updateTexture adds one); Info adds the base
 *   to either.
 */
export function textureBytes(texture: Texture): number {
  const t = texture as unknown as TextureFields;
  if (t.isCompressedTexture) {
    if (Array.isArray(t.mipmaps) && t.mipmaps.length > 0) return mipDataBytes(t.mipmaps);
    // CompressedCubeTexture (KTX2Loader's six faces) keeps each face's levels on the face.
    if (Array.isArray(t.image)) return (t.image as Array<{ mipmaps?: unknown } | null>).reduce((bytes, face) => bytes + mipDataBytes(face?.mipmaps), 0);
    return 0;
  }
  const { width, height, depth } = allocatedSize(t);
  const texel = texelBytes(t.format, t.type);
  const mipmaps = Array.isArray(t.mipmaps) ? (t.mipmaps as Array<MipLevel | null>) : [];
  if (mipmaps.length === 0) return Math.round(width * height * depth * texel * (t.generateMipmaps ? 1.333 : 1));
  let bytes = 0;
  if (t.isCubeTexture) {
    bytes = width * height * depth * texel;
    for (let level = 1; level <= mipmaps.length; level++) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * depth * texel;
  } else {
    for (let level = 0; level < mipmaps.length; level++) {
      const mip = mipmaps[level];
      bytes += mip?.data ? mip.data.byteLength : (mip?.width || Math.max(1, width >> level)) * (mip?.height || Math.max(1, height >> level)) * depth * texel;
    }
  }
  return Math.round(bytes);
}

/** What the allowance reads off a render target. */
export interface AllowedRenderTarget {
  textures?: readonly unknown[];
  depthTexture?: unknown;
  depthBuffer?: boolean;
  stencilBuffer?: boolean;
}

/**
 * Textures three r186 creates for a render target once it is used (renderers/common/Textures.js `updateRenderTarget`,
 * ~68-160): one per colour attachment, and a depth texture when the target has one or a depth or stencil buffer.
 */
function renderTargetTextures(target: AllowedRenderTarget): number {
  return (Array.isArray(target.textures) ? target.textures.length : 1) + (target.depthTexture || target.depthBuffer || target.stencilBuffer ? 1 : 0);
}

/** A built shadow map: an array map carries its VSM blur targets (ShadowNode.js ~389-403). */
type ShadowMapTarget = AllowedRenderTarget & { _vsmShadowMapVertical?: AllowedRenderTarget | null; _vsmShadowMapHorizontal?: AllowedRenderTarget | null };

/** Renderer-internal allocations present on an empty scene: the output pass's quad, the frame-buffer target's colour and depth. */
const INTERNAL_GEOMETRIES = 1;
const FRAME_BUFFER_TEXTURES = 2;
/** A non-point VSM map's two colour-only RG half-float blur targets, kept on its shadow node (ShadowNode.js ~409-410). */
const VSM_BLUR_TEXTURES = 2;

export function geometryBytes(geometry: BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  return bytes;
}

/** `renderer.info.memory` as three r186's common Renderer keeps it. Only the two counts are required. */
export interface RendererMemoryInfo {
  textures: number;
  geometries: number;
  texturesSize?: number;
  attributesSize?: number;
  indexAttributesSize?: number;
  renderTargets?: number;
  total?: number;
}

export interface MemoryEstimateOptions {
  /**
   * Render targets the renderer holds that nothing in the scene reaches, allowed like the frame buffer and the shadow
   * maps (null entries are skipped). The ledger passes its overdraw count target, `overdrawTargetOf(renderer)`.
   */
  renderTargets?: ReadonlyArray<AllowedRenderTarget | null>;
  /**
   * Textures the renderer created for itself that nothing in the scene reaches, counted by the caller. The ledger counts
   * three's `DFG_LUT` through `renderer.info.createTexture` and `destroyTexture` while it is attached.
   */
  internalTextures?: number;
  /** `renderer.shadowMap.type`: under `VSMShadowMap` each built non-point shadow map also holds two blur targets. */
  shadowMapType?: number;
}

/** three's own counts and byte sizes, null when `info` does not carry them. */
function measuredOf(info: RendererMemoryInfo): MeasuredMemory | null {
  const { texturesSize, attributesSize, indexAttributesSize, renderTargets, total } = info;
  if (typeof texturesSize !== 'number' || typeof attributesSize !== 'number' || typeof indexAttributesSize !== 'number' || typeof renderTargets !== 'number' || typeof total !== 'number') return null;
  return { textures: { count: info.textures, bytes: texturesSize }, geometries: { count: info.geometries, bytes: attributesSize + indexAttributesSize }, renderTargets: { count: renderTargets }, bytes: total };
}

/**
 * Estimated GPU memory held by a scene: unique textures (materials, background, environment), unique geometries, the
 * shadow maps three has built for casting lights, and the renderer's half-float frame-buffer target for the viewport.
 * `measured` is three's own count when `info` carries its byte sizes.
 */
export function estimateMemory(scene: Object3D, info: RendererMemoryInfo, viewport: [number, number], options: MemoryEstimateOptions = {}): MemorySnapshot {
  const { textures, geometries } = collectResources(scene);
  let rtCount = 0;
  let rtBytes = 0;
  // What the renderer allocates for itself counts in info.memory without being in the scene (measured on both backends):
  // the frame-buffer target's colour and depth whatever the viewport, the textures of every shadow map three has built
  // with a VSM map's two blur targets, and what the caller counts for the renderer. ShadowNode.setupShadow creates a
  // light's map when a receiver's lighting first builds and sets `shadow.map` (ShadowNode.js ~529): a casting light whose
  // map three never built (shadow maps disabled, never lit) holds none, and counts as no render target either. A map
  // built but not rendered yet is allowed textures three creates on its first render, so the count reads low until then.
  let allowedTextures = FRAME_BUFFER_TEXTURES + (options.internalTextures ?? 0);
  scene.traverse((o) => {
    const light = o as Object3D & { isLight?: boolean; isPointLight?: boolean; castShadow: boolean; shadow?: { mapSize: { x: number; y: number }; isPointLightShadow?: boolean; map?: ShadowMapTarget | null } };
    const map = light.isLight && light.castShadow ? light.shadow?.map : null;
    if (!map || !light.shadow) return;
    rtCount++;
    rtBytes += light.shadow.mapSize.x * light.shadow.mapSize.y * 4 * (light.isPointLight ? 6 : 1);
    allowedTextures += renderTargetTextures(map);
    // VSM blurs every map but a point light's (ShadowNode.js ~383): an array map keeps its two blur targets on the map
    // (~389-403), a plain one on its shadow node (~409-410), where only the renderer's shadow-map type tells.
    if (light.shadow.isPointLightShadow === true) return;
    if (map._vsmShadowMapVertical || map._vsmShadowMapHorizontal) {
      for (const blur of [map._vsmShadowMapVertical, map._vsmShadowMapHorizontal]) if (blur) allowedTextures += renderTargetTextures(blur);
    } else if (options.shadowMapType === VSMShadowMap) {
      allowedTextures += VSM_BLUR_TEXTURES;
    }
  });
  for (const target of options.renderTargets ?? []) if (target) allowedTextures += renderTargetTextures(target);
  let textureTotal = 0;
  for (const t of textures) textureTotal += textureBytes(t);
  let geometryTotal = 0;
  for (const g of geometries) geometryTotal += geometryBytes(g);
  // Only the byte estimate depends on the viewport.
  if (viewport[0] > 0 && viewport[1] > 0) {
    rtCount++;
    rtBytes += viewport[0] * viewport[1] * 8;
  }
  return {
    textures: { count: Math.max(info.textures, textures.size), bytes: textureTotal },
    geometries: { count: Math.max(info.geometries, geometries.size), bytes: geometryTotal },
    renderTargets: { count: rtCount, bytes: rtBytes },
    // Reachable textures that never rendered are not uploaded, so the count clamps at zero and is exact once everything
    // reachable has been on screen. One geometry is three's own: the output pass's quad.
    unreferenced: { geometries: Math.max(0, info.geometries - geometries.size - INTERNAL_GEOMETRIES), textures: Math.max(0, info.textures - textures.size - allowedTextures) },
    chunks: { total: 0, resident: 0 },
    measured: measuredOf(info),
    estimated: true,
  };
}
