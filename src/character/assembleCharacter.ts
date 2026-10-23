import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  RGBAFormat,
  type Skeleton,
  SkinnedMesh,
  SRGBColorSpace,
  type Texture,
  Uint16BufferAttribute,
} from 'three';
import { ensureIndexed } from '../compiler/geometryCompat.js';

/** A part's region of the atlas, in UV units. */
export interface AtlasCell {
  x: number;
  y: number;
  size: number;
}

export interface AssembleOptions {
  /** The live rig every part is skinned to (by bone name). */
  skeleton: Skeleton;
  /** Every part the character may ever wear; the atlas is packed once for all of them. */
  wardrobe: SkinnedMesh[];
  /** Parts merged into the mesh right now. */
  equipped: SkinnedMesh[];
  atlas?: { size?: number };
  /** Template for the single material; defaults to a clone of the first wardrobe part's material. */
  material?: Material;
}

export interface CharacterReport {
  parts: number;
  wardrobe: number;
  materials: number;
  vertices: number;
  triangles: number;
  atlas: { textures: number; size: number; cells: number };
}

export interface AssembledCharacter {
  /** The one skinned mesh to put in the scene in place of the parts. Never replaced by equip/unequip. */
  mesh: SkinnedMesh;
  equipped: readonly SkinnedMesh[];
  report: CharacterReport;
  equip(part: SkinnedMesh): void;
  unequip(part: SkinnedMesh): void;
  cellOf(part: SkinnedMesh): AtlasCell | undefined;
  dispose(): void;
}

type MaterialWithMap = Material & { map?: Texture | null; color?: Color };

function materialOf(part: SkinnedMesh): MaterialWithMap {
  return (Array.isArray(part.material) ? part.material[0] : part.material) as MaterialWithMap;
}

/** The colour attribute three shades `part` with, or undefined when its material does not use one. */
function vertexColorsOf(part: SkinnedMesh): BufferAttribute | undefined {
  return materialOf(part).vertexColors
    ? (part.geometry.getAttribute('color') as BufferAttribute | undefined)
    : undefined;
}

function readTexels(
  texture: Texture | null | undefined,
  fallback: Color | undefined,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const image = texture?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  if (image?.data && image.width && image.height) {
    // DataTexture path (node and browser): nearest resample into the cell.
    const src = image.data;
    const sw = image.width;
    const sh = image.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.floor((y / h) * sh));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor((x / w) * sw));
        const si = (sy * sw + sx) * 4;
        const di = (y * w + x) * 4;
        out[di] = src[si]!;
        out[di + 1] = src[si + 1]!;
        out[di + 2] = src[si + 2]!;
        out[di + 3] = src[si + 3] ?? 255;
      }
    }
    return out;
  }
  if (texture?.image && typeof OffscreenCanvas !== 'undefined') {
    // Browser path for images, bitmaps and canvases.
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(texture.image as CanvasImageSource, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      out.set(pixels);
      // Canvas rows are top-down; DataTexture rows are bottom-up (flipY false).
      const row = new Uint8Array(w * 4);
      for (let y = 0; y < h / 2; y++) {
        const a = y * w * 4;
        const b = (h - 1 - y) * w * 4;
        row.set(out.subarray(a, a + w * 4));
        out.copyWithin(a, b, b + w * 4);
        out.set(row, b);
      }
      return out;
    }
  }
  const color = fallback ?? new Color(0xffffff);
  const hex = color.getHex(SRGBColorSpace);
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

const WHITE = new Color(1, 1, 1);

/** A k x k grid of equal cells, one per wardrobe part, packed once. */
function packAtlas(
  wardrobe: SkinnedMesh[],
  atlasSize: number,
): { atlas: DataTexture; cells: Map<SkinnedMesh, AtlasCell>; cellCount: number } {
  const k = Math.ceil(Math.sqrt(wardrobe.length));
  const cellTexels = Math.floor(atlasSize / k);
  const data = new Uint8Array(atlasSize * atlasSize * 4);
  const cells = new Map<SkinnedMesh, AtlasCell>();
  wardrobe.forEach((part, i) => {
    const col = i % k;
    const row = Math.floor(i / k);
    const material = materialOf(part);
    const texels = readTexels(material.map, material.color, cellTexels, cellTexels);
    for (let y = 0; y < cellTexels; y++) {
      const dst = ((row * cellTexels + y) * atlasSize + col * cellTexels) * 4;
      data.set(texels.subarray(y * cellTexels * 4, (y + 1) * cellTexels * 4), dst);
    }
    cells.set(part, {
      x: (col * cellTexels) / atlasSize,
      y: (row * cellTexels) / atlasSize,
      size: cellTexels / atlasSize,
    });
  });
  const atlas = new DataTexture(data, atlasSize, atlasSize, RGBAFormat);
  atlas.colorSpace = SRGBColorSpace;
  atlas.generateMipmaps = true;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.needsUpdate = true;
  atlas.name = 'forge:character-atlas';
  return { atlas, cells, cellCount: k * k };
}

