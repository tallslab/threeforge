import {
  AnimationClip,
  AnimationMixer,
  type InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  LoopOnce,
  Matrix4,
  Quaternion,
  QuaternionKeyframeTrack,
  Scene,
  Vector3,
  Vector4,
} from 'three';
import { MeshBasicNodeMaterial, MeshLambertNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
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

  it('places instances by the character matrix, assigns clips and drives time', () => {
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
    const clip = instances.clipAttribute;
    // `spin` lasts 1 s: 11 baked rows at 10 fps, and a loop of 10.
    expect([clip.getX(2), clip.getY(2), clip.getZ(2), clip.getW(2)]).toEqual([0, 10, 0.5, 2]);
    instances.setClipAt(0, 0);
    expect([clip.getX(0), clip.getY(0), clip.getZ(0), clip.getW(0)]).toEqual([0, 10, 0, 1]);
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

  it('puts every vertex where three skins the same rig at the character matrix', () => {
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

describe('AnimatedInstances playback loop', () => {
  const FPS = 10;

  /** A clip turning the rig's bone `b`, lasting `duration` seconds. */
  function turn(name: string, duration: number): AnimationClip {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1);
    const times = duration === 0 ? [0] : [0, duration];
    const values = duration === 0 ? [q.x, q.y, q.z, q.w] : [0, 0, 0, 1, q.x, q.y, q.z, q.w];
    return new AnimationClip(name, duration, [new QuaternionKeyframeTrack('b.quaternion', times, values)]);
  }

  /** `whole` ends on a baked row, `uneven` half a row past one, `pose` has no duration at all. */
  function crowd(names = ['whole', 'uneven', 'pose']) {
    const durations: Record<string, number> = { whole: 1, uneven: 0.95, pose: 0 };
    const clips = names.map((name) => turn(name, durations[name]!));
    const { root } = buildRig();
    const animation = bakeAnimationTexture(root, clips, { fps: FPS });
    return { root, clips, animation, instances: new AnimatedInstances({ animation, count: 2 }) };
  }

  const entry = (instances: AnimatedInstances, i: number): number[] => {
    const clip = instances.clipAttribute;
    return [clip.getX(i), clip.getY(i), clip.getZ(i), clip.getW(i)];
  };

  /** The clip's last row plus one when it plays once (slot 10 of the clip buffer), 0 when it loops. */
  const onceOf = (instances: AnimatedInstances, i: number): number =>
    (instances.clipBuffer.array as Float32Array)[i * instances.clipBuffer.stride + 10]!;

  /**
   * The row the position node reads: `clipStart + floor(mod((time × speed + offset) × fps, loopRows))` for a looping
   * clip; for a clip played once, its first row before it starts, its last from its duration on, else `floor`.
   */
  function rowAt(instances: AnimatedInstances, i: number, seconds: number): number {
    const clip = instances.clipAttribute;
    const x = (seconds * clip.getW(i) + clip.getZ(i)) * FPS;
    const once = onceOf(instances, i);
    if (once > 0) return clip.getX(i) + (x >= clip.getY(i) ? once - 1 : Math.min(once - 1, Math.max(0, Math.floor(x))));
    return clip.getX(i) + Math.floor(x - clip.getY(i) * Math.floor(x / clip.getY(i)));
  }

  it('wraps at the clip duration in rows and leaves the baked rows as they were', () => {
    const { animation, instances } = crowd();
    expect(animation.clips.map((c) => [c.name, c.start, c.frames])).toEqual([
      ['whole', 0, 11],
      ['uneven', 11, 11],
      ['pose', 22, 1],
    ]);
    expect(animation.texture.image.height).toBe(23);
    // Every instance starts on the first clip.
    expect(entry(instances, 0)).toEqual([0, 10, 0, 1]);
    expect(entry(instances, 1)).toEqual([0, 10, 0, 1]);
    instances.setClipAt(1, 'uneven', { offset: 0.25, speed: 1.5 });
    expect(entry(instances, 1)).toEqual([11, 9.5, 0.25, 1.5]);
    expect(entry(instances, 0)).toEqual([0, 10, 0, 1]);
  });

  it('holds the single row of a clip without duration, as the default clip too', () => {
    const { instances } = crowd();
    instances.setClipAt(0, 'pose', { offset: 0.4, speed: 3 });
    expect(entry(instances, 0)).toEqual([22, 1, expect.closeTo(0.4, 6), 3]);
    for (const seconds of [0, 0.05, 1, 7.3, 1e4]) expect(rowAt(instances, 0, seconds)).toBe(22);
    const alone = crowd(['pose']).instances;
    expect(entry(alone, 0)).toEqual([0, 1, 0, 1]);
    expect(rowAt(alone, 0, 12.34)).toBe(0);
  });

  it.each([
    ['whole', {}],
    ['uneven', {}],
    ['uneven', { offset: 0.25, speed: 1.5 }],
    ['whole', { offset: 0.7, speed: 0.6 }],
  ])('reads the row a looping mixer is in through five loops of %s with %o', (name, options) => {
    const { root, clips, animation, instances } = crowd();
    instances.setClipAt(0, name, options);
    const range = animation.clips.find((c) => c.name === name)!;
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(clips.find((c) => c.name === name)!).play();
    const { offset = 0, speed = 1 } = options as { offset?: number; speed?: number };
    for (let seconds = 0.013; seconds < (5 * range.duration) / speed; seconds += 0.037) {
      mixer.setTime(seconds * speed + offset);
      const row = rowAt(instances, 0, seconds);
      expect(row, `${seconds.toFixed(3)} s`).toBe(range.start + Math.floor(action.time * FPS));
      expect(row).toBeLessThan(range.start + range.frames);
    }
  });

  it.each([
    ['whole', {}],
    ['uneven', {}],
    ['uneven', { offset: 0.25, speed: 1.5 }],
    ['whole', { offset: -0.4, speed: 0.6 }],
  ])('plays %s once with %o and holds the pose a clamped mixer ends on', (name, options) => {
    const { root, clips, animation, instances } = crowd();
    instances.setClipAt(0, name, { ...options, once: true });
    const range = animation.clips.find((c) => c.name === name)!;
    expect(onceOf(instances, 0)).toBe(range.frames);
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(clips.find((c) => c.name === name)!);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const { offset = 0, speed = 1 } = options as { offset?: number; speed?: number };
    for (let seconds = 0.013; seconds < 3; seconds += 0.037) {
      const clock = seconds * speed + offset;
      const row = rowAt(instances, 0, seconds);
      if (clock < 0) {
        expect(row, `${seconds.toFixed(3)} s, not started`).toBe(range.start);
        continue;
      }
      mixer.setTime(clock);
      // From its duration on the mixer holds the end pose, which the bake stores as the clip's last row.
      const expected =
        clock >= range.duration ? range.start + range.frames - 1 : range.start + Math.floor(action.time * FPS);
      expect(row, `${seconds.toFixed(3)} s`).toBe(expected);
    }
  });

  it('holds the one row of a clip without duration when played once', () => {
    const { instances } = crowd();
    instances.setClipAt(0, 'pose', { once: true, restart: true });
    for (const seconds of [-1, 0, 0.5, 100]) expect(rowAt(instances, 0, seconds)).toBe(22);
  });

  it('fades from a clip played once without looping it, and loops again after', () => {
    const { instances } = crowd();
    instances.setTime(1);
    // Faded into from the looping default clip, so the marker of the clip faded from is 0 until the next fade.
    instances.setClipAt(0, 'uneven', { once: true, restart: true, fade: 0.2 });
    expect((instances.clipBuffer.array as Float32Array)[11]).toBe(0);
    instances.setTime(3);
    instances.setClipAt(0, 'whole', { fade: 0.5 });
    const data = instances.clipBuffer.array as Float32Array;
    // The clip faded from keeps its once marker in slot 11; the new clip loops.
    expect([data[10], data[11]]).toEqual([0, 11]);
    expect(entry(instances, 0)).toEqual([0, 10, 0, 1]);
    instances.setClipAt(0, 'whole');
    expect([data[10], data[11]]).toEqual([0, 0]);
  });

  it('follows the clip an instance is switched to, and its own clock settings', () => {
    const { instances } = crowd();
    // At 2.33 s `whole` is 0.33 s into its third loop and `uneven` 0.43 s into its third; at 1.5 × with a 0.25 s
    // offset `uneven` is 0.895 s into its fourth.
    expect(rowAt(instances, 0, 2.33)).toBe(3);
    instances.setClipAt(0, 'uneven');
    expect(rowAt(instances, 0, 2.33)).toBe(11 + 4);
    instances.setClipAt(0, 'uneven', { offset: 0.25, speed: 1.5 });
    expect(rowAt(instances, 0, 2.33)).toBe(11 + 8);
    instances.setClipAt(0, 'whole');
    expect(entry(instances, 0)).toEqual([0, 10, 0, 1]);
    expect(rowAt(instances, 0, 2.33)).toBe(3);
    expect(instances.clipBuffer.version).toBe(3);
  });
});

describe('AnimatedInstances active count', () => {
  const instanceCounts = (instances: AnimatedInstances): number[] =>
    instances.meshes.map((m) => (m.geometry as InstancedBufferGeometry).instanceCount);

  it('draws all instances by default, then only the first activeCount', () => {
    const rig = buildTwoPartRig();
    const animation = bakeAnimationTexture(rig.root, [rig.clip], { fps: 10 });
    const instances = new AnimatedInstances({ animation, count: 4 });
    expect(instances.activeCount).toBe(4);
    instances.activeCount = 1;
    expect(instances.activeCount).toBe(1);
    expect(instanceCounts(instances)).toEqual([1, 1]);
    instances.activeCount = 0;
    expect(instanceCounts(instances)).toEqual([0, 0]);
    // The capacity is what was allocated; the marker the ledger reads for an InstancedMesh stays the capacity.
    expect(instances.count).toBe(4);
    expect(() => {
      instances.activeCount = 5;
    }).toThrow(/0\.\.4/);
    expect(() => {
      instances.activeCount = -1;
    }).toThrow(/0\.\.4/);
    expect(() => {
      instances.activeCount = 1.5;
    }).toThrow(/0\.\.4/);
  });

  it('removes an instance by moving the last active one into its slot', () => {
    const { instances } = setup(4);
    const clips = instances.clipBuffer.array as Float32Array;
    const stride = instances.clipBuffer.stride;
    const at = (i: number) => new Matrix4().makeTranslation(i, 0, 0);
    for (let i = 0; i < 4; i++) {
      instances.setMatrixAt(i, at(i));
      instances.setClipAt(i, 0, { offset: i / 10 });
    }
    instances.setTime(3);
    instances.setClipAt(3, 0, { offset: 0.9, fade: 0.25 });
    const last = Array.from(clips.subarray(3 * stride, 4 * stride));
    const version = instances.matrixBuffer.version;
    const clipVersion = instances.clipBuffer.version;
    expect(instances.removeAt(1)).toBe(3);
    expect(instances.activeCount).toBe(3);
    expectClose(instances.getMatrixAt(1, new Matrix4()), at(3), 'moved matrix');
    // Everything per instance moves with it: clip, the clip it fades from, and the fade.
    expect(Array.from(clips.subarray(stride, 2 * stride))).toEqual(last);
    expect(instances.matrixBuffer.version).toBeGreaterThan(version);
    expect(instances.clipBuffer.version).toBeGreaterThan(clipVersion);
    // Removing the last active instance moves nothing.
    expect(instances.removeAt(2)).toBe(-1);
    expect(instances.activeCount).toBe(2);
    expectClose(instances.getMatrixAt(0, new Matrix4()), at(0), 'untouched matrix');
    expect(() => instances.removeAt(2)).toThrow(/2/);
  });
});

describe('AnimatedInstances crossfade', () => {
  const FPS = 10;

  function crowd() {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1);
    const turn = (name: string, duration: number) =>
      new AnimationClip(name, duration, [
        new QuaternionKeyframeTrack('b.quaternion', [0, duration], [0, 0, 0, 1, q.x, q.y, q.z, q.w]),
      ]);
    const { root } = buildRig();
    const animation = bakeAnimationTexture(root, [turn('whole', 1), turn('uneven', 0.95)], { fps: FPS });
    return { animation, instances: new AnimatedInstances({ animation, count: 2 }) };
  }

  /** `[clip, from, fade]` of instance `i`: the clip, the clip it fades from, `[fadeStart, fadeSeconds]`. */
  function row(instances: AnimatedInstances, i: number): number[][] {
    const { array, stride } = instances.clipBuffer;
    const r = Array.from((array as Float32Array).subarray(i * stride, i * stride + 10));
    return [r.slice(0, 4), r.slice(4, 8), r.slice(8, 10)];
  }

  /** The weight of the current clip the position node uses: 1 without a fade, else linear over the fade. */
  function weightAt(instances: AnimatedInstances, i: number, seconds: number): number {
    const [start, length] = row(instances, i)[2]!;
    return length! > 0 ? Math.min(1, Math.max(0, (seconds - start!) / length!)) : 1;
  }

  it('keeps all per-instance clip data in one instanced interleaved buffer', () => {
    const { instances } = crowd();
    // WebGPU allows eight vertex buffers: the geometry's own, the character matrices and this one.
    expect(instances.clipBuffer).toBeInstanceOf(InstancedInterleavedBuffer);
    expect(instances.clipBuffer.meshPerAttribute).toBe(1);
    expect(instances.clipBuffer.stride).toBe(12);
    expect(instances.clipAttribute.data).toBe(instances.clipBuffer);
  });

  it('switches at once without a fade', () => {
    const { instances } = crowd();
    instances.setTime(2);
    instances.setClipAt(0, 'uneven');
    expect(row(instances, 0)).toEqual([
      [11, 9.5, 0, 1],
      [11, 9.5, 0, 1],
      [0, 0],
    ]);
    expect(weightAt(instances, 0, 2)).toBe(1);
  });

  it('fades from the clip it was showing over the given seconds from now', () => {
    const { instances } = crowd();
    instances.setClipAt(0, 'whole', { offset: 0.3, speed: 2 });
    instances.setTime(2);
    instances.setClipAt(0, 'uneven', { fade: 0.5 });
    expect(row(instances, 0)).toEqual([
      [11, 9.5, 0, 1],
      [0, 10, expect.closeTo(0.3, 6), 2],
      [2, 0.5],
    ]);
    expect(weightAt(instances, 0, 1.9)).toBe(0);
    expect(weightAt(instances, 0, 2)).toBe(0);
    expect(weightAt(instances, 0, 2.25)).toBeCloseTo(0.5, 6);
    expect(weightAt(instances, 0, 2.5)).toBe(1);
    expect(weightAt(instances, 0, 9)).toBe(1);
    // The other instance is untouched.
    expect(row(instances, 1)).toEqual([
      [0, 10, 0, 1],
      [0, 10, 0, 1],
      [0, 0],
    ]);
    // A second fade starts from the clip the first one went to.
    instances.setTime(3);
    instances.setClipAt(0, 'whole', { fade: 0.2 });
    expect(row(instances, 0)).toEqual([
      [0, 10, 0, 1],
      [11, 9.5, 0, 1],
      [3, expect.closeTo(0.2, 6)],
    ]);
  });

  it('restarts a clip at its first row at the current time', () => {
    const { instances } = crowd();
    instances.setTime(2.33);
    instances.setClipAt(0, 'whole', { restart: true, speed: 2 });
    const [start, loop, offset, speed] = row(instances, 0)[0]!;
    // The node's row at the current time: start + floor(mod((time × speed + offset) × fps, loop)).
    const x = (2.33 * speed! + offset!) * FPS;
    expect(start! + Math.floor(x - loop! * Math.floor(x / loop!))).toBe(0);
    instances.setClipAt(0, 'whole', { restart: true, offset: 0.25 });
    expect(row(instances, 0)[0]![2]).toBeCloseTo(-2.33 + 0.25, 5);
  });
});

describe('AnimatedInstances shading', () => {
  it('builds Lambert or unlit materials, copying only what they have', () => {
    const { mesh, animation } = setup();
    (mesh.material as { vertexColors: boolean }).vertexColors = true;
    const lambert = new AnimatedInstances({ animation, count: 1, shading: 'lambert' });
    const l = lambert.meshes[0]!.material as MeshLambertNodeMaterial;
    expect(l).toBeInstanceOf(MeshLambertNodeMaterial);
    expect(l.color.getHex()).toBe(0x336699);
    expect(l.vertexColors).toBe(true);
    expect(l.positionNode).not.toBeNull();
    expect('roughness' in l).toBe(false);
    const unlit = new AnimatedInstances({ animation, count: 1, shading: 'unlit' });
    const u = unlit.meshes[0]!.material as MeshBasicNodeMaterial;
    expect(u).toBeInstanceOf(MeshBasicNodeMaterial);
    expect(u.color.getHex()).toBe(0x336699);
    expect(u.vertexColors).toBe(true);
    expect(u.positionNode).not.toBeNull();
    expect('roughness' in u).toBe(false);
    const standard = new AnimatedInstances({ animation, count: 1 });
    expect(standard.meshes[0]!.material).toBeInstanceOf(MeshStandardNodeMaterial);
  });
});
