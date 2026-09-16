import type { CompileReport } from '../compiler/World.js';
import type { FrameEnv, FrameSnapshot, Hint, Tier } from '../ledger/snapshot.js';

export type Backend = 'webgl2' | 'webgpu';
export type TierChoice = Tier | 'auto';

export type BakeChoice = 'off' | 'on' | 'buried';

export interface AnalyzeInput {
  file: string;
  backend: Backend;
  tier: TierChoice;
  budget: number | null;
  frames: number;
  compile: boolean;
  /** Bake finished groups (`on`), also removing buried faces (`buried`), or batch only (`off`). */
  bake: BakeChoice;
  /** Extra orbit views for pixel parity on top of the default framing (0 = default framing only). */
  views: number;
  timeout: number;
  headed: boolean;
}

export interface InspectInput {
  url: string;
  backend: Backend;
  tier: TierChoice;
  budget: number | null;
  frames: number;
  compile: boolean;
  timeout: number;
  headed: boolean;
}

export interface AssetFacts {
  meshes: number;
  materials: number;
  vertices: number;
  triangles: number;
  animations: number;
  skinned: number;
  morph: number;
  loadMs: number;
}

export interface Parity {
  /** Worst view. */
  diffPct: number;
  threshold: number;
  pass: boolean;
  /**
   * Per view: `default` plus `orbit-<i>` for each extra view. `diffPct` is rounded to three decimals, which at the
   * harness's 1280x720 canvas absorbs up to 4 changed pixels of 921,600, so `changedPixels` carries the exact count:
   * only `changedPixels === 0` means no pixel moved.
   */
  views: Array<{ view: string; diffPct: number; changedPixels: number }>;
}

export interface Verdict {
  pass: boolean;
  budget: { maxSubmissions: number; actual: number; pass: boolean } | null;
  /** Codes of error-severity hints. */
  errors: string[];
  /** Human reasons for a failed verdict. */
  reasons: string[];
}

/**
 * The compile report as the CLI reads it from the page. `skipped` and `groups` hold at most 256 entries: every array a
 * page hands back is capped (`sanitizeDeep`, `src/cli/untrusted.ts`), and an object array cannot carry a "(+N more)"
 * marker without breaking its type. `skippedCount` and `groupCount` are the true lengths, counted in the page before
 * the cap (`compileViaHook`, `src/cli/measure.ts`).
 */
export type CliCompileReport = CompileReport & { skippedCount: number; groupCount: number };

/** The one document `analyze` and `inspect` print (and the MCP tools return). */
export interface AgentDocument {
  schemaVersion: 2;
  tool: 'threeforge';
  version: string;
  command: 'analyze' | 'inspect';
  input: AnalyzeInput | InspectInput;
  env: FrameEnv;
  asset: AssetFacts | null;
  before: FrameSnapshot;
  after: FrameSnapshot | null;
  compile: CliCompileReport | null;
  parity: Parity | null;
  hints: Hint[];
  verdict: Verdict;
  timings: { totalMs: number };
}

export type StepName = 'dedup' | 'instance' | 'palette' | 'flatten' | 'join' | 'weld' | 'simplify' | 'resample' | 'prune' | 'textures' | 'quantize' | 'meshopt';
export type Preset = 'safe' | 'balanced' | 'aggressive';
export type TextureFormat = 'webp' | 'avif';

export interface OptimizeInput {
  file: string;
  /** Output path; null = `<name>.forge.glb` next to the input. */
  out: string | null;
  preset: Preset;
  /** Per-step overrides from `--<step>` (true) and `--no-<step>` (false). */
  steps: Partial<Record<StepName, boolean>>;
  /** Simplify ratio (0, 1]; null = the preset decides. */
  simplify: number | null;
  simplifyError: number;
  compress: 'none' | 'meshopt';
  /** Texture format; 'none' disables the step; null = the preset decides. */
  textures: TextureFormat | 'none' | null;
  /** Longest texture side in pixels; null = the preset decides (no resize outside presets). */
  textureSize: number | null;
  textureQuality: number;
  verify: boolean;
  /** Pixel parity threshold in percent between the original and the optimized render. */
  parity: number;
  views: number;
  backend: Backend;
  tier: TierChoice;
  budget: number | null;
  frames: number;
  compile: boolean;
  timeout: number;
  headed: boolean;
  /**
   * Replace an existing `out` file, or an existing file at any resource target a `.gltf` output is about to write
   * (`writeOutput`, `src/cli/optimize.ts`). Optional and defaults to `true` (replace) so CLI behaviour is
   * unchanged; the MCP `optimize_asset` tool always sets this explicitly from its own `overwrite` argument.
   */
  overwrite?: boolean;
}

/** Cheap per-step tally of a glTF document. */
export interface Counts {
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  /** Encoded image bytes of every texture. */
  textureBytes: number;
  accessors: number;
  vertices: number;
  triangles: number;
}

export interface AssetStats extends Counts {
  bytes: number;
  animations: number;
  skins: number;
  morphTargets: number;
  extensions: string[];
}

export interface StepReport {
  name: StepName;
  applied: boolean;
  ms: number;
  /** Why a step was skipped, or what it needs. */
  note: string | null;
  before: Counts;
  after: Counts;
}

/** What the optimized file needs from the loader. `code` is null when three's GLTFLoader handles it alone. */
export interface Requirement {
  extension: string;
  needs: string;
  code: string | null;
}

/** after − before; compiled submissions are null when the run did not compile. */
export interface OptimizeDelta {
  bytes: number;
  materials: number;
  vertices: number;
  triangles: number;
  sceneSubmissions: { naive: number; compiled: number | null };
  loadMs: number;
  memoryBytes: number;
}

export interface OptimizeVerify {
  backend: Backend;
  /** Original naive render vs optimized naive render, per view. */
  parity: Parity;
  original: AgentDocument;
  optimized: AgentDocument;
  delta: OptimizeDelta;
}

export interface OptimizeDocument {
  schemaVersion: 2;
  tool: 'threeforge';
  version: string;
  command: 'optimize';
  input: OptimizeInput;
  output: { file: string; bytes: number };
  stats: { before: AssetStats; after: AssetStats };
  steps: StepReport[];
  requires: Requirement[];
  verify: OptimizeVerify | null;
  verdict: Verdict;
  timings: { transformMs: number; verifyMs: number; totalMs: number };
}