/**
 * Maps a part's UVs onto its cell: clamped (three's SphereGeometry emits slightly negative U at the poles) and onto the
 * cell's texel centres with a half-texel inset, so linear filtering never bleeds into a neighbouring cell.
 */
function writeCellUvs(
  uv: Float32Array,
  v0: number,
  source: BufferAttribute | undefined,
  count: number,
  cell: AtlasCell,
  atlasSize: number,
): void {
  const inset = 0.5 / atlasSize;
  const span = cell.size - 2 * inset;
  for (let v = 0; v < count; v++) {
    const u = source ? Math.min(1, Math.max(0, source.getX(v))) : 0.5;
    const w = source ? Math.min(1, Math.max(0, source.getY(v))) : 0.5;
    uv[(v0 + v) * 2] = cell.x + inset + u * span;
    uv[(v0 + v) * 2 + 1] = cell.y + inset + w * span;
  }
}

/** Writes `tint` times the part's own vertex colours (white where it has none, alpha 1 where it has no alpha). */
function writeColors(
  color: Float32Array,
  v0: number,
  size: number,
  count: number,
  tint: Color,
  source: BufferAttribute | undefined,
): void {
  const rgb = [tint.r, tint.g, tint.b, 1];
  // getComponent reads normalised integer colours (glTF COLOR_0 as bytes or shorts) as 0..1.
  for (let v = 0; v < count; v++)
    for (let c = 0; c < size; c++)
      color[(v0 + v) * size + c] = rgb[c]! * (source && c < source.itemSize ? source.getComponent(v, c) : 1);
}

/** Copies a part's skin weights with bone indices remapped onto the shared skeleton; unskinned parts follow bone 0. */
function writeSkin(
  skinIndex: Uint16Array,
  skinWeight: Float32Array,
  v0: number,
  geometry: BufferGeometry,
  map: Int32Array,
): void {
  const si = geometry.attributes.skinIndex as BufferAttribute | undefined;
  const sw = geometry.attributes.skinWeight as BufferAttribute | undefined;
  for (let v = 0; v < geometry.attributes.position!.count; v++) {
    for (let c = 0; c < 4; c++) {
      const weight = sw ? sw.getComponent(v, c) : c === 0 ? 1 : 0;
      const bone = si ? si.getComponent(v, c) : 0;
      skinIndex[(v0 + v) * 4 + c] = weight > 0 ? map[bone]! : 0;
      skinWeight[(v0 + v) * 4 + c] = weight;
    }
  }
}

/**
 * Merge equipped gear onto the shared skeleton so a character is one skinned mesh with one material and one atlas.
 * Equipping changes the vertex buffer, never the draw count. Parts are matched to the rig by bone name, so each part
 * may come from its own export with its own bone order.
 */
