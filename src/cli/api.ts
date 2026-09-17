/** Programmatic access to the CLI's operations: `import { analyzeAsset, inspectApp, explain } from 'threeforge/cli'`. */
export { analyzeAsset, analyzeAssetWithShots } from './analyze.js';
export { type Command, parseArgs } from './args.js';
export { launchBrowser } from './browser.js';
export { COMMANDS } from './commandSpecs.js';
export { EnvironmentError, PageError, UsageError } from './errors.js';
export { explain, REMEDIES, type Remedy } from './explain.js';
export { summarize, summarizeOptimize } from './format.js';
export { inspectApp } from './inspect.js';
export type { CliDeps } from './lifecycle.js';
export { measureViaHook } from './measure.js';
export { defaultOutputPath, optimizeAsset } from './optimize.js';
export { PRESETS, planSteps, STEP_NAMES, type Step, type StepOptions } from './pipeline.js';
export { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
export { serveStatic } from './server.js';
export {
  applySteps,
  countsOf,
  createIO,
  type Deps,
  describeChange,
  loadDeps,
  requirementsOf,
  statsOf,
} from './transform.js';
export type * from './types.js';
export { exitCodeOf, verdictOf } from './verdict.js';
