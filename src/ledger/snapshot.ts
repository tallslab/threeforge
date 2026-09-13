import type { Flag, Reason, SubmissionKind } from './reasons.js';

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

export interface FrameSnapshot {
  schemaVersion: 1;
  env: { three: string; backend: 'webgl2' | 'webgpu' | 'unknown'; multiDraw: boolean };
  totals: FrameTotals;
  passes: PassSnapshot[];
  byReason: Record<string, ReasonSnapshot>;
  programs: Record<string, ProgramSnapshot>;
  items?: SubmissionRecord[];
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
    schemaVersion: 1,
    env,
    totals: { submissions: 0, sceneSubmissions: 0, gpuDraws: 0, reportedDrawCalls: 0, unattributed: 0, programSwitches: 0, programs: 0, triangles: 0, instances: 0, instancesDrawn: 0, drawCommands: 0 },
    passes: [],
    byReason: {},
    programs: {},
  };
}

export interface FrameInput {
  env: FrameSnapshot['env'];
  items: SubmissionRecord[];
  reportedDrawCalls: number;
  triangles: number;
  programs: number;
  descriptions: Map<string, { type: string; description: string }>;
}

export function buildFrame({ env, items, reportedDrawCalls, triangles, programs, descriptions }: FrameInput): FrameSnapshot {
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
    schemaVersion: 1,
    env,
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
