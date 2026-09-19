import {
  AlphaFormat,
  type BufferGeometry,
  DepthFormat,
  DepthStencilFormat,
  FloatType,
  HalfFloatType,
  IntType,
  type Object3D,
  RedFormat,
  RedIntegerFormat,
  RGBFormat,
  RGBIntegerFormat,
  RGFormat,
  RGIntegerFormat,
  ShortType,
  type Texture,
  UnsignedInt248Type,
  UnsignedInt5999Type,
  UnsignedInt101111Type,
  UnsignedIntType,
  UnsignedShort4444Type,
  UnsignedShort5551Type,
  UnsignedShortType,
  VSMShadowMap,
} from 'three';
import { collectResources } from '../memory/resources.js';
import type { MeasuredMemory, MemorySnapshot } from './snapshot.js';

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
  const channel =
    type === ShortType || type === UnsignedShortType || type === HalfFloatType
      ? 2
      : type === IntType || type === UnsignedIntType || type === FloatType
        ? 4
        : 1;
  let channels = 4;
  if (
    format === AlphaFormat ||
    format === RedFormat ||
    format === RedIntegerFormat ||
    format === DepthFormat ||
    format === DepthStencilFormat
  )
    channels = 1;
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
  if (typeof image.videoWidth === 'number')
    return { width: image.videoWidth || 1, height: image.videoHeight || 1, depth: 1 };
  if (typeof image.displayWidth === 'number')
    return { width: image.displayWidth || 1, height: image.displayHeight || 1, depth: 1 };
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
    if (Array.isArray(t.image))
      return (t.image as Array<{ mipmaps?: unknown } | null>).reduce(
        (bytes, face) => bytes + mipDataBytes(face?.mipmaps),
        0,
      );
    return 0;
  }
  const { width, height, depth } = allocatedSize(t);
  const texel = texelBytes(t.format, t.type);
  const mipmaps = Array.isArray(t.mipmaps) ? (t.mipmaps as Array<MipLevel | null>) : [];
  if (mipmaps.length === 0) return Math.round(width * height * depth * texel * (t.generateMipmaps ? 1.333 : 1));
  let bytes = 0;
  if (t.isCubeTexture) {
    bytes = width * height * depth * texel;
    for (let level = 1; level <= mipmaps.length; level++)
      bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * depth * texel;
  } else {
    for (let level = 0; level < mipmaps.length; level++) {
      const mip = mipmaps[level];
      bytes += mip?.data
        ? mip.data.byteLength
        : (mip?.width || Math.max(1, width >> level)) * (mip?.height || Math.max(1, height >> level)) * depth * texel;
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
  width?: number;
  height?: number;
}

/**
 * What a held target allocates beyond the scene's textures: each colour attachment by its own format unless the scene
 * shows it (a PMREM environment's bytes are the scene's already), and a depth attachment at 4 bytes a texel.
 */
function targetBytes(target: AllowedRenderTarget, reachable: ReadonlySet<unknown>): number {
  let bytes = 0;
  for (const colour of target.textures ?? [])
    if ((colour as Texture | null)?.isTexture && !reachable.has(colour)) bytes += textureBytes(colour as Texture);
  if (target.depthTexture || target.depthBuffer || target.stencilBuffer)
    bytes += (target.width ?? 0) * (target.height ?? 0) * 4;
  return bytes;
}

/**
 * Textures three r186 creates for a render target once it is used (renderers/common/Textures.js `updateRenderTarget`,
 * ~68-160): one per colour attachment, and a depth texture when the target has one or a depth or stencil buffer.
 */
function renderTargetTextures(target: AllowedRenderTarget): number {
  return (
    (Array.isArray(target.textures) ? target.textures.length : 1) +
    (target.depthTexture || target.depthBuffer || target.stencilBuffer ? 1 : 0)
  );
}

/**
 * `renderTargetTextures` for a target the renderer holds, by identity where the target shows its textures: a colour
 * texture or a depth texture the scene reaches (a mirror's `rt.texture` in a material) or already allowed is not allowed
 * again. A depth texture three creates for a depth buffer lives in its own data, not on the target, and counts one.
 */
function heldTargetTextures(
  target: AllowedRenderTarget,
  reachable: ReadonlySet<unknown>,
  allowed: Set<unknown>,
): number {
  const once = (texture: unknown): number => {
    if (reachable.has(texture) || allowed.has(texture)) return 0;
    allowed.add(texture);
    return 1;
  };
  let count = 0;
  if (Array.isArray(target.textures)) for (const texture of target.textures) count += once(texture);
  else count += 1;
  if (target.depthTexture) count += once(target.depthTexture);
  else if (target.depthBuffer || target.stencilBuffer) count += 1;
  return count;
}

/** three r186 NodeMaterial.setupPosition (~770) morphs a geometry with any of these, and Morph.js (~93) gives it one texture. */
function hasMorphTexture(geometry: BufferGeometry): boolean {
  const morph = geometry.morphAttributes as { position?: unknown; normal?: unknown; color?: unknown } | undefined;
  return Boolean(morph && (morph.position || morph.normal || morph.color));
}

/** A built shadow map: an array map carries its VSM blur targets (ShadowNode.js ~389-403). */
type ShadowMapTarget = AllowedRenderTarget & {
  _vsmShadowMapVertical?: AllowedRenderTarget | null;
  _vsmShadowMapHorizontal?: AllowedRenderTarget | null;
};

/** Renderer-internal allocations present on an empty scene: the output pass's quad, the frame-buffer target's colour and depth. */
const INTERNAL_GEOMETRIES = 1;
const FRAME_BUFFER_TEXTURES = 2;
/** A non-point VSM map's two colour-only RG half-float blur targets, kept on its shadow node (ShadowNode.js ~409-410). */
const VSM_BLUR_TEXTURES = 2;
/** Bytes a texel of a blur target: RG half-float is 2 channels of 2 bytes (ShadowNode.js ~391, ~409-410). */
const VSM_BLUR_TEXEL_BYTES = 4;

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
  /**
   * Textures the renderer created for itself, by identity: one the scene also reaches counts once. The ledger passes the
   * live render-target textures three's PMREMGenerator created (`isPMREMTexture`).
   */
  rendererTextures?: Iterable<unknown>;
  /**
   * Geometries the renderer drew for itself outside every scene, by identity: one a mesh also reaches counts once. The
   * ledger passes PMREMGenerator's LOD planes and what three draws as a renderer-internal object (the background sphere);
   * the output pass's shared quad is always allowed.
   */
  internalGeometries?: Iterable<unknown>;
  /** `renderer.shadowMap.type`: under `VSMShadowMap` each built non-point shadow map also holds two blur targets. */
  shadowMapType?: number;
  /**
   * The renderer's frame-buffer targets when it shows them (three r186 `renderer._frameBufferTargets`): their textures are
   * allowed by identity. Without it the estimate allows a colour and a depth texture, what a canvas render draws into;
   * with it, none when three drew into none (a RenderPipeline that renders the output itself).
   */
  frameBufferTargets?: Iterable<AllowedRenderTarget>;
  /**
   * Textures the scene's draws bind (the ledger reads them from the draws of one frame after each rescan). They show
   * what only exists once a shader is built, a texture created inside an `Fn`. One the scene also reaches counts once;
   * one that belongs to a render target stands for that target. They are what is sampled, not everything allocated.
   */
  sampledTextures?: Iterable<Texture>;
}

