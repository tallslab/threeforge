import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three';
import {
  attribute,
  Fn,
  float,
  floor,
  instancedDynamicBufferAttribute,
  int,
  ivec2,
  mat3,
  mat4,
  mod,
  normalGeometry,
  normalLocal,
  positionGeometry,
  select,
  texture,
  uniform,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { AnimationClipRange, AnimationTexture } from './bakeAnimationTexture.js';

export interface AnimatedInstancesOptions {
  animation: AnimationTexture;
  count: number;
  /** Overrides the parts' materials (colour, maps and flags are copied from it). */
  material?: Material;
}

export interface ClipOptions {
  /** Seconds added to the shared time for this instance (desynchronises a crowd). */
  offset?: number;
  /** Playback rate; 1 = the clip's own speed. */
  speed?: number;
}

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
  readonly count: number;
  readonly meshes: Mesh[];
  /**
   * Per-instance `[clipStart, loopRows, timeOffset, speed]`: the clip's first texture row, the length its row counter
   * wraps at (`duration × fps`, rarely a whole number; 1 for a clip without duration), seconds added to the shared
   * time, and the playback rate. The clip's stored row count stays in `animation.clips[i].frames`.
   */
  readonly clipAttribute: InstancedBufferAttribute;
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
    material: MeshStandardNodeMaterial;
    offset: { value: Matrix4 };
  }> = [];
  private seconds = 0;

  constructor(options: AnimatedInstancesOptions) {
    this.animation = options.animation;
    this.count = options.count;
    const { animation, count } = this;
    this.clipAttribute = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.clipAttribute.setUsage(DynamicDrawUsage);
    this.matrixBuffer = new InstancedInterleavedBuffer(new Float32Array(count * 16), 16, 1);
    this.matrixBuffer.setUsage(DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      _matrix.identity().toArray(this.matrixBuffer.array as Float32Array, i * 16);
      this.clipAttribute.setXYZW(i, animation.clips[0]?.start ?? 0, loopRows(animation.clips[0], animation.fps), 0, 1);
    }
    const timeNode: N = uniform(0);
    this.timeUniform = timeNode as { value: number };
    const animationTexture: N = texture(animation.texture);
    const clip: N = instancedDynamicBufferAttribute(this.clipAttribute, 'vec4');
    const instanceMatrix: N = mat4(
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 0),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 4),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 8),
      instancedDynamicBufferAttribute(this.matrixBuffer, 'vec4', 16, 12),
    );
    const fps: N = float(animation.fps);
    const time: N = timeNode;
    this.meshes = animation.parts.map((part) => {
      const source = part.mesh.geometry;
      const geometry = new InstancedBufferGeometry();
      for (const name of Object.keys(source.attributes)) geometry.setAttribute(name, source.getAttribute(name));
      if (source.index) geometry.setIndex(source.index);
      geometry.instanceCount = count;
      geometry.boundingSphere = source.boundingSphere;
      geometry.boundingBox = source.boundingBox;
      const material = new MeshStandardNodeMaterial();
      const from = (options.material ??
        (Array.isArray(part.mesh.material) ? part.mesh.material[0]! : part.mesh.material)) as Material &
        Record<string, unknown>;
      const target = material as unknown as Record<string, unknown>;
      for (const key of COPIED) {
        const value = from[key];
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
      const position: N = mod(time.mul(clip.w).add(clip.z).mul(fps), clip.y);
      const frame: N = floor(select(position.lessThan(0), position.add(clip.y), position));
      const row: N = int(clip.x.add(frame));
      const boneOffset: N = int(part.boneOffset);
      const bone = (index: N): N => {
        const x: N = int(index).add(boneOffset).mul(4);
        return mat4(
          animationTexture.load(ivec2(x, row)),
          animationTexture.load(ivec2(x.add(1), row)),
          animationTexture.load(ivec2(x.add(2), row)),
          animationTexture.load(ivec2(x.add(3), row)),
        );
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

  /** Assigns a clip (by index or name) to instance `i`, with a time offset in seconds and a playback speed. */
  setClipAt(i: number, clip: number | string, options: ClipOptions = {}): void {
    const clips = this.animation.clips;
    const index = typeof clip === 'number' ? clip : clips.findIndex((c) => c.name === clip);
    const range = clips[index];
    if (!range)
      throw new Error(
        `AnimatedInstances: unknown clip ${JSON.stringify(clip)}; known: ${clips.map((c) => c.name).join(', ')}`,
      );
    const loop = loopRows(range, this.animation.fps);
    this.clipAttribute.setXYZW(i, range.start, loop, options.offset ?? 0, options.speed ?? 1);
    this.clipAttribute.needsUpdate = true;
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
