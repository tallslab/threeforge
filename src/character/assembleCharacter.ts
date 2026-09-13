import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  SkinnedMesh,
  SRGBColorSpace,
  Uint16BufferAttribute,
  type Material,
  type Skeleton,
  type Texture,
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

function readTexels(texture: Texture | null | undefined, fallback: Color | undefined, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const image = texture?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  if (image && image.data && image.width && image.height) {
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

/**
 * The PolyMorph lesson: merge equipped gear onto the shared skeleton so a character is one skinned mesh with one
 * material and one atlas. Equipping changes the vertex buffer, never the draw count. Parts are matched to the
 * rig by bone name, so each part may come from its own export with its own bone order.
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
    if (missing.length > 0) throw new Error(`assembleCharacter: part "${part.name}" uses bones missing from the shared skeleton: ${missing.join(', ')}`);
    boneMaps.set(part, map);
  }

  // Atlas: k x k grid of equal cells, one per wardrobe part, packed once.
  const k = Math.ceil(Math.sqrt(wardrobe.length));
  const cellTexels = Math.floor(atlasSize / k);
  const data = new Uint8Array(atlasSize * atlasSize * 4);
  const cells = new Map<SkinnedMesh, AtlasCell>();
  wardrobe.forEach((part, i) => {
    const col = i % k;
    const row = Math.floor(i / k);
    const material = (Array.isArray(part.material) ? part.material[0] : part.material) as MaterialWithMap;
    const texels = readTexels(material.map, material.color, cellTexels, cellTexels);
    for (let y = 0; y < cellTexels; y++) {
      const dst = ((row * cellTexels + y) * atlasSize + col * cellTexels) * 4;
      data.set(texels.subarray(y * cellTexels * 4, (y + 1) * cellTexels * 4), dst);
    }
    cells.set(part, { x: (col * cellTexels) / atlasSize, y: (row * cellTexels) / atlasSize, size: cellTexels / atlasSize });
  });
  const atlas = new DataTexture(data, atlasSize, atlasSize, RGBAFormat);
  atlas.colorSpace = SRGBColorSpace;
  atlas.generateMipmaps = true;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.needsUpdate = true;
  atlas.name = 'forge:character-atlas';

  const template = (options.material ?? ((Array.isArray(wardrobe[0]!.material) ? wardrobe[0]!.material[0] : wardrobe[0]!.material) as Material)).clone() as MaterialWithMap;
  template.map = atlas;
  if (template.color) template.color.set(0xffffff);
  template.name = 'forge:character';

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
    const uv = new Float32Array(vertices * 2);
    const skinIndex = new Uint16Array(vertices * 4);
    const skinWeight = new Float32Array(vertices * 4);
    const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    let v0 = 0;
    let i0 = 0;
    equipped.forEach((part, p) => {
      const g = sources[p]!;
      const count = g.attributes.position!.count;
      const cell = cells.get(part)!;
      const map = boneMaps.get(part)!;
      position.set(g.attributes.position!.array as Float32Array, v0 * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array as Float32Array, v0 * 3);
      const srcUv = g.attributes.uv;
      // Clamp (three's SphereGeometry emits slightly negative U at the poles) and map onto the cell's texel
      // centres with a half-texel inset, so linear filtering never bleeds into a neighbouring cell.
      const inset = 0.5 / atlasSize;
      const span = cell.size - 2 * inset;
      for (let v = 0; v < count; v++) {
        const u = srcUv ? Math.min(1, Math.max(0, srcUv.getX(v))) : 0.5;
        const w = srcUv ? Math.min(1, Math.max(0, srcUv.getY(v))) : 0.5;
        uv[(v0 + v) * 2] = cell.x + inset + u * span;
        uv[(v0 + v) * 2 + 1] = cell.y + inset + w * span;
      }
      const si = g.attributes.skinIndex as BufferAttribute | undefined;
      const sw = g.attributes.skinWeight as BufferAttribute | undefined;
      for (let v = 0; v < count; v++) {
        for (let c = 0; c < 4; c++) {
          const weight = sw ? sw.getComponent(v, c) : c === 0 ? 1 : 0;
          const bone = si ? si.getComponent(v, c) : 0;
          skinIndex[(v0 + v) * 4 + c] = weight > 0 ? map[bone]! : 0;
          skinWeight[(v0 + v) * 4 + c] = weight;
        }
      }
      const srcIndex = g.index!;
      for (let i = 0; i < srcIndex.count; i++) index[i0 + i] = srcIndex.getX(i) + v0;
      v0 += count;
      i0 += srcIndex.count;
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
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
    atlas: { textures: wardrobe.length, size: atlasSize, cells: k * k },
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
      atlas.dispose();
    },
  };
}
