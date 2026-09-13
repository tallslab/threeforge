export const VERSION = '0.1.0';
export { tag, FORGE_TAG_KEY, type ForgeTag } from './tags.js';
export {
  MaterialRegistry,
  type MaterialDescription,
  type ProgramStats,
  type RegisterOutcome,
  type RegistryStats,
} from './registry/MaterialRegistry.js';
export { computeMaterialKeys, hashKey, type MaterialKeys } from './registry/materialKey.js';
export { DrawCallLedger, type DrawCallLedgerOptions, type LedgerRenderer } from './ledger/DrawCallLedger.js';
export type { Flag, Reason, SubmissionKind } from './ledger/reasons.js';
export type { BudgetOffender, BudgetResult, FrameSnapshot, FrameTotals, PassSnapshot, ProgramSnapshot, ReasonSnapshot, SubmissionRecord } from './ledger/snapshot.js';
export { classify, exclusionRule, type Classification, type ClassifyOptions, type MeshKind } from './compiler/classify.js';
export { attributeSignature, ensureIndexed, isBatchCompatible } from './compiler/geometryCompat.js';
export { World, FORGE_HIDDEN_LAYER, type CompileOptions, type CompileReport, type WarmupRenderer, type WorldOptions } from './compiler/World.js';
export type { GroupReport, Slot } from './compiler/batchStatics.js';
export { attachBvhCulling, prependRenderHook, FORGE_HOOK, type CullingHandle, type CullingOptions } from './compiler/culling.js';
export { createCulledInstancedMesh, type CulledInstancedMesh, type InstanceCullingHandle } from './compiler/instancing.js';
export type { BatchOptions } from './compiler/batchStatics.js';
