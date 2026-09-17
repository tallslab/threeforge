import {
  AnimationMixer,
  type InstancedBufferAttribute,
  type InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  Matrix4,
  Quaternion,
  Scene,
  Vector3,
  Vector4,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { AnimatedInstances } from '../../src/skinning/AnimatedInstances.js';
import { bakeAnimationTexture } from '../../src/skinning/bakeAnimationTexture.js';
import { buildRig, buildTwoPartRig } from './helpers/rig.js';

function setup(count = 3) {
  const { root, mesh, clip } = buildRig();
  const animation = bakeAnimationTexture(root, [clip], { fps: 10 });
  const instances = new AnimatedInstances({ animation, count });
  return { root, mesh, clip, animation, instances };
}

/** A character placement that does not commute with the rig's part offsets: moved, and turned about y. */
const placement = (): Matrix4 =>
  new Matrix4().compose(
    new Vector3(4, 0, -2),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.1),
    new Vector3(1, 1, 1),
  );

/**
 * The matrix part `k`'s position node applies to instance `i`'s skinned vertices: the instance's row of the shared
 * matrix buffer, then that part material's offset uniform.
 */
function partModel(instances: AnimatedInstances, i: number, k: number): Matrix4 {
  const { offset } = (instances as unknown as { parts: Array<{ offset: { value: Matrix4 } }> }).parts[k]!;
  return new Matrix4().fromArray(instances.matrixBuffer.array as Float32Array, i * 16).multiply(offset.value);
}

/** The matrix buffer is Float32: compare element by element. */
function expectClose(actual: Matrix4, expected: Matrix4, label: string): void {
  actual.elements.forEach((v, j) => expect(v, `${label}[${j}]`).toBeCloseTo(expected.elements[j]!, 5));
}

