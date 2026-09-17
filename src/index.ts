export { AGENT_HOOK_KEY, type AgentHook, type ExposeOptions, exposeToAgents } from './agent/expose.js';
export {
  type AssembledCharacter,
  type AssembleOptions,
  type AtlasCell,
  assembleCharacter,
  type CharacterReport,
} from './character/assembleCharacter.js';
export {
  type BakeEntry,
  type BakeOptions,
  type BakeReport,
  type BakeResult,
  type BuriedOptions,
  bakeGeometries,
} from './compiler/bake.js';
export type { BakedGroup, BatchOptions, GroupReport, Slot } from './compiler/batchStatics.js';
export {
  animatedRoots,
  type Classification,
  type ClassifyOptions,
  classify,
  exclusionRule,
  type MeshKind,
} from './compiler/classify.js';
export {
  attachBvhCulling,
  type CullingHandle,
  type CullingLod,
  type CullingOptions,
  FORGE_HOOK,
  levelFor,
  type NestedPassPolicy,
  prependAfterRenderHook,
  prependRenderHook,
} from './compiler/culling.js';
export { type FreezeInput, freezableObjects } from './compiler/freeze.js';
export { attributeSignature, ensureIndexed, isBatchCompatible } from './compiler/geometryCompat.js';
export {
  type CulledInstancedMesh,
  createCulledInstancedMesh,
  type InstanceCullingHandle,
  type InstancingOptions,
} from './compiler/instancing.js';
export { PassTracker } from './compiler/passTracker.js';
export {
  buildSpriteBatch,
  type SpriteBatch,
  type SpriteBatchDisposeOptions,
  type SpriteBatchOptions,
} from './compiler/spriteBatch.js';
export {
  fillSpriteInstances,
  groupSprites,
  isVisibleInGraph,
  type SpriteFillOptions,
  type SpriteGroup,
  type SpriteKeys,
  type SpriteSkip,
  spriteRule,
} from './compiler/sprites.js';
export {
  type BakeSummary,
  type CompileOptions,
  type CompileReport,
  type DirtyEvent,
  FORGE_HIDDEN_LAYER,
  type WarmupOptions,
  type WarmupRenderer,
  type WarmupResult,
  World,
  type WorldOptions,
} from './compiler/World.js';
export {
  BUDGETS,
  type Budgets,
  budgetsFor,
  detectTier,
  type TierInput,
  type TierNavigator,
  tierInputFromNavigator,
} from './ledger/budgets.js';
export { DrawCallLedger, type DrawCallLedgerOptions, type LedgerRenderer } from './ledger/DrawCallLedger.js';
export { type GpuRenderer, gpuName } from './ledger/gpu.js';
export { type HintContext, type HintItem, hintsFor, type MainPassObjects } from './ledger/hints.js';
export {
  type AllowedRenderTarget,
  estimateMemory,
  geometryBytes,
  type MemoryEstimateOptions,
  type RendererMemoryInfo,
  textureBytes,
} from './ledger/memory.js';
export {
  disposeOverdraw,
  measureOverdraw,
  type OverdrawOptions,
  type OverdrawRenderer,
  type OverdrawResult,
  overdrawTargetOf,
} from './ledger/overdraw.js';
export type { Flag, Reason, SubmissionKind } from './ledger/reasons.js';
export { formatCostRows, formatHints } from './ledger/report.js';
export {
  type LightInfo,
  lightingOf,
  NO_SHADOW_WORK,
  type ShadowWork,
  scanLights,
  skinningOf,
} from './ledger/sections.js';
export type {
  BudgetOffender,
  BudgetResult,
  FrameEnv,
  FrameSnapshot,
  FrameTotals,
  Hint,
  HintCategory,
  JsSnapshot,
  LightingSnapshot,
  MeasuredMemory,
  MemorySnapshot,
  OverdrawSnapshot,
  PassSnapshot,
  ProgramSnapshot,
  ReasonSnapshot,
  SkinningSnapshot,
  SubmissionRecord,
  Tier,
} from './ledger/snapshot.js';
export { describeError, formatBytes, formatCount } from './ledger/text.js';
export {
  DayNight,
  type DayNightColors,
  type DayNightOptions,
  type DayNightShadowOptions,
} from './lighting/DayNight.js';
export {
  ShadowBudget,
  type ShadowBudgetOptions,
  type ShadowBudgetReport,
  type ShadowLightReport,
} from './lighting/ShadowBudget.js';
export { type CreateLoaderOptions, createLoader, decoderPaths, disposeLoader } from './load/createLoader.js';
export {
  disposeLods,
  generateLods,
  type LodOptions,
  lodsOf,
  type PrepareLodsReport,
  prepareLods,
} from './lod/generateLods.js';
export {
  type ReleaseReport,
  ResourceTracker,
  type ResourceTrackerOptions,
  type TrackerStats,
} from './memory/ResourceTracker.js';
export { collectResources, emptyResourceSets, type ResourceSets, unreferencedResources } from './memory/resources.js';
export {
  ParticleBudget,
  type ParticleBudgetOptions,
  type ParticleBudgetReport,
  type ParticleSystemReport,
} from './overdraw/ParticleBudget.js';
export { ResolutionScaler, type ResolutionScalerOptions, type ScalerRenderer } from './overdraw/ResolutionScaler.js';
export { formatOverlay } from './overlay/index.js';
export {
  type MaterialDescription,
  type MaterialHashes,
  MaterialRegistry,
  type ProgramStats,
  type RegisterOutcome,
  type RegistryStats,
} from './registry/MaterialRegistry.js';
export { computeMaterialKeys, hashKey, type MaterialKeys } from './registry/materialKey.js';
export {
  RenderScheduler,
  type RenderSchedulerOptions,
  type SchedulerMixer,
  type SchedulerRenderer,
} from './scheduler/RenderScheduler.js';
export { AnimatedInstances, type AnimatedInstancesOptions, type ClipOptions } from './skinning/AnimatedInstances.js';
export {
  type AnimationClipRange,
  type AnimationPart,
  type AnimationTexture,
  type BakeAnimationOptions,
  bakeAnimationTexture,
} from './skinning/bakeAnimationTexture.js';
export { Streamer, type StreamerEvent, type StreamerOptions, type StreamerStats } from './streaming/Streamer.js';
export { FORGE_TAG_KEY, type ForgeTag, tag } from './tags.js';
export { VERSION } from './version.js';
