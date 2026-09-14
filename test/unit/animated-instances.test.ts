import { describe, expect, it, vi } from 'vitest';
import { InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Scene } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { AnimatedInstances } from '../../src/skinning/AnimatedInstances.js';
import { bakeAnimationTexture } from '../../src/skinning/bakeAnimationTexture.js';
import { buildRig } from './helpers/rig.js';

function setup(count = 3) {
  const { root, mesh, clip } = buildRig();
  const animation = bakeAnimationTexture(root, [clip], { fps: 10 });
  const instances = new AnimatedInstances({ animation, count });
  return { root, mesh, clip, animation, instances };
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

  it('places instances (folding the part offset in), assigns clips and drives time', () => {
    const { animation, instances } = setup();
    animation.parts[0]!.matrix.makeTranslation(0, 0.5, 0);
    instances.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    const out = new Matrix4();
    instances.getMatrixAt(1, out);
    expect(out.elements[12]).toBe(2);
    expect(out.elements[13]).toBe(0.5);
    // InterleavedBuffer.needsUpdate is a setter that bumps the version.
    expect(instances.matrixBuffer.version).toBeGreaterThan(0);
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