/**
 * The targets held for the scene: those the caller names, and those whose texture a draw samples. A sampled texture
 * that belongs to no target is added to `textures`, as if a property held it; one the scene shows is there already.
 */
function heldTargets(options: MemoryEstimateOptions, textures: Set<Texture>): Set<AllowedRenderTarget> {
  const held = new Set<AllowedRenderTarget>();
  for (const target of options.renderTargets ?? []) if (target) held.add(target);
  for (const sampled of options.sampledTextures ?? []) {
    const target = (sampled as { renderTarget?: AllowedRenderTarget | null }).renderTarget;
    if (target) held.add(target);
    else if (!sampled.isRenderTargetTexture) textures.add(sampled);
  }
  return held;
}

/** three's own counts and byte sizes, null when `info` does not carry them. */
function measuredOf(info: RendererMemoryInfo): MeasuredMemory | null {
  const { texturesSize, attributesSize, indexAttributesSize, renderTargets, total } = info;
  if (
    typeof texturesSize !== 'number' ||
    typeof attributesSize !== 'number' ||
    typeof indexAttributesSize !== 'number' ||
    typeof renderTargets !== 'number' ||
    typeof total !== 'number'
  )
    return null;
  return {
    textures: { count: info.textures, bytes: texturesSize },
    geometries: { count: info.geometries, bytes: attributesSize + indexAttributesSize },
    renderTargets: { count: renderTargets },
    bytes: total,
  };
}

/**
 * Estimated GPU memory held by a scene: unique textures (materials, background, environment), unique geometries, the
 * shadow maps three has built for casting lights, and the renderer's half-float frame-buffer target for the viewport.
 * `measured` is three's own count when `info` carries its byte sizes.
 */
