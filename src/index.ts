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
