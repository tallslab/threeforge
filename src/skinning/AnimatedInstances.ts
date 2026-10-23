import {
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three';
import {
  attribute,
  clamp,
  Fn,
  float,
  floor,
  instancedDynamicBufferAttribute,
  int,
  ivec2,
  mat3,
  mat4,
  max,
  mod,
  normalGeometry,
  normalLocal,
  positionGeometry,
  select,
  texture,
  uniform,
  vec4,
} from 'three/tsl';
import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  type NodeMaterial,
} from 'three/webgpu';
import type { AnimationClipRange, AnimationTexture } from './bakeAnimationTexture.js';

export interface AnimatedInstancesOptions {
  animation: AnimationTexture;
  count: number;
  /** Overrides the parts' materials (colour, maps and flags are copied from it). */
  material?: Material;
  /**
   * The lighting model of the built materials: `standard` (the default, three's PBR), `lambert` (diffuse only) or
   * `unlit` (colour and vertex colours as they are). Only the properties the chosen material has are copied.
   */
  shading?: 'standard' | 'lambert' | 'unlit';
}

export interface ClipOptions {
  /** Seconds added to the shared time for this instance (desynchronises a crowd). */
  offset?: number;
  /** Playback rate; 1 = the clip's own speed. */
  speed?: number;
  /** Starts the clip at its first row at the current time; `offset` is then added to that. */
  restart?: boolean;
  /**
   * Plays the clip once and holds its end pose, as a mixer action with `LoopOnce` and `clampWhenFinished`; before the
   * clip's start (an offset that puts it in the future) it holds the first row. Usually set with `restart`.
   */
  once?: boolean;
  /**
   * Seconds over which the instance blends from the clip it was showing to this one, starting at the current time.
   * The clip it fades from keeps playing on its own clock meanwhile. 0 (the default) switches at once.
   */
  fade?: number;
}

const MATERIALS = {
  standard: MeshStandardNodeMaterial,
  lambert: MeshLambertNodeMaterial,
  unlit: MeshBasicNodeMaterial,
} as const;

/**
 * Floats per instance in the clip buffer: `[start, loopRows, offset, speed]` of the clip, the same for the clip it
 * fades from, `[fadeStart, fadeSeconds]`, then for the clip and the clip it fades from the last row plus one when it
 * plays once, 0 when it loops.
 */
const CLIP_STRIDE = 12;

const COPIED = [
  'color',
  'map',
  'roughness',
  'metalness',
  'roughnessMap',
  'metalnessMap',
  'normalMap',
  'normalScale',
  'emissive',
  'emissiveMap',
  'emissiveIntensity',
  'aoMap',
  'aoMapIntensity',
  'alphaMap',
  'alphaTest',
  'transparent',
  'opacity',
  'side',
  'vertexColors',
  'envMapIntensity',
  'flatShading',
] as const;

const _matrix = new Matrix4();

/**
 * Where a clip's row counter wraps: its duration in rows, which is where a looping mixer wraps. The clip's stored rows
 * (`frames`) run past it to the clamped end pose, by two rows when `duration × fps` rounds just above a whole number,
 * and a counter wrapped at their count holds that pose and falls behind on every loop. A clip without duration has
 * one row and holds it.
 */
function loopRows(range: AnimationClipRange | undefined, fps: number): number {
  return range && range.duration > 0 ? range.duration * fps : 1;
}

/** three's TSL typings are loose (nodes come back as `Node<string>` without swizzles): the builder chains on `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * Any number of characters built from one animated prototype as one instanced draw per part. Each instance picks a
 * clip, a time offset and a speed; a shared `time` uniform advances them all. The vertex stage fetches the four
 * bone matrices of the instance's current frame from the animation texture and skins the part exactly as three
 * does, then applies the part's offset from the character root (`animation.parts[k].matrix`, a uniform of that part's
 * material) and the instance's character matrix.
 */
