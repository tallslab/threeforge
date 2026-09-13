/** Programmatic access to the CLI's operations: `import { analyzeAsset, inspectApp, explain } from 'threeforge/cli'`. */
export { analyzeAsset, pixelDiffPct } from './analyze.js';
export { inspectApp } from './inspect.js';
export { explain, REMEDIES, type Remedy } from './explain.js';
export { ANALYZE_SCHEMA, INSPECT_SCHEMA, SNAPSHOT_SCHEMA } from './schema.js';
export { parseArgs, UsageError, COMMANDS, type Command } from './args.js';
export { EnvironmentError, launchBrowser } from './browser.js';
export { PageError, measureViaHook } from './measure.js';
export { serveStatic } from './server.js';
export { summarize } from './format.js';
export { exitCodeOf, verdictOf } from './verdict.js';
export type * from './types.js';
