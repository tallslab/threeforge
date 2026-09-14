/** Programmatic access to the CLI's operations: `import { analyzeAsset, inspectApp, explain } from 'threeforge/cli'`. */
export { analyzeAsset, analyzeAssetWithShots, pixelDiffPct } from './analyze.js';
export { optimizeAsset, defaultOutputPath } from './optimize.js';
export { planSteps, PRESETS, STEP_NAMES, type Step, type StepOptions } from './pipeline.js';
export { applySteps, countsOf, statsOf, requirementsOf, loadDeps, createIO, describeChange, type Deps } from './transform.js';
export { inspectApp } from './inspect.js';
export { explain, REMEDIES, type Remedy } from './explain.js';
export { ANALYZE_SCHEMA, INSPECT_SCHEMA, OPTIMIZE_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
export { parseArgs, UsageError, COMMANDS, type Command } from './args.js';
export { EnvironmentError, launchBrowser } from './browser.js';
export { PageError, measureViaHook } from './measure.js';
export { serveStatic } from './server.js';
export { summarize, summarizeOptimize } from './format.js';
export { exitCodeOf, verdictOf } from './verdict.js';
export type * from './types.js';
