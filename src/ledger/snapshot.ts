import type { Flag, Reason, SubmissionKind } from './reasons.js';
import { lightingOf, skinningOf, type LightInfo } from './sections.js';

export interface SubmissionRecord {
  name: string;
  kind: SubmissionKind;
  materialType: string;
  programHash: string;
  variantHash: string;
  transparent: boolean;
  pass: string;
  reason: Reason;
  flags: Flag[];
  expectedGpuDraws: number;
  /** Instances this submission covers (BatchedMesh/InstancedMesh count, else 1). */
  instances: number;
  /** Instances that survived per-instance culling and were actually drawn. */
  instancesDrawn: number;
  /** Vertices of the submitted geometry (position attribute count). */
  vertices: number;
  /** Bones on the skeleton (0 when not skinned). */
  bones: number;
  /** Per-frame index of the skeleton for skinned submissions (stable within a snapshot, no uuids), else null. */
  skeleton: number | null;
  morphTargets: number;
}

export interface PassSnapshot {
  id: string;
  submissions: number;
  gpuDraws: number;
}

export interface ReasonSnapshot {
  submissions: number;
  gpuDraws: number;
  /** First few object names, in submission order. */
  top: string[];
}

export interface ProgramSnapshot {
  type: string;
  description: string;
  submissions: number;
}

export interface FrameTotals {
  /** Render items the renderer processed, including renderer-internal work. */
  submissions: number;
  /** Submissions attributable to the user's scene, across all passes. The budgeted number. */
  sceneSubmissions: number;
  /** GPU draw commands the ledger expects those submissions to have issued on this backend. */
  gpuDraws: number;
  /** What `renderer.info.render.drawCalls` grew by during the frame. */
  reportedDrawCalls: number;
  /** reportedDrawCalls - gpuDraws. Non-zero means the ledger's cost model is missing something. */
  unattributed: number;
  programSwitches: number;
  /** `renderer.info.memory.programs` at the end of the frame. */
  programs: number;
  triangles: number;
  /** Scene instances submitted (renderer-internal work excluded). */
  instances: number;
  /** Scene instances drawn after per-instance culling. */
  instancesDrawn: number;
  /** GPU draw commands regardless of API packaging: a multi-draw of N ranges is N commands, an instanced draw is 1. */
  drawCommands: number;
}

export type Tier = 'desktop' | 'phone-mid' | 'phone-low';

export interface OverdrawSnapshot {
  /** Opaque fragments rasterised per pixel (measured). */
  opaque: number;
  /** Transparent fragments rasterised per pixel (measured). */
  transparent: number;
  transparentSubmissions: number;
  /** False until `ledger.measureOverdraw()` has run. */
  measured: boolean;
}

export interface SkinningSnapshot {
  submissions: number;
  vertices: number;
  bones: number;
  skeletons: number;
  maxBones: number;
  morphTargets: number;
}

export interface LightingSnapshot {
  lights: { directional: number; point: number; spot: number; hemisphere: number; ambient: number; other: number };
  shadowLights: number;
  shadowPasses: number;
  shadowCasters: number;
  /** Shadow-map texels rendered per frame: Σ mapSize.x · mapSize.y · faces (6 for point lights). */
  shadowTexels: number;
  shadowSubmissions: number;
}

export interface JsSnapshot {
  /** Milliseconds inside the outermost render() call. */
  renderMs: number;
  /** Median interval between the last outermost render() starts. */
  frameMs: number;
  objects: number;
  /** Objects whose world matrix three recomputes every frame. */
  autoUpdatedMatrices: number;
}

export interface MemorySnapshot {
  textures: { count: number; bytes: number };
  geometries: { count: number; bytes: number };
  renderTargets: { count: number; bytes: number };
  estimated: true;
}

export type HintCategory = 'drawCalls' | 'overdraw' | 'skinning' | 'lighting' | 'js' | 'memory';

export interface Hint {
  category: HintCategory;
  severity: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  objects: string[];
}

export interface FrameEnv {
  three: string;
  backend: 'webgl2' | 'webgpu' | 'unknown';
  multiDraw: boolean;
  tier: Tier;
  gpu: string;
  dpr: number;
  viewport: [number, number];
}

export interface FrameSnapshot {
  schemaVersion: 2;
  env: FrameEnv;
  totals: FrameTotals;
  passes: PassSnapshot[];
  byReason: Record<string, ReasonSnapshot>;
  programs: Record<string, ProgramSnapshot>;
  overdraw: OverdrawSnapshot;
  skinning: SkinningSnapshot;
  lighting: LightingSnapshot;
  js: JsSnapshot;
  memory: MemorySnapshot;
  hints: Hint[];
  items?: SubmissionRecord[];
}

