export { VERSION } from './version.js';
export { exposeToAgents, AGENT_HOOK_KEY, type AgentHook, type ExposeOptions } from './agent/expose.js';
export { tag, FORGE_TAG_KEY, type ForgeTag } from './tags.js';
export {
  MaterialRegistry,
  type MaterialDescription,
  type MaterialHashes,
  type ProgramStats,
  type RegisterOutcome,
  type RegistryStats,
} from './registry/MaterialRegistry.js';
export { computeMaterialKeys, hashKey, type MaterialKeys } from './registry/materialKey.js';
export { DrawCallLedger, type DrawCallLedgerOptions, type LedgerRenderer } from './ledger/DrawCallLedger.js';
export type { Flag, Reason, SubmissionKind } from './ledger/reasons.js';
export type { BudgetOffender, BudgetResult, FrameEnv, FrameSnapshot, FrameTotals, Hint, HintCategory, JsSnapshot, LightingSnapshot, MeasuredMemory, MemorySnapshot, OverdrawSnapshot, PassSnapshot, ProgramSnapshot, ReasonSnapshot, SkinningSnapshot, SubmissionRecord, Tier } from './ledger/snapshot.js';
export { BUDGETS, budgetsFor, detectTier, tierInputFromNavigator, type Budgets, type TierInput, type TierNavigator } from './ledger/budgets.js';
export { hintsFor, type HintContext, type MainPassObjects } from './ledger/hints.js';
export { disposeOverdraw, measureOverdraw, overdrawTargetOf, type OverdrawOptions, type OverdrawRenderer, type OverdrawResult } from './ledger/overdraw.js';
export { estimateMemory, geometryBytes, textureBytes, type AllowedRenderTarget, type MemoryEstimateOptions, type RendererMemoryInfo } from './ledger/memory.js';
export { lightingOf, NO_SHADOW_WORK, scanLights, skinningOf, type LightInfo, type ShadowWork } from './ledger/sections.js';
export { classify, exclusionRule, animatedRoots, type Classification, type ClassifyOptions, type MeshKind } from './compiler/classify.js';
export { attributeSignature, ensureIndexed, isBatchCompatible } from './compiler/geometryCompat.js';
export { World, FORGE_HIDDEN_LAYER, type BakeSummary, type CompileOptions, type CompileReport, type DirtyEvent, type WarmupOptions, type WarmupRenderer, type WarmupResult, type WorldOptions } from './compiler/World.js';
export type { BakedGroup, GroupReport, Slot } from './compiler/batchStatics.js';
export { attachBvhCulling, prependAfterRenderHook, prependRenderHook, levelFor, FORGE_HOOK, type CullingHandle, type CullingLod, type CullingOptions, type NestedPassPolicy } from './compiler/culling.js';
export { PassTracker } from './compiler/passTracker.js';
export { createCulledInstancedMesh, type CulledInstancedMesh, type InstanceCullingHandle, type InstancingOptions } from './compiler/instancing.js';
export type { BatchOptions } from './compiler/batchStatics.js';
export { disposeLods, generateLods, lodsOf, prepareLods, type LodOptions, type PrepareLodsReport } from './lod/generateLods.js';
export { assembleCharacter, type AssembledCharacter, type AssembleOptions, type AtlasCell, type CharacterReport } from './character/assembleCharacter.js';
export { formatCostRows, formatHints, formatOverlay } from './overlay/index.js';
export { groupSprites, fillSpriteInstances, spriteRule, isVisibleInGraph, type SpriteGroup, type SpriteSkip, type SpriteFillOptions, type SpriteKeys } from './compiler/sprites.js';
export { AnimatedInstances, type AnimatedInstancesOptions, type ClipOptions } from './skinning/AnimatedInstances.js';
export { bakeAnimationTexture, type AnimationClipRange, type AnimationPart, type AnimationTexture, type BakeAnimationOptions } from './skinning/bakeAnimationTexture.js';
export { DayNight, type DayNightColors, type DayNightOptions, type DayNightShadowOptions } from './lighting/DayNight.js';
export { ShadowBudget, type ShadowBudgetOptions, type ShadowBudgetReport, type ShadowLightReport } from './lighting/ShadowBudget.js';
export { RenderScheduler, type RenderSchedulerOptions, type SchedulerMixer, type SchedulerRenderer } from './scheduler/RenderScheduler.js';
export { freezableObjects, type FreezeInput } from './compiler/freeze.js';
export { buildSpriteBatch, type SpriteBatch, type SpriteBatchDisposeOptions, type SpriteBatchOptions } from './compiler/spriteBatch.js';
export { ParticleBudget, type ParticleBudgetOptions, type ParticleBudgetReport, type ParticleSystemReport } from './overdraw/ParticleBudget.js';
export { ResolutionScaler, type ResolutionScalerOptions, type ScalerRenderer } from './overdraw/ResolutionScaler.js';
export { bakeGeometries, type BakeEntry, type BakeOptions, type BakeReport, type BakeResult, type BuriedOptions } from './compiler/bake.js';
export { createLoader, decoderPaths, disposeLoader, type CreateLoaderOptions } from './load/createLoader.js';
export { ResourceTracker, type ReleaseReport, type ResourceTrackerOptions, type TrackerStats } from './memory/ResourceTracker.js';
export { collectResources, emptyResourceSets, unreferencedResources, type ResourceSets } from './memory/resources.js';
export { Streamer, type StreamerEvent, type StreamerOptions, type StreamerStats } from './streaming/Streamer.js';
