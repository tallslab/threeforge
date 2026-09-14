import { describe, expect, it } from 'vitest';
import { AnimationClip, Matrix4, QuaternionKeyframeTrack } from 'three';
import { bakeAnimationTexture } from '../../src/skinning/bakeAnimationTexture.js';
import { buildRig } from './helpers/rig.js';

const row = (data: Float32Array, width: number, y: number, bone: number): number[] => Array.from(data.subarray((y * width + bone * 4) * 4, (y * width + bone * 4 + 4) * 4));

describe('bakeAnimationTexture', () => {
  it('bakes one row of bone matrices per frame, per clip, and restores the prototype', () => {
    const { root, mesh, clip } = buildRig();
    root.position.set(5, 0, 0);
    root.rotation.y = 1;
    root.updateMatrixWorld(true);
    const baked = bakeAnimationTexture(root, [clip], { fps: 10 });
    expect(baked.bones).toBe(2);
    expect(baked.fps).toBe(10);
    expect(baked.texture.image.width).toBe(8);
    expect(baked.texture.image.height).toBe(11);
    expect(baked.clips).toEqual([{ name: 'spin', start: 0, frames: 11, duration: 1 }]);
    expect(baked.parts).toHaveLength(1);
    expect(baked.parts[0]!.mesh).toBe(mesh);
    expect(baked.parts[0]!.matrix.equals(new Matrix4())).toBe(true);
    const data = baked.texture.image.data as Float32Array;
    const first = row(data, 8, 0, 1);
    const last = row(data, 8, 10, 1);
    // At t = 0 the pose is the bind pose: bone.matrixWorld × boneInverse is the identity.
    expect(first.map((v) => Number(v.toFixed(5)))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(last).not.toEqual(first);
    expect(root.position.x).toBe(5);
    expect(root.rotation.y).toBeCloseTo(1, 6);
  });

  it('appends a second clip after the first', () => {
    const { root, clip } = buildRig();
    const still = new AnimationClip('still', 0.5, [new QuaternionKeyframeTrack('b.quaternion', [0, 0.5], [0, 0, 0, 1, 0, 0, 0, 1])]);
    const baked = bakeAnimationTexture(root, [clip, still], { fps: 10 });
    expect(baked.clips.map((c) => [c.name, c.start, c.frames])).toEqual([['spin', 0, 11], ['still', 11, 6]]);
    expect(baked.texture.image.height).toBe(17);
  });
});
