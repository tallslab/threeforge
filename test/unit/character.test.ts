import { Bone, type BufferAttribute, Skeleton, SkinnedMesh, Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
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
