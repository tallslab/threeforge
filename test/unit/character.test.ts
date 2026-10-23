import { Bone, BufferAttribute, type MeshStandardMaterial, Skeleton, SkinnedMesh, Vector2 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { assembleCharacter } from '../../src/character/assembleCharacter.js';
import { BONE_NAMES, buildCharacter } from '../../test/scenes/character.js';

function vertexCount(mesh: SkinnedMesh): number {
  return mesh.geometry.attributes.position!.count;
}

describe('assembleCharacter', () => {
  it('merges the body and equipped gear into one SkinnedMesh bound to the shared skeleton', () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body, gear[0]!, gear[1]!] });
    expect(character.mesh).toBeInstanceOf(SkinnedMesh);
    expect(character.mesh.skeleton).toBe(skeleton);
    expect(vertexCount(character.mesh)).toBe(vertexCount(body) + vertexCount(gear[0]!) + vertexCount(gear[1]!));
    expect(character.mesh.geometry.index!.count).toBe(
      body.geometry.index!.count + gear[0]!.geometry.index!.count + gear[1]!.geometry.index!.count,
    );
    expect(character.report).toMatchObject({ parts: 3, wardrobe: 5, materials: 1 });
    expect(Array.isArray(character.mesh.material)).toBe(false);
  });

  it('remaps skin indices by bone name across differently ordered skeletons', () => {
    const { body, gear, skeleton } = buildCharacter();
    const helmet = gear[0]!; // its skeleton is ordered [head, spine, root]
    const character = assembleCharacter({ skeleton, wardrobe: [body, helmet], equipped: [body, helmet] });
    const merged = character.mesh.geometry.attributes.skinIndex as BufferAttribute;
    const mergedWeight = character.mesh.geometry.attributes.skinWeight as BufferAttribute;
    const helmetIndex = helmet.geometry.attributes.skinIndex as BufferAttribute;
    const helmetWeight = helmet.geometry.attributes.skinWeight as BufferAttribute;
    const offset = vertexCount(body);
    for (let v = 0; v < helmetIndex.count; v++) {
      for (let k = 0; k < 4; k++) {
        const weight = helmetWeight.getComponent(v, k);
        if (weight === 0) continue;
        const partBone = helmet.skeleton.bones[helmetIndex.getComponent(v, k)]!;
        const sharedIndex = skeleton.bones.findIndex((b) => b.name === partBone.name);
        expect(merged.getComponent(offset + v, k)).toBe(sharedIndex);
        expect(mergedWeight.getComponent(offset + v, k)).toBe(weight);
      }
    }
  });

  it("packs every wardrobe texture into one atlas and remaps UVs into each part's cell", () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({
      skeleton,
      wardrobe: [body, ...gear],
      equipped: [body, ...gear],
      atlas: { size: 64 },
    });
    const material = character.mesh.material as unknown as { map: { image: { width: number; height: number } } };
    expect(material.map.image.width).toBe(64);
    expect(material.map.image.height).toBe(64);
    expect(character.report.atlas).toEqual({ textures: 5, size: 64, cells: 9 });
    // Each part's UVs land inside its own cell; cells never overlap.
    const uv = character.mesh.geometry.attributes.uv as BufferAttribute;
    let start = 0;
    const seen: Array<[number, number]> = [];
    for (const part of [body, ...gear]) {
      const cell = character.cellOf(part)!;
      const min = new Vector2(Infinity, Infinity);
      const max = new Vector2(-Infinity, -Infinity);
      for (let v = start; v < start + vertexCount(part); v++) {
        min.min(new Vector2(uv.getX(v), uv.getY(v)));
        max.max(new Vector2(uv.getX(v), uv.getY(v)));
      }
      expect(min.x).toBeGreaterThanOrEqual(cell.x - 1e-6);
      expect(min.y).toBeGreaterThanOrEqual(cell.y - 1e-6);
      expect(max.x).toBeLessThanOrEqual(cell.x + cell.size + 1e-6);
      expect(max.y).toBeLessThanOrEqual(cell.y + cell.size + 1e-6);
      expect(seen).not.toContainEqual([cell.x, cell.y]);
      seen.push([cell.x, cell.y]);
      start += vertexCount(part);
    }
  });

  it("writes each part's texels into its atlas cell", () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({
      skeleton,
      wardrobe: [body, gear[1]!],
      equipped: [body, gear[1]!],
      atlas: { size: 8 },
    });
    const data = (character.mesh.material as unknown as { map: { image: { data: Uint8Array } } }).map.image.data;
    const cell = character.cellOf(gear[1]!)!; // chest: [150, 40, 40]
    const px = Math.floor((cell.x + cell.size / 2) * 8);
    const py = Math.floor((cell.y + cell.size / 2) * 8);
    const i = (py * 8 + px) * 4;
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([150, 40, 40]);
  });

  it('equip and unequip rebuild the vertex buffer but keep the mesh, material and skeleton', () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body] });
    const mesh = character.mesh;
    const material = mesh.material;
    const before = vertexCount(mesh);
    character.equip(gear[3]!); // sword
    expect(character.mesh).toBe(mesh);
    expect(mesh.material).toBe(material);
    expect(mesh.skeleton).toBe(skeleton);
    expect(vertexCount(mesh)).toBe(before + vertexCount(gear[3]!));
    expect(character.equipped).toEqual([body, gear[3]!]);
    character.unequip(gear[3]!);
    expect(vertexCount(mesh)).toBe(before);
    character.equip(gear[3]!);
    character.equip(gear[3]!); // idempotent
    expect(vertexCount(mesh)).toBe(before + vertexCount(gear[3]!));
  });

  it('rejects a part whose bones are not in the shared skeleton, naming them', () => {
    const { body, skeleton } = buildCharacter();
    const alien = new Bone();
    alien.name = 'tail';
    const stray = new SkinnedMesh(body.geometry.clone(), body.material);
    stray.name = 'tail-part';
    stray.bind(new Skeleton([alien]));
    expect(() => assembleCharacter({ skeleton, wardrobe: [body, stray], equipped: [body, stray] })).toThrow(
      /tail-part.*tail/,
    );
  });

  it('rejects wardrobe parts that are not in the wardrobe when equipping', () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({ skeleton, wardrobe: [body], equipped: [body] });
    expect(() => character.equip(gear[0]!)).toThrow(/wardrobe/);
    expect(BONE_NAMES).toHaveLength(3);
  });
});

