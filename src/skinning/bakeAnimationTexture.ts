import { AnimationMixer, DataTexture, FloatType, LoopOnce, Matrix4, NearestFilter, Quaternion, RGBAFormat, Vector3, type AnimationClip, type Object3D, type Skeleton, type SkinnedMesh } from 'three';

export interface AnimationClipRange {
  name: string;
  /** First texture row of this clip. */
  start: number;
  /** Rows (frames) of this clip: `ceil(duration × fps) + 1`. */
  frames: number;
  duration: number;
}

export interface AnimationPart {
  mesh: SkinnedMesh;
  /** The part's transform relative to the prototype root. */
  matrix: Matrix4;
}

/** Bone matrices of every clip frame in one float texture: row per frame, four RGBA texels per bone (its matrix columns). */
export interface AnimationTexture {
  texture: DataTexture;
  fps: number;
  bones: number;
  clips: AnimationClipRange[];
  parts: AnimationPart[];
  skeleton: Skeleton;
}

export interface BakeAnimationOptions {
  /** Frames per second baked (default 30). */
  fps?: number;
}

const _position = new Vector3();
const _quaternion = new Quaternion();
const _scale = new Vector3();

/**
 * Plays every clip on the prototype (moved to the origin for the duration), and copies `skeleton.boneMatrices`
 * (`bone.matrixWorld × boneInverse`, what three uploads as its bone texture) into one texture row per frame.
 * `AnimatedInstances` reads those rows per instance. The prototype's transform and pose are restored.
 */
export function bakeAnimationTexture(prototype: Object3D, clips: AnimationClip[], options: BakeAnimationOptions = {}): AnimationTexture {
  const fps = options.fps ?? 30;
  const parts: SkinnedMesh[] = [];
  prototype.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) parts.push(o as SkinnedMesh);
  });
  if (parts.length === 0) throw new Error('bakeAnimationTexture: the prototype has no SkinnedMesh');
  const skeleton = parts[0]!.skeleton;
  const bones = skeleton.bones.length;
  const width = bones * 4;
  const ranges: AnimationClipRange[] = [];
  let height = 0;
  for (const clip of clips) {
    const frames = Math.ceil(clip.duration * fps) + 1;
    ranges.push({ name: clip.name, start: height, frames, duration: clip.duration });
    height += frames;
  }
  const data = new Float32Array(width * height * 4);

  _position.copy(prototype.position);
  _quaternion.copy(prototype.quaternion);
  _scale.copy(prototype.scale);
  prototype.position.set(0, 0, 0);
  prototype.quaternion.identity();
  prototype.scale.set(1, 1, 1);
  prototype.updateMatrixWorld(true);
  const partMatrices = parts.map((p) => p.matrixWorld.clone());

  const mixer = new AnimationMixer(prototype);
  for (let c = 0; c < clips.length; c++) {
    const clip = clips[c]!;
    const range = ranges[c]!;
    const action = mixer.clipAction(clip);
    // Play once and hold the last pose: a looping action wraps t = duration back to frame 0.
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    for (let f = 0; f < range.frames; f++) {
      mixer.setTime(Math.min(clip.duration, f / fps));
      prototype.updateMatrixWorld(true);
      skeleton.update();
      data.set(skeleton.boneMatrices!.subarray(0, bones * 16), (range.start + f) * width * 4);
    }
    action.stop();
    mixer.uncacheClip(clip);
  }
  mixer.stopAllAction();

  prototype.position.copy(_position);
  prototype.quaternion.copy(_quaternion);
  prototype.scale.copy(_scale);
  prototype.updateMatrixWorld(true);
  skeleton.update();

  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.name = `forge:animation:${prototype.name || 'prototype'}`;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, fps, bones, clips: ranges, parts: parts.map((mesh, i) => ({ mesh, matrix: partMatrices[i]! })), skeleton };
}