export class AnimatedInstances {
  readonly animation: AnimationTexture;
  /** How many instances the buffers hold. `activeCount` says how many of them are drawn. */
  readonly count: number;
  readonly meshes: Mesh[];
  /**
   * Per-instance `[clipStart, loopRows, timeOffset, speed]`: the clip's first texture row, the length its row counter
   * wraps at (`duration × fps`, rarely a whole number; 1 for a clip without duration), seconds added to the shared
   * time, and the playback rate. The clip's stored row count stays in `animation.clips[i].frames`.
   */
  readonly clipAttribute: InterleavedBufferAttribute;
  /**
   * Everything per instance about playback, `CLIP_STRIDE` floats each: the clip (`clipAttribute`), the clip it fades
   * from in the same layout, then `[fadeStart, fadeSeconds, clipOnce, fromOnce]`, where a once value is the clip's last
   * row plus one for a clip played once and 0 for one that loops. One buffer, so a fade costs no extra vertex buffer.
   */
  readonly clipBuffer: InstancedInterleavedBuffer;
  /**
   * Per-instance character matrices, 16 floats each, shared by every part (each part adds its own offset), as one
   * interleaved buffer (four separate attributes would exceed WebGPU's eight vertex buffers). It must be the instanced
   * kind: both backends derive the per-instance step from `isInstancedInterleavedBuffer`, and a plain
   * `InterleavedBuffer` is read per vertex.
   */
  readonly matrixBuffer: InstancedInterleavedBuffer;
  private readonly timeUniform: { value: number };
  /**
   * Per part: its geometry, its material, and the `mat4` uniform holding the part's offset from the character root
   * (`animation.parts[k].matrix`).
   * @internal `offset` is reachable only through a cast and is exposed in this shape mainly for the tests that
   * assert the transform a part is drawn at.
   */
  private readonly parts: Array<{
    geometry: InstancedBufferGeometry;
    material: NodeMaterial;
    offset: { value: Matrix4 };
  }> = [];
  private seconds = 0;
  private active: number;