export function assembleCharacter(options: AssembleOptions): AssembledCharacter {
  const { skeleton, wardrobe } = options;
  const atlasSize = options.atlas?.size ?? 1024;
  if (wardrobe.length === 0) throw new Error('assembleCharacter: the wardrobe is empty.');

  // Bone remap per part.
  const sharedIndex = new Map(skeleton.bones.map((b, i) => [b.name, i] as const));
  const boneMaps = new Map<SkinnedMesh, Int32Array>();
  for (const part of wardrobe) {
    const map = new Int32Array(part.skeleton.bones.length);
    const missing: string[] = [];
    part.skeleton.bones.forEach((bone, i) => {
      const index = sharedIndex.get(bone.name);
      if (index === undefined) missing.push(bone.name || `#${i}`);
      else map[i] = index;
    });
    if (missing.length > 0)
      throw new Error(
        `assembleCharacter: part "${part.name}" uses bones missing from the shared skeleton: ${missing.join(', ')}`,
      );
    boneMaps.set(part, map);
  }

  // A wardrobe without textures needs no atlas: each part's material colour goes into its vertex colours instead.
  const textured = wardrobe.some((part) => materialOf(part).map);
  const packed = textured ? packAtlas(wardrobe, atlasSize) : null;
  const atlas = packed?.atlas ?? null;
  const cells = packed?.cells ?? new Map<SkinnedMesh, AtlasCell>();

  const template = (options.material ?? materialOf(wardrobe[0]!)).clone() as MaterialWithMap;
  template.map = atlas;
  if (template.color) template.color.set(0xffffff);
  // Decided from the whole wardrobe, so equipping never changes the material's program or the vertex layout: RGBA
  // when any part shades with alpha, and white for the vertices of parts that use no colours.
  const colorSize = Math.max(textured ? 0 : 3, ...wardrobe.map((part) => vertexColorsOf(part)?.itemSize ?? 0));
  template.vertexColors = colorSize > 0;
  template.name = 'forge:character';
  // What multiplies each part's vertex colours: white under an atlas, which holds the material colour already.
  const tints = new Map(wardrobe.map((part) => [part, textured ? WHITE : (materialOf(part).color ?? WHITE)] as const));

  const equipped: SkinnedMesh[] = [];
  for (const part of options.equipped) {
    if (!wardrobe.includes(part)) throw new Error(`assembleCharacter: part "${part.name}" is not in the wardrobe.`);
    if (!equipped.includes(part)) equipped.push(part);
  }

  const build = (): BufferGeometry => {
    let vertices = 0;
    let indices = 0;
    const sources = equipped.map((part) => ensureIndexed(part.geometry));
    for (const g of sources) {
      vertices += g.attributes.position!.count;
      indices += g.index!.count;
    }
    const position = new Float32Array(vertices * 3);
    const normal = new Float32Array(vertices * 3);
    const uv = atlas ? new Float32Array(vertices * 2) : null;
    const skinIndex = new Uint16Array(vertices * 4);
    const skinWeight = new Float32Array(vertices * 4);
    const color = colorSize > 0 ? new Float32Array(vertices * colorSize) : null;
    const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    let v0 = 0;
    let i0 = 0;
    equipped.forEach((part, p) => {
      const g = sources[p]!;
      const count = g.attributes.position!.count;
      const map = boneMaps.get(part)!;
      position.set(g.attributes.position!.array as Float32Array, v0 * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array as Float32Array, v0 * 3);
      if (uv) writeCellUvs(uv, v0, g.attributes.uv as BufferAttribute | undefined, count, cells.get(part)!, atlasSize);
      if (color) writeColors(color, v0, colorSize, count, tints.get(part)!, vertexColorsOf(part));
      writeSkin(skinIndex, skinWeight, v0, g, map);
      const srcIndex = g.index!;
      for (let i = 0; i < srcIndex.count; i++) index[i0 + i] = srcIndex.getX(i) + v0;
      v0 += count;
      i0 += srcIndex.count;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    if (uv) geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
    if (color) geometry.setAttribute('color', new Float32BufferAttribute(color, colorSize));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  };

  const first = wardrobe[0]!;
  const mesh = new SkinnedMesh(build(), template as Material);
  mesh.name = 'forge:character';
  mesh.castShadow = first.castShadow;
  mesh.receiveShadow = first.receiveShadow;
  mesh.bind(skeleton, first.bindMatrix);
  // Take over the rig root(s) parented under wardrobe parts so the parts can leave the scene.
  for (const bone of skeleton.bones) {
    if (bone.parent && wardrobe.includes(bone.parent as SkinnedMesh)) mesh.add(bone);
  }

  const report: CharacterReport = {
    parts: equipped.length,
    wardrobe: wardrobe.length,
    materials: 1,
    vertices: mesh.geometry.attributes.position!.count,
    triangles: mesh.geometry.index!.count / 3,
    atlas: packed
      ? { textures: wardrobe.length, size: atlasSize, cells: packed.cellCount }
      : { textures: 0, size: 0, cells: 0 },
  };
  const rebuild = (): void => {
    const old = mesh.geometry;
    mesh.geometry = build();
    old.dispose();
    report.parts = equipped.length;
    report.vertices = mesh.geometry.attributes.position!.count;
    report.triangles = mesh.geometry.index!.count / 3;
  };

  return {
    mesh,
    equipped,
    report,
    equip(part) {
      if (!wardrobe.includes(part)) throw new Error(`assembleCharacter: part "${part.name}" is not in the wardrobe.`);
      if (equipped.includes(part)) return;
      equipped.push(part);
      rebuild();
    },
    unequip(part) {
      const i = equipped.indexOf(part);
      if (i < 0) return;
      equipped.splice(i, 1);
      rebuild();
    },
    cellOf(part) {
      return cells.get(part);
    },
    dispose() {
      mesh.geometry.dispose();
      (mesh.material as Material).dispose();
      atlas?.dispose();
    },
  };
}
