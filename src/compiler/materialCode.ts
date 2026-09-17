/**
 * What can be told about the code a material would run, from the instance alone: a leaf the compiler's batching rules,
 * the sprite rules and the ledger's `batch-local-space` hint share. Imports nothing but three and the registry, so the
 * ledger can use it without pulling the compiler (bake, BVH, meshoptimizer) into its import closure.
 */
import type { Material } from 'three';

/** The key of the symbol that marks a threeforge render hook (`FORGE_HOOK` in culling.ts): `Symbol.for(FORGE_HOOK_KEY)`. */
export const FORGE_HOOK_KEY = 'threeforge.hook';

/**
 * Whether code is assigned to the material instance: any own property holding a function (an instance
 * `onBeforeCompile`, `customProgramCacheKey`, `onBeforeRender`, `setup`, `setupOutput` …). A fresh three material has
 * none.
 */
export function hasOwnFunctions(material: Material): boolean {
  const record = material as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(material).some((key) => typeof record[key] === 'function');
}

/** The `defines` three's own mesh materials set: `MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshToonMaterial`, `MeshMatcapMaterial`. */
export const MATERIAL_DEFINES: ReadonlySet<string> = new Set(['STANDARD', 'PHYSICAL', 'TOON', 'MATCAP']);

/**
 * No node slot is set: no non-null own `*Node` property (three r186's `NodeMaterial` declares its slots that way and
 * subclasses add more) and no other own property holding a node (`NodeMaterial._getNodeChildren` reads them all).
 * Any of them can carry `Discard()` (`nodes/utils/Discard.js`).
 */
export function hasNoNodes(material: Material): boolean {
  for (const key of Object.getOwnPropertyNames(material)) {
    if (key.startsWith('_')) continue;
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    if (key.endsWith('Node') || (value as { isNode?: boolean }).isNode === true) return false;
  }
  return true;
}

/**
 * A node material with any node slot set. three r186's `NodeMaterial` declares its slots as `*Node` instance properties
 * (`NodeMaterial.js` ~103-390: `lightsNode`, `envNode`, `aoNode`, `colorNode`, `normalNode`, `opacityNode`,
 * `backdropNode`, `backdropAlphaNode`, `alphaTestNode`, `maskNode`, `maskShadowNode`, `positionNode`, `geometryNode`,
 * `depthNode`, `receivedShadowPositionNode`, `castShadowPositionNode`, `receivedShadowNode`, `castShadowNode`,
 * `outputNode`, `mrtNode`, `fragmentNode`, `vertexNode`, `contextNode`); `SpriteNodeMaterial` adds `rotationNode` and
 * `scaleNode` (`SpriteNodeMaterial.js` ~63-86). Every own property ending in `Node` is read, so a subclass's slots count.
 * It cannot see into a node, so a constant counts too (a fresh `MeshSSSNodeMaterial` sets five `thickness*Node` slots to
 * `float()` constants in its constructor). `spriteRule` (`sprite-node-material`) and the ledger's `batch-local-space`
 * hint share this test.
 */
export function hasNodeSlot(material: Material): boolean {
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial !== true) return false;
  for (const key of Object.keys(material)) {
    if (!key.endsWith('Node')) continue;
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value !== null && value !== undefined) return true;
  }
  return false;
}