/** The merged colour of every vertex, in the order the parts were merged. */
function colours(mesh: SkinnedMesh): number[][] {
  const color = mesh.geometry.getAttribute('color') as BufferAttribute;
  return Array.from({ length: color.count }, (_, v) =>
    Array.from({ length: color.itemSize }, (_, c) => color.getComponent(v, c)),
  );
}

describe('assembleCharacter vertex colours', () => {
  /** What three shades a part's vertices with: its colour attribute when its material uses it, else white. */
  function expected(part: SkinnedMesh, itemSize = 3): number[][] {
    const color = part.geometry.getAttribute('color') as BufferAttribute | undefined;
    const used = (part.material as MeshStandardMaterial).vertexColors && color;
    return Array.from({ length: part.geometry.attributes.position!.count }, (_, v) =>
      Array.from({ length: itemSize }, (_, c) => (used && c < color.itemSize ? color.getComponent(v, c) : 1)),
    );
  }

  it('keeps each part its vertex colours and gives untinted parts white', () => {
    const { body, gear, skeleton } = buildCharacter({ vertexColors: true });
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body, ...gear] });
    expect((character.mesh.material as MeshStandardMaterial).vertexColors).toBe(true);
    expect(character.mesh.geometry.getAttribute('color')!.itemSize).toBe(3);
    const merged = colours(character.mesh);
    expect(merged).toEqual(
      [body, ...gear].flatMap((part) => expected(part)).map((c) => c.map((x) => expect.closeTo(x, 6))),
    );
    // The body is textured and untinted; the gear's colours really vary.
    expect(expected(body).every((c) => c.every((x) => x === 1))).toBe(true);
    expect(new Set(merged.map((c) => c.join())).size).toBeGreaterThan(10);
  });

  it('ignores a colour attribute the part material does not use', () => {
    const { body, gear, skeleton } = buildCharacter({ vertexColors: true });
    const [helmet, chest] = gear as [SkinnedMesh, SkinnedMesh];
    (chest.material as MeshStandardMaterial).vertexColors = false;
    const character = assembleCharacter({ skeleton, wardrobe: [body, helmet, chest], equipped: [chest, helmet] });
    const merged = colours(character.mesh);
    const chestVertices = chest.geometry.attributes.position!.count;
    expect(merged.slice(0, chestVertices).every((c) => c.every((x) => x === 1))).toBe(true);
    expect(merged.slice(chestVertices)).toEqual(expected(helmet).map((c) => c.map((x) => expect.closeTo(x, 6))));
  });

  it('reads normalised RGBA colours and keeps the alpha channel', () => {
    const { body, gear, skeleton } = buildCharacter({ vertexColors: true });
    const helmet = gear[0]!;
    const n = helmet.geometry.attributes.position!.count;
    const rgba = new Uint8Array(n * 4).map((_, i) => (i % 4 === 3 ? 128 : (i * 37) % 256));
    helmet.geometry.setAttribute('color', new BufferAttribute(rgba, 4, true));
    const character = assembleCharacter({ skeleton, wardrobe: [body, helmet], equipped: [body, helmet] });
    expect(character.mesh.geometry.getAttribute('color')!.itemSize).toBe(4);
    const merged = colours(character.mesh);
    expect(merged).toEqual(
      [...expected(body, 4), ...expected(helmet, 4)].map((c) => c.map((x) => expect.closeTo(x, 6))),
    );
    expect(merged.at(-1)![3]).toBeCloseTo(128 / 255, 6);
  });

  it('sets the colour layout from the wardrobe, whatever is equipped', () => {
    const { body, gear, skeleton } = buildCharacter({ vertexColors: true });
    // Nothing coloured is on yet: the material's program and the vertex layout must already fit the gear.
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body] });
    expect((character.mesh.material as MeshStandardMaterial).vertexColors).toBe(true);
    expect(colours(character.mesh)).toEqual(expected(body));
    character.equip(gear[0]!);
    character.unequip(gear[0]!);
    expect(colours(character.mesh)).toEqual(expected(body));
  });

  it('adds no colour attribute to a wardrobe without vertex colours', () => {
    const { body, gear, skeleton } = buildCharacter();
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body, ...gear] });
    expect(character.mesh.geometry.getAttribute('color')).toBeUndefined();
    expect((character.mesh.material as MeshStandardMaterial).vertexColors).toBe(false);
  });
});