export function estimateMemory(
  scene: Object3D,
  info: RendererMemoryInfo,
  viewport: [number, number],
  options: MemoryEstimateOptions = {},
): MemorySnapshot {
  const { textures, geometries } = collectResources(scene);
  let rtCount = 0;
  let rtBytes = 0;
  // What the renderer allocates for itself counts in info.memory without being in the scene (measured on both backends):
  // the frame-buffer target's colour and depth whatever the viewport, the textures of every shadow map three has built
  // with a VSM map's two blur targets, and what the caller counts for the renderer. ShadowNode.setupShadow creates a
  // light's map when a receiver's lighting first builds and sets `shadow.map` (ShadowNode.js ~529): a casting light whose
  // map three never built (shadow maps disabled, never lit) holds none, and counts as no render target either. A map
  // built but not rendered yet is allowed textures three creates on its first render, so the count reads low until then.
  let allowedTextures = (options.frameBufferTargets ? 0 : FRAME_BUFFER_TEXTURES) + (options.internalTextures ?? 0);
  // Targets already counted, bytes and textures both: a shadow map a receiver samples is not a second target.
  const counted = new Set<unknown>(options.frameBufferTargets ?? []);
  scene.traverse((o) => {
    const light = o as Object3D & {
      isLight?: boolean;
      isPointLight?: boolean;
      castShadow: boolean;
      shadow?: { mapSize: { x: number; y: number }; isPointLightShadow?: boolean; map?: ShadowMapTarget | null };
    };
    const map = light.isLight && light.castShadow ? light.shadow?.map : null;
    if (!map || !light.shadow) return;
    counted.add(map);
    rtCount++;
    // A point light's target is a cube three allocates from the map's width alone, six faces at width x width
    // (PointShadowNode.js:227, :254), so its bytes are the texels `lighting.shadowTexels` counts for it, times 4.
    const size = light.shadow.mapSize;
    rtBytes += light.isPointLight ? size.x * size.x * 4 * 6 : size.x * size.y * 4;
    allowedTextures += renderTargetTextures(map);
    // VSM blurs every map but a point light's (ShadowNode.js ~383): an array map keeps its two blur targets on the map
    // (~389-403), a plain one on its shadow node (~409-410), where only the renderer's shadow-map type tells.
    if (light.shadow.isPointLightShadow === true) return;
    let blurTargets = 0;
    if (map._vsmShadowMapVertical || map._vsmShadowMapHorizontal) {
      for (const blur of [map._vsmShadowMapVertical, map._vsmShadowMapHorizontal])
        if (blur) {
          counted.add(blur);
          allowedTextures += renderTargetTextures(blur);
          blurTargets++;
        }
    } else if (options.shadowMapType === VSMShadowMap) {
      allowedTextures += VSM_BLUR_TEXTURES;
      blurTargets = VSM_BLUR_TEXTURES;
    }
    // Each blur target is a render target of its own, sized like the map it blurs. An array map's layers are left out
    // of its bytes, as they are left out of the map's own bytes above.
    rtCount += blurTargets;
    rtBytes += blurTargets * light.shadow.mapSize.x * light.shadow.mapSize.y * VSM_BLUR_TEXEL_BYTES;
  });
  // By identity from here: a texture the scene reaches, or one already allowed, is not allowed again.
  const allowed = new Set<unknown>();
  for (const target of options.frameBufferTargets ?? [])
    allowedTextures += heldTargetTextures(target, textures, allowed);
  // Allowing a target says it is no leak; its bytes are counted all the same.
  for (const target of heldTargets(options, textures)) {
    if (counted.has(target)) continue;
    counted.add(target);
    allowedTextures += heldTargetTextures(target, textures, allowed);
    rtCount++;
    rtBytes += targetBytes(target, textures);
  }
  for (const texture of options.rendererTextures ?? [])
    if (!textures.has(texture as Texture) && !allowed.has(texture)) {
      allowed.add(texture);
      allowedTextures++;
    }
  // Morph targets: one float DataArrayTexture per morphed geometry, which nothing in the scene reaches.
  for (const g of geometries) if (hasMorphTexture(g)) allowedTextures++;
  let internalGeometries = INTERNAL_GEOMETRIES;
  for (const g of options.internalGeometries ?? []) if (!geometries.has(g as BufferGeometry)) internalGeometries++;
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
    unreferenced: {
      geometries: Math.max(0, info.geometries - geometries.size - internalGeometries),
      textures: Math.max(0, info.textures - textures.size - allowedTextures),
    },
    chunks: { total: 0, resident: 0 },
    measured: measuredOf(info),
    estimated: true,
  };
}
