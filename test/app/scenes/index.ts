/**
 * The benchmark suite: eight scenes, each a naive assembly plus what the optimized variant needs beyond the
 * World defaults. The harness builds a scene through `BENCH_SCENES[id]`, then for `variant=optimized` runs
 * `prepare` (before compile), `world.compile()`, `after` (after compile) and `world.warmup()`.
 */
import type { AnimationClip, Object3D, PerspectiveCamera, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { WebGPURenderer } from 'three/webgpu';
import type { Tier, World, WorldOptions } from 'threeforge';
import { bossfight } from './bossfight.js';
import { crowd } from './crowd.js';
import { daynight } from './daynight.js';
import { forest } from './forest.js';
import { lake } from './lake.js';
import { rpg } from './rpg.js';
import { zen } from './zen.js';
import { village } from './village.js';

export interface BenchContext {
  renderer: WebGPURenderer;
  camera: PerspectiveCamera;
  params: URLSearchParams;
  loader(): Promise<GLTFLoader>;
  /** Resolves a path under the served asset root (test/assets/files, or the bench page's public dir). */
  url(path: string): string;
  /** The detected (or forced) device tier: optimized variants size shadows and particles for it. */
  tier: Tier;
}

export interface BenchScene {
  scene: Scene;
  /** Whole numbers the spec promises (props, trees, characters...). */
  counts: Record<string, number>;
  /** World options the optimized variant needs beyond the defaults. */
  worldOptions?: Partial<WorldOptions>;
  /** Runs before `world.compile()` for the optimized variant (LOD generation, for example). */
  prepare?(scene: Scene): Promise<void> | void;
  /** Runs after `world.compile()` for the optimized variant. */
  after?(world: World): Promise<void> | void;
  /** Advance deterministic time in seconds (animations, particles, gear swaps). */
  setTime?(t: number): void;
  animations?: Array<AnimationClip | { root: Object3D; clips: AnimationClip[] }>;
  /** Portrait 9:16 canvas (mobile RPG). */
  portrait?: boolean;
}

export type BenchBuilder = (ctx: BenchContext) => Promise<BenchScene>;

export const BENCH_SCENES: Record<string, BenchBuilder> = { village, forest, crowd, bossfight, lake, daynight, zen, rpg };