  constructor(options: AnimatedInstancesOptions) {
    this.animation = options.animation;
    this.count = options.count;
    this.active = options.count;
    const { animation, count } = this;
    this.clipBuffer = new InstancedInterleavedBuffer(new Float32Array(count * CLIP_STRIDE), CLIP_STRIDE, 1);
    this.clipBuffer.setUsage(DynamicDrawUsage);
    this.clipAttribute = new InterleavedBufferAttribute(this.clipBuffer, 4, 0);
    this.matrixBuffer = new InstancedInterleavedBuffer(new Float32Array(count * 16), 16, 1);
    this.matrixBuffer.setUsage(DynamicDrawUsage);
    const clips = this.clipBuffer.array as Float32Array;
    const first = [animation.clips[0]?.start ?? 0, loopRows(animation.clips[0], animation.fps), 0, 1];
    for (let i = 0; i < count; i++) {
      _matrix.identity().toArray(this.matrixBuffer.array as Float32Array, i * 16);
      clips.set(first, i * CLIP_STRIDE);
      clips.set(first, i * CLIP_STRIDE + 4);
    }
    const timeNode: N = uniform(0);
    this.timeUniform = timeNode as { value: number };
    const animationTexture: N = texture(animation.texture);
    const clip: N = instancedDynamicBufferAttribute(this.clipBuffer, 'vec4', CLIP_STRIDE, 0);
    const from: N = instancedDynamicBufferAttribute(this.clipBuffer, 'vec4', CLIP_STRIDE, 4);
    const fade: N = instancedDynamicBufferAttribute(this.clipBuffer, 'vec4', CLIP_STRIDE, 8);
    const instanceMatrix: N = mat4(
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 0),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 4),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 8),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 12),
    );
    const fps: N = float(animation.fps);
    const time: N = timeNode;
    this.meshes = animation.parts.map((part) => {
      const shape = part.mesh.geometry;
      const geometry = new InstancedBufferGeometry();
      for (const name of Object.keys(shape.attributes)) geometry.setAttribute(name, shape.getAttribute(name));
      if (shape.index) geometry.setIndex(shape.index);
      geometry.instanceCount = count;
      geometry.boundingSphere = shape.boundingSphere;
      geometry.boundingBox = shape.boundingBox;
      const material: NodeMaterial = new MATERIALS[options.shading ?? 'standard']();
      const source = (options.material ??
        (Array.isArray(part.mesh.material) ? part.mesh.material[0]! : part.mesh.material)) as Material &
        Record<string, unknown>;
      const target = material as unknown as Record<string, unknown>;
      for (const key of COPIED) {
        if (!(key in target)) continue;
        const value = source[key];
        if (value === undefined || value === null) continue;
        const own = target[key] as { copy?: (v: unknown) => unknown } | undefined;
        if (own && typeof own === 'object' && typeof own.copy === 'function') own.copy(value);
        else target[key] = value;
      }
      const bind: N = uniform(part.mesh.bindMatrix);
      const bindInverse: N = uniform(part.mesh.bindMatrixInverse);
      // The part's own offset from the character root: the parts share the instance matrices, so it cannot live there.
      const offset: N = uniform(part.matrix);
      const skinIndex: N = attribute('skinIndex', 'uvec4');
      const skinWeight: N = attribute('skinWeight', 'vec4');
      // Row of this instance: the clip's start row plus the row counter, wrapped at the clip's duration. `mod` is
      // `x - y × floor(x / y)` in float32, and just below a multiple of y the quotient can round up to the whole
      // number, which leaves the remainder a hair below zero and the row the one before the clip's first. Correctly
      // rounded float32 does that only for a y that does not multiply exactly (8.33 rows); neither shading language
      // requires correctly rounded division, and through WebGPU on an Apple M1 it was measured for whole y (22, 12)
      // too. The quotient is never off by more than one, so one period back is the clip's last row.
      // A clip played once (`once` its last row plus one) holds its first row before it starts and its last from its
      // duration on, which the bake stores as the clamped end pose.
      const rowOf = (c: N, once: N): N => {
        const clock: N = time.mul(c.w).add(c.z).mul(fps);
        const position: N = mod(clock, c.y);
        const looped: N = floor(select(position.lessThan(0), position.add(c.y), position));
        const last: N = once.sub(1);
        const held: N = select(clock.greaterThanEqual(c.y), last, clamp(floor(clock), 0, last));
        return int(c.x.add(select(once.greaterThan(0), held, looped)));
      };
      const row: N = rowOf(clip, fade.z);
      const fromRow: N = rowOf(from, fade.w);
      // The current clip's share: linear over the fade, 1 once it is over or when there is none (fadeSeconds 0).
      const weight: N = select(fade.y.greaterThan(0), clamp(time.sub(fade.x).div(max(fade.y, 1e-6)), 0, 1), 1);
      const boneOffset: N = int(part.boneOffset);
      const load = (x: N, r: N): N =>
        mat4(
          animationTexture.load(ivec2(x, r)),
          animationTexture.load(ivec2(x.add(1), r)),
          animationTexture.load(ivec2(x.add(2), r)),
          animationTexture.load(ivec2(x.add(3), r)),
        );
      // Both clips' skinning matrices blended linearly, as vertex-animation crossfades do; outside a fade the weight
      // is 1 and the first clip's matrix drops out. Written out because neither WGSL nor GLSL has `mix` for matrices.
      const bone = (index: N): N => {
        const x: N = int(index).add(boneOffset).mul(4);
        return load(x, fromRow).mul(float(1).sub(weight)).add(load(x, row).mul(weight));
      };
      material.positionNode = Fn(() => {
        const skin: N = bindInverse
          .mul(
            bone(skinIndex.x)
              .mul(skinWeight.x)
              .add(bone(skinIndex.y).mul(skinWeight.y))
              .add(bone(skinIndex.z).mul(skinWeight.z))
              .add(bone(skinIndex.w).mul(skinWeight.w)),
          )
          .mul(bind);
        // The character's matrix, then this part's offset from the character root.
        const model: N = instanceMatrix.mul(offset);
        normalLocal.assign(mat3(model).mul(mat3(skin).mul(normalGeometry)));
        return model.mul(skin.mul(vec4(positionGeometry, 1))).xyz;
      })();
      // The animation texture is sampled through a node, invisible to material properties: list it for collectResources.
      material.userData.forgeTextures = [animation.texture];
      const mesh = new Mesh(geometry, material);
      mesh.name = `forge:vat:${part.mesh.name || 'part'}`;
      mesh.frustumCulled = false;
      mesh.castShadow = part.mesh.castShadow;
      mesh.receiveShadow = part.mesh.receiveShadow;
      mesh.userData.forge = { kind: 'vat', instances: count };
      this.parts.push({ geometry, material, offset: offset as { value: Matrix4 } });
      return mesh;
    });
  }

  get time(): number {
    return this.seconds;
  }

  /**
   * Places instance `i` by the character's matrix. Every part reads it and applies its own offset from the root in
   * its vertex stage, so part `k` draws at `matrix × animation.parts[k].matrix`.
   */
  setMatrixAt(i: number, matrix: Matrix4): void {
    matrix.toArray(this.matrixBuffer.array as Float32Array, i * 16);
    this.matrixBuffer.needsUpdate = true;
  }

  /** The character matrix instance `i` was placed with (no part offset in it). */
  getMatrixAt(i: number, target: Matrix4): Matrix4 {
    return target.fromArray(this.matrixBuffer.array as Float32Array, i * 16);
  }

  /** How many instances are drawn: the first `activeCount` of `count`. */
  get activeCount(): number {
    return this.active;
  }

  set activeCount(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > this.count)
      throw new RangeError(`AnimatedInstances: activeCount ${n} outside 0..${this.count}`);
    this.active = n;
    for (const { geometry } of this.parts) geometry.instanceCount = n;
  }

  /**
   * Stops drawing instance `i` by moving the last active instance (matrix, clip, fade) into its slot. Returns the
   * index that moved into `i`, or -1 when `i` was the last active one, so the caller can update its handles.
   */
  removeAt(i: number): number {
    const last = this.active - 1;
    if (!Number.isInteger(i) || i < 0 || i > last)
      throw new RangeError(`AnimatedInstances: removeAt(${i}) outside the ${this.active} active instances`);
    if (i !== last) {
      const matrices = this.matrixBuffer.array as Float32Array;
      matrices.copyWithin(i * 16, last * 16, last * 16 + 16);
      const data = this.clipBuffer.array as Float32Array;
      data.copyWithin(i * CLIP_STRIDE, last * CLIP_STRIDE, last * CLIP_STRIDE + CLIP_STRIDE);
      this.matrixBuffer.needsUpdate = true;
      this.clipBuffer.needsUpdate = true;
    }
    this.activeCount = last;
    return i === last ? -1 : last;
  }

  /**
   * Assigns a clip (by index or name) to instance `i`, with a time offset in seconds and a playback speed, and
   * optionally restarted or faded into from the clip the instance was showing.
   */
  setClipAt(i: number, clip: number | string, options: ClipOptions = {}): void {
    const clips = this.animation.clips;
    const index = typeof clip === 'number' ? clip : clips.findIndex((c) => c.name === clip);
    const range = clips[index];
    if (!range)
      throw new Error(
        `AnimatedInstances: unknown clip ${JSON.stringify(clip)}; known: ${clips.map((c) => c.name).join(', ')}`,
      );
    const loop = loopRows(range, this.animation.fps);
    const speed = options.speed ?? 1;
    const offset = (options.offset ?? 0) - (options.restart ? this.seconds * speed : 0);
    const fade = options.fade ?? 0;
    const data = this.clipBuffer.array as Float32Array;
    const o = i * CLIP_STRIDE;
    // A fade starts from the clip as it was set, even mid-fade: the blend in progress is dropped.
    if (fade > 0) {
      data.copyWithin(o + 4, o, o + 4);
      data[o + 11] = data[o + 10]!;
    }
    data[o] = range.start;
    data[o + 1] = loop;
    data[o + 2] = offset;
    data[o + 3] = speed;
    data[o + 10] = options.once ? range.frames : 0;
    if (fade <= 0) {
      data.copyWithin(o + 4, o, o + 4);
      data[o + 11] = data[o + 10]!;
    }
    data[o + 8] = fade > 0 ? this.seconds : 0;
    data[o + 9] = Math.max(fade, 0);
    this.clipBuffer.needsUpdate = true;
  }

  /** The shared clock every instance reads (seconds). */
  setTime(seconds: number): void {
    this.seconds = seconds;
    this.timeUniform.value = seconds;
  }

  addTo(parent: Object3D): this {
    for (const mesh of this.meshes) parent.add(mesh);
    return this;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.removeFromParent();
    for (const { geometry, material } of this.parts) {
      geometry.dispose();
      material.dispose();
    }
  }
}
