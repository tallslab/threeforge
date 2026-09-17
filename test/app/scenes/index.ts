/**
 * Every scene the harness page can show. `BENCH_SCENES` is the benchmark suite: eight scenes, each a naive assembly
 * plus what the optimized variant needs beyond the World defaults (the harness runs `prepare` before
 * `world.compile()`, `after` after it, then `world.warmup()`). `HARNESS_SCENES` are the test scenes the e2e specs
 * open directly; they fill the optional `naive`, `arena`... facts that `window.__forge` exposes.
 */
import type { AnimationClip, Object3D, PerspectiveCamera, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { WebGPURenderer } from 'three/webgpu';
import type { AnimatedInstances, AssembledCharacter, Streamer, Tier, World, WorldOptions } from 'threeforge';
import type { CharacterParts } from '../../scenes/character.js';
import type { FieldScene } from '../../scenes/field.js';
import type { NaiveScene } from '../../scenes/naive.js';
import { type Arena, arenaScene } from '../arena.js';
import { type Biome, biomeScene } from '../biome.js';
import { bossfight } from './bossfight.js';
import { characterScene } from './character.js';
import { crowd } from './crowd.js';
import { daynight } from './daynight.js';
import { emptyScene } from './empty.js';
import { fieldScene } from './field.js';
import { forest } from './forest.js';
import { type GltfInfo, gltfScene } from './gltf.js';
import { lake } from './lake.js';
import { naiveScene } from './naive.js';
import { rpg } from './rpg.js';
import { vatScene } from './vat.js';
import { village } from './village.js';
import { zen } from './zen.js';

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
  /** Set by `after` when the optimized variant streams chunks; the harness attaches it to the ledger. */
  streamer?: Streamer;
  /** The World policy when `?policy` is absent (default `tagged`; glTF content is untagged, so `auto`). */
  policy?: 'auto' | 'tagged';
  /** Per-frame update under `?animate=1`. */
  animate?(): void;
  /** What the e2e specs read through `window.__forge` for the harness scenes. */
  naive?: NaiveScene;
  field?: FieldScene;
  character?: CharacterParts;
  assembled?: AssembledCharacter;
  gltf?: GltfInfo;
  biome?: Biome;
  arena?: Arena;
  vat?: AnimatedInstances;
}

export type BenchBuilder = (ctx: BenchContext) => Promise<BenchScene>;

export const BENCH_SCENES: Record<string, BenchBuilder> = {
  village,
  forest,
  crowd,
  bossfight,
  lake,
  daynight,
  zen,
  rpg,
};

export const HARNESS_SCENES: Record<string, BenchBuilder> = {
  arena: arenaScene,
  biome: biomeScene,
  gltf: gltfScene,
  vat: vatScene,
  character: characterScene,
  field: fieldScene,
  empty: emptyScene,
  naive: naiveScene,
};

export const SCENES: Record<string, BenchBuilder> = { ...BENCH_SCENES, ...HARNESS_SCENES };