describe('AnimatedInstances', () => {
  it('builds one instanced mesh per part with a node material copied from the part', () => {
    const { mesh, instances } = setup();
    expect(instances.count).toBe(3);
    expect(instances.meshes).toHaveLength(1);
    const m = instances.meshes[0]!;
    expect((m.geometry as InstancedBufferGeometry).instanceCount).toBe(3);
    expect(m.geometry.getAttribute('position')).toBe(mesh.geometry.getAttribute('position'));
    expect(m.geometry.getAttribute('skinIndex')).toBe(mesh.geometry.getAttribute('skinIndex'));
    expect(m.frustumCulled).toBe(false);
    expect(m.userData.forge).toEqual({ kind: 'vat', instances: 3 });
    expect(m.name).toBe('forge:vat:body');
    const material = m.material as MeshStandardNodeMaterial;
    expect(material).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(material.positionNode).not.toBeNull();
    expect(material.color.getHex()).toBe(0x336699);
    expect(material.roughness).toBe(0.4);
  });

  it('places instances by the character matrix, which getMatrixAt returns; assigns clips and drives time', () => {
    const { animation, instances } = setup();
    // A part offset changed after construction: the part's uniform reads it; the instance row stays the character's.
    animation.parts[0]!.matrix.makeTranslation(0, 0.5, 0);
    const character = new Matrix4().makeTranslation(2, 0, 0);
    instances.setMatrixAt(1, character);
    expect(instances.getMatrixAt(1, new Matrix4()).equals(character)).toBe(true);
    expect(partModel(instances, 1, 0).equals(new Matrix4().makeTranslation(2, 0.5, 0))).toBe(true);
    // InterleavedBuffer.needsUpdate is a setter that bumps the version.
    expect(instances.matrixBuffer.version).toBeGreaterThan(0);
    // Both backends read an interleaved attribute per instance only when its buffer is the instanced kind.
    expect(instances.matrixBuffer).toBeInstanceOf(InstancedInterleavedBuffer);
    expect(instances.matrixBuffer.meshPerAttribute).toBe(1);
    instances.setClipAt(2, 'spin', { offset: 0.5, speed: 2 });
    const clip = instances.clipAttribute as InstancedBufferAttribute;
    expect([clip.getX(2), clip.getY(2), clip.getZ(2), clip.getW(2)]).toEqual([0, 11, 0.5, 2]);
    instances.setClipAt(0, 0);
    expect([clip.getX(0), clip.getY(0), clip.getZ(0), clip.getW(0)]).toEqual([0, 11, 0, 1]);
    expect(() => instances.setClipAt(0, 'nope')).toThrow(/nope/);
    expect(() => instances.setClipAt(0, 7)).toThrow(/7/);
    instances.setTime(1.25);
    expect(instances.time).toBe(1.25);
  });

  it('draws each part of a two-part rig at the character matrix × that part matrix', () => {
    const rig = buildTwoPartRig();
    const animation = bakeAnimationTexture(rig.root, [rig.clip], { fps: 10 });
    expect(animation.parts.map((p) => [p.mesh.name, p.boneOffset])).toEqual([
      ['body', 0],
      ['head', 2],
    ]);
    expect(animation.parts[0]!.matrix.equals(animation.parts[1]!.matrix)).toBe(false);
    const instances = new AnimatedInstances({ animation, count: 3 });
    expect(instances.meshes.map((m) => m.name)).toEqual(['forge:vat:body', 'forge:vat:head']);
    const character = placement();
    instances.setMatrixAt(2, character);
    expectClose(instances.getMatrixAt(2, new Matrix4()), character, 'getMatrixAt');
    animation.parts.forEach((part, k) =>
      expectClose(partModel(instances, 2, k), new Matrix4().multiplyMatrices(character, part.matrix), part.mesh.name),
    );
  });

  it('puts every vertex of both parts where three skins the same rig placed at the character matrix', () => {
    const prototype = buildTwoPartRig();
    const animation = bakeAnimationTexture(prototype.root, [prototype.clip], { fps: 10 });
    const instances = new AnimatedInstances({ animation, count: 1 });
    const character = placement();
    instances.setMatrixAt(0, character);
    // The original: an identical rig at the character's place, posed by a mixer at 0.7 s (baked row 7 at 10 fps).
    const original = buildTwoPartRig();
    character.decompose(original.root.position, original.root.quaternion, original.root.scale);
    const mixer = new AnimationMixer(original.root);
    mixer.clipAction(original.clip).play();
    mixer.setTime(0.7);
    original.root.updateMatrixWorld(true);
    const data = animation.texture.image.data as Float32Array;
    const width = animation.texture.image.width;
    const bone = new Matrix4();
    [original.body, original.head].forEach((mesh, k) => {
      const part = animation.parts[k]!;
      const model = partModel(instances, 0, k);
      const position = mesh.geometry.getAttribute('position');
      const skinIndex = mesh.geometry.getAttribute('skinIndex');
      const skinWeight = mesh.geometry.getAttribute('skinWeight');
      for (let v = 0; v < position.count; v++) {
        // The position node: model × bindMatrixInverse × Σ weight × bone(row 7) × bindMatrix × position.
        const bound = new Vector4(position.getX(v), position.getY(v), position.getZ(v), 1).applyMatrix4(
          part.mesh.bindMatrix,
        );
        const skinned = new Vector4(0, 0, 0, 0);
        for (let w = 0; w < 4; w++) {
          const weight = skinWeight.getComponent(v, w);
          if (weight === 0) continue;
          bone.fromArray(data, (7 * width + (part.boneOffset + skinIndex.getComponent(v, w)) * 4) * 4);
          skinned.addScaledVector(bound.clone().applyMatrix4(bone), weight);
        }
        const drawn = skinned.applyMatrix4(part.mesh.bindMatrixInverse).applyMatrix4(model);
        const expected = mesh
          .applyBoneTransform(v, new Vector3(position.getX(v), position.getY(v), position.getZ(v)))
          .applyMatrix4(mesh.matrixWorld);
        expect([drawn.x, drawn.y, drawn.z], `${mesh.name} vertex ${v}`).toEqual([
          expect.closeTo(expected.x, 4),
          expect.closeTo(expected.y, 4),
          expect.closeTo(expected.z, 4),
        ]);
      }
    });
  });

  it('adds to a parent and disposes materials and instance buffers', () => {
    const { instances } = setup(2);
    const scene = new Scene();
    instances.addTo(scene);
    expect(scene.children).toContain(instances.meshes[0]);
    const dispose = vi.spyOn(instances.meshes[0]!.material as MeshStandardNodeMaterial, 'dispose');
    instances.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(scene.children).not.toContain(instances.meshes[0]);
  });
});