/** The merged UVs, in the order the parts were merged. */
function uvs(mesh: SkinnedMesh): number[][] {
  const uv = mesh.geometry.getAttribute('uv') as BufferAttribute;
  return Array.from({ length: uv.count }, (_, v) => [uv.getX(v), uv.getY(v)]);
}

/** A part's own UVs, or `fill` for every vertex of a part without them. */
function sourceUvs(part: SkinnedMesh, fill = [0, 0]): number[][] {
  const uv = part.geometry.getAttribute('uv') as BufferAttribute | undefined;
  return Array.from({ length: part.geometry.attributes.position!.count }, (_, v) =>
    uv ? [uv.getX(v), uv.getY(v)] : fill,
  );
}

describe('assembleCharacter without textures', () => {
  /** What three shades each vertex of `part` with: its material colour times its vertex colour when used. */
  function shaded(part: SkinnedMesh): number[][] {
    const material = part.material as MeshStandardMaterial;
    const color = material.vertexColors ? (part.geometry.getAttribute('color') as BufferAttribute) : undefined;
    return Array.from({ length: part.geometry.attributes.position!.count }, (_, v) =>
      [material.color.r, material.color.g, material.color.b].map((m, c) => m * (color ? color.getComponent(v, c) : 1)),
    );
  }

  it.each([
    ['flat colours', { textures: false }],
    ['flat and vertex colours', { textures: false, vertexColors: true }],
  ])('builds no atlas and carries %s in the vertices', (_, options) => {
    const { body, gear, skeleton } = buildCharacter(options);
    const wardrobe = [body, ...gear];
    const character = assembleCharacter({ skeleton, wardrobe, equipped: wardrobe, atlas: { size: 1024 } });
    const material = character.mesh.material as MeshStandardMaterial;
    expect(material.map).toBeNull();
    expect(material.vertexColors).toBe(true);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(character.report.atlas).toEqual({ textures: 0, size: 0, cells: 0 });
    expect(character.cellOf(body)).toBeUndefined();
    // No atlas, so the parts' own UVs come through unchanged, for a material that samples its own texture.
    expect(uvs(character.mesh)).toEqual(wardrobe.flatMap((part) => sourceUvs(part)));
    expect(colours(character.mesh)).toEqual(wardrobe.flatMap(shaded).map((c) => c.map((x) => expect.closeTo(x, 6))));
    character.dispose();
  });

  it('keeps the atlas when any wardrobe part is textured', () => {
    const { body, gear, skeleton } = buildCharacter({ vertexColors: true });
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body], atlas: { size: 64 } });
    expect((character.mesh.material as MeshStandardMaterial).map).not.toBeNull();
    expect(character.report.atlas.size).toBe(64);
  });

  it('disposes the material and frees no atlas it never built', () => {
    const { body, gear, skeleton } = buildCharacter({ textures: false });
    const character = assembleCharacter({ skeleton, wardrobe: [body, ...gear], equipped: [body] });
    const dispose = vi.spyOn(character.mesh.material as MeshStandardMaterial, 'dispose');
    expect(() => character.dispose()).not.toThrow();
    expect(dispose).toHaveBeenCalled();
  });
});

describe('assembleCharacter UVs without an atlas', () => {
  it('fills a part without UVs and keeps the layout whatever is equipped', () => {
    const { body, gear, skeleton } = buildCharacter({ textures: false });
    const [helmet, chest] = gear as [SkinnedMesh, SkinnedMesh];
    chest.geometry.deleteAttribute('uv');
    const wardrobe = [body, helmet, chest];
    // Nothing with UVs is on yet: the attribute is there for the parts that have them.
    const character = assembleCharacter({ skeleton, wardrobe, equipped: [chest], uvFill: [0.5, 0.25] });
    expect(uvs(character.mesh)).toEqual(sourceUvs(chest, [0.5, 0.25]));
    character.equip(helmet);
    expect(uvs(character.mesh)).toEqual([...sourceUvs(chest, [0.5, 0.25]), ...sourceUvs(helmet)]);
  });

  it('adds no UVs when no wardrobe part has any', () => {
    const { body, gear, skeleton } = buildCharacter({ textures: false });
    const wardrobe = [body, ...gear];
    for (const part of wardrobe) part.geometry.deleteAttribute('uv');
    const character = assembleCharacter({ skeleton, wardrobe, equipped: wardrobe });
    expect(character.mesh.geometry.getAttribute('uv')).toBeUndefined();
  });
});