export type FrameSections = Pick<FrameSnapshot, 'overdraw' | 'skinning' | 'lighting' | 'js' | 'memory' | 'hints'>;

export function emptySections(): FrameSections {
  return {
    overdraw: { opaque: 0, transparent: 0, transparentSubmissions: 0, measured: false },
    skinning: { submissions: 0, vertices: 0, bones: 0, skeletons: 0, maxBones: 0, morphTargets: 0 },
    lighting: { lights: { directional: 0, point: 0, spot: 0, hemisphere: 0, ambient: 0, other: 0 }, shadowLights: 0, shadowPasses: 0, shadowCasters: 0, shadowTexels: 0, shadowSubmissions: 0 },
    js: { renderMs: 0, frameMs: 0, objects: 0, autoUpdatedMatrices: 0 },
    memory: { textures: { count: 0, bytes: 0 }, geometries: { count: 0, bytes: 0 }, renderTargets: { count: 0, bytes: 0 }, estimated: true },
    hints: [],
  };
}

export interface BudgetOffender {
  reason: string;
  submissions: number;
  top: string[];
}

export interface BudgetResult {
  pass: boolean;
  actual: number;
  max: number;
  offenders: BudgetOffender[];
}

export const TOP_NAMES = 5;

export function emptyFrame(env: FrameSnapshot['env']): FrameSnapshot {
  return {
    schemaVersion: 2,
    env,
    totals: { submissions: 0, sceneSubmissions: 0, gpuDraws: 0, reportedDrawCalls: 0, unattributed: 0, programSwitches: 0, programs: 0, triangles: 0, instances: 0, instancesDrawn: 0, drawCommands: 0 },
    passes: [],
    byReason: {},
    programs: {},
    ...emptySections(),
  };
}

export interface FrameInput {
  env: FrameSnapshot['env'];
  items: SubmissionRecord[];
  reportedDrawCalls: number;
  triangles: number;
  programs: number;
  descriptions: Map<string, { type: string; description: string }>;
  /** Visible lights of the main scene (see `scanLights`). */
  lights?: LightInfo[];
}

export function buildFrame({ env, items, reportedDrawCalls, triangles, programs, descriptions, lights = [] }: FrameInput): FrameSnapshot {
  const passes = new Map<string, PassSnapshot>();
  const byReason = new Map<string, ReasonSnapshot>();
  const programMap = new Map<string, ProgramSnapshot>();
  let gpuDraws = 0;
  let sceneSubmissions = 0;
  let instances = 0;
  let instancesDrawn = 0;
  let drawCommands = 0;
  let programSwitches = 0;
  let lastPass: string | null = null;
  let lastProgram: string | null = null;

  for (const item of items) {
    gpuDraws += item.expectedGpuDraws;
    drawCommands += item.kind === 'batched' ? item.instancesDrawn : item.expectedGpuDraws;
    if (item.reason !== 'renderer-internal') {
      instances += item.instances;
      instancesDrawn += item.instancesDrawn;
    }
    let pass = passes.get(item.pass);
    if (!pass) passes.set(item.pass, (pass = { id: item.pass, submissions: 0, gpuDraws: 0 }));
    pass.submissions++;
    pass.gpuDraws += item.expectedGpuDraws;

    let reason = byReason.get(item.reason);
    if (!reason) byReason.set(item.reason, (reason = { submissions: 0, gpuDraws: 0, top: [] }));
    reason.submissions++;
    reason.gpuDraws += item.expectedGpuDraws;
    if (reason.top.length < TOP_NAMES) reason.top.push(item.name);

    if (item.reason === 'renderer-internal') continue;
    sceneSubmissions++;
    if (item.pass !== lastPass) {
      lastPass = item.pass;
      lastProgram = null;
    }
    if (lastProgram !== null && lastProgram !== item.programHash) programSwitches++;
    lastProgram = item.programHash;

    let program = programMap.get(item.programHash);
    if (!program) {
      const d = descriptions.get(item.programHash);
      programMap.set(item.programHash, (program = { type: d?.type ?? item.materialType, description: d?.description ?? item.materialType, submissions: 0 }));
    }
    program.submissions++;
  }

  const sortedKeys = <T>(map: Map<string, T>): Record<string, T> =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    schemaVersion: 2,
    env,
    ...emptySections(),
    skinning: skinningOf(items),
    lighting: lightingOf(lights, items),
    totals: {
      submissions: items.length,
      sceneSubmissions,
      gpuDraws,
      reportedDrawCalls,
      unattributed: reportedDrawCalls - gpuDraws,
      programSwitches,
      programs,
      triangles,
      instances,
      instancesDrawn,
      drawCommands,
    },
    passes: [...passes.values()],
    byReason: sortedKeys(byReason),
    programs: sortedKeys(programMap),
  };
}
