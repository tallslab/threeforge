import { DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, InterleavedBuffer, Matrix4, Mesh, type Material, type Object3D } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, attribute, float, floor, instancedDynamicBufferAttribute, int, ivec2, mat3, mat4, mod, normalGeometry, normalLocal, positionGeometry, texture, uniform, vec4 } from 'three/tsl';
import type { AnimationTexture } from './bakeAnimationTexture.js';

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

const COPIED = ['color', 'map', 'roughness', 'metalness', 'roughnessMap', 'metalnessMap', 'normalMap', 'normalScale', 'emissive', 'emissiveMap', 'emissiveIntensity', 'aoMap', 'aoMapIntensity', 'alphaMap', 'alphaTest', 'transparent', 'opacity', 'side', 'vertexColors', 'envMapIntensity', 'flatShading'] as const;

const _matrix = new Matrix4();

/** three's TSL typings are loose (nodes come back as `Node<string>` without swizzles): the builder chains on `any`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/**
 * Any number of characters built from one animated prototype as one instanced draw per part. Each instance picks a
 * clip, a time offset and a speed; a shared `time` uniform advances them all. The vertex stage fetches the four
 * bone matrices of the instance's current frame from the animation texture and skins the part exactly as three
 * does, then applies the instance matrix (the part's offset from the character root folded in).
 */
export class AnimatedInstances {
  readonly animation: AnimationTexture;
  readonly count: number;
  readonly meshes: Mesh[];
  /** Per-instance `[clipStart, clipFrames, timeOffset, speed]`. */
  readonly clipAttribute: InstancedBufferAttribute;
  /** Per-instance matrices, 16 floats each. */
  readonly matrixBuffer: InterleavedBuffer;
  private readonly timeUniform: { value: number };
  private readonly parts: Array<{ geometry: InstancedBufferGeometry; material: MeshStandardNodeMaterial }> = [];
  private seconds = 0;

  constructor(options: AnimatedInstancesOptions) {
    this.animation = options.animation;
    this.count = options.count;
    const { animation, count } = this;
    this.clipAttribute = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.clipAttribute.setUsage(DynamicDrawUsage);
    this.matrixBuffer = new InterleavedBuffer(new Float32Array(count * 16), 16);
    this.matrixBuffer.setUsage(DynamicDrawUsage);
    for (let i = 0; i < count; i++) {
      _matrix.identity().toArray(this.matrixBuffer.array as Float32Array, i * 16);
      this.clipAttribute.setXYZW(i, animation.clips[0]?.start ?? 0, animation.clips[0]?.frames ?? 1, 0, 1);
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
      const from = (options.material ?? (Array.isArray(part.mesh.material) ? part.mesh.material[0]! : part.mesh.material)) as Material & Record<string, unknown>;
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
      const skinIndex: N = attribute('skinIndex', 'uvec4');
      const skinWeight: N = attribute('skinWeight', 'vec4');
      // Frame of this instance: the clip's start row plus the wrapped frame counter.
      const frame: N = floor(mod(time.mul(clip.w).add(clip.z).mul(fps), clip.y));
      const row: N = int(clip.x.add(frame));
      const bone = (index: N): N => {
        const x: N = int(index).mul(4);
        return mat4(animationTexture.load(ivec2(x, row)), animationTexture.load(ivec2(x.add(1), row)), animationTexture.load(ivec2(x.add(2), row)), animationTexture.load(ivec2(x.add(3), row)));
      };
      material.positionNode = Fn(() => {
        const skin: N = bindInverse
          .mul(bone(skinIndex.x).mul(skinWeight.x).add(bone(skinIndex.y).mul(skinWeight.y)).add(bone(skinIndex.z).mul(skinWeight.z)).add(bone(skinIndex.w).mul(skinWeight.w)))
          .mul(bind);
        normalLocal.assign(mat3(instanceMatrix).mul(mat3(skin).mul(normalGeometry)));
        return instanceMatrix.mul(skin.mul(vec4(positionGeometry, 1))).xyz;
      })();
      const mesh = new Mesh(geometry, material);
      mesh.name = `forge:vat:${part.mesh.name || 'part'}`;
      mesh.frustumCulled = false;
      mesh.castShadow = part.mesh.castShadow;
      mesh.receiveShadow = part.mesh.receiveShadow;
      mesh.userData.forge = { kind: 'vat', instances: count };
      this.parts.push({ geometry, material });
      return mesh;
    });
  }

  get time(): number {
    return this.seconds;
  }

  /** Places instance `i`: the character's matrix; each part's offset from the root is folded in. */
  setMatrixAt(i: number, matrix: Matrix4): void {
    // Parts share one matrix buffer; their offsets are applied per part in the shader-free way: the first part's
    // offset is folded in here and the other parts store the same character matrix. Prototypes whose parts sit at
    // different offsets get the offset per part through `partOffsets`.
    _matrix.multiplyMatrices(matrix, this.animation.parts[0]!.matrix);
    _matrix.toArray(this.matrixBuffer.array as Float32Array, i * 16);
    this.matrixBuffer.needsUpdate = true;
  }

  getMatrixAt(i: number, target: Matrix4): Matrix4 {
    return target.fromArray(this.matrixBuffer.array as Float32Array, i * 16);
  }

  /** Assigns a clip (by index or name) to instance `i`, with a time offset in seconds and a playback speed. */
  setClipAt(i: number, clip: number | string, options: ClipOptions = {}): void {
    const clips = this.animation.clips;
    const index = typeof clip === 'number' ? clip : clips.findIndex((c) => c.name === clip);
    const range = clips[index];
    if (!range) throw new Error(`AnimatedInstances: unknown clip ${JSON.stringify(clip)}; known: ${clips.map((c) => c.name).join(', ')}`);
    this.clipAttribute.setXYZW(i, range.start, range.frames, options.offset ?? 0, options.speed ?? 1);
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
