import type { CompileReport } from '../compiler/World.js';
import type { FrameEnv, FrameSnapshot, Hint, Tier } from '../ledger/snapshot.js';

export type Backend = 'webgl2' | 'webgpu';
export type TierChoice = Tier | 'auto';

export interface AnalyzeInput {
  file: string;
  backend: Backend;
  tier: TierChoice;
  budget: number | null;
  frames: number;
  compile: boolean;
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
  diffPct: number;
  threshold: number;
  pass: boolean;
}

export interface Verdict {
  pass: boolean;
  budget: { maxSubmissions: number; actual: number; pass: boolean } | null;
  /** Codes of error-severity hints. */
  errors: string[];
  /** Human reasons for a failed verdict. */
  reasons: string[];
}

/** The one document `analyze` and `inspect` print (and the MCP tools return). */
export interface AgentDocument {
  schemaVersion: 1;
  tool: 'threeforge';
  version: string;
  command: 'analyze' | 'inspect';
  input: AnalyzeInput | InspectInput;
  env: FrameEnv;
  asset: AssetFacts | null;
  before: FrameSnapshot;
  after: FrameSnapshot | null;
  compile: CompileReport | null;
  parity: Parity | null;
  hints: Hint[];
  verdict: Verdict;
  timings: { totalMs: number };
}
