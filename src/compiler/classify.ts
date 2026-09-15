import { DynamicDrawUsage, PropertyBinding, StreamDrawUsage, type AnimationClip, type Material, type Mesh, type Object3D } from 'three';
import { effectiveTag } from '../ledger/reasons.js';
import { ancestorExclusionRule, isVisibleInGraph } from './sprites.js';

export type MeshKind = 'static' | 'dynamic' | 'skinned' | 'morph' | 'excluded' | 'untagged' | 'unsupported';

export interface Classification {
  object: Mesh;
  kind: MeshKind;
  /** The rule that decided, e.g. `tag:static`, `auto`, `multi-material`, `mirrored`. */
  rule: string;
}

/** A clip resolved against the whole graph, or clips resolved under a specific root (one per animated character). */
export type AnimationSource = AnimationClip | { root: Object3D; clips: AnimationClip[] };

export interface ClassifyOptions {
  /** `tagged` (default): only `tag.static()` meshes are batched. `auto`: untagged plain meshes are batched too. */
  policy?: 'tagged' | 'auto';
  /**
   * Clips that will drive this graph; every node they target (and its descendants) is dynamic. Pass
   * `{ root, clips }` per character when several share bone or node names, since names resolve by first match.
   */
  animations?: AnimationSource[];
}

type MeshLike = Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean; morphTargetInfluences?: number[] };

const OWN = Object.prototype.hasOwnProperty;

function isShader(material: Material | Material[]): boolean {
  const m = (Array.isArray(material) ? material[0] : material) as (Material & { isShaderMaterial?: boolean; isRawShaderMaterial?: boolean }) | undefined;
  return Boolean(m?.isShaderMaterial || m?.isRawShaderMaterial);
}

/**
 * Rules that make a mesh unreproducible inside a BatchedMesh, in the order they are checked. `root` scopes the
 * ancestor-based rules (`invisible-ancestor`, `group-render-order`, `clipping-group`); omit it to skip those three
 * and check only the mesh's own state. With `root`, `mirrored` is decided relative to it (the compiled objects are its
 * children); without it, by the world determinant.
 */
export function exclusionRule(mesh: Mesh, root?: Object3D): string | null {
  if (!mesh.visible) return 'invisible';
  // Own visibility is checked above; this only catches an ancestor Group (or Scene) turned off, which three's
  // renderer treats as hiding the whole subtree, batch-worthy mesh included.
  if (root && !isVisibleInGraph(mesh, root)) return 'invisible-ancestor';
  if ((mesh as MeshLike).isInstancedMesh) return 'already-instanced';
  // three's transmission code derives volume thickness from the object's model-matrix scale; a batch or an
  // instanced mesh presents one identity matrix for every instance, so refraction would be wrong.
  const material = mesh.material as Material & { transmission?: number };
  if (!Array.isArray(mesh.material)) {
    if (material.visible === false) return 'material-invisible';
    if ((material.transmission ?? 0) > 0) return 'transmission';
  }
  // Geometry rewritten at runtime (trails, ribbons, soft bodies): a batch copies vertices once.
  const geometry = mesh.geometry;
  const attributes = [...Object.values(geometry.attributes), ...(geometry.index ? [geometry.index] : [])] as Array<{ usage?: number }>;
  if (attributes.some((a) => a.usage === DynamicDrawUsage || a.usage === StreamDrawUsage)) return 'dynamic-geometry';
  if (Array.isArray(mesh.material)) return 'multi-material';
  if (mesh.layers.mask !== 1) return 'layers';
  if (mesh.renderOrder !== 0) return 'render-order';
  if (root) {
    const ancestor = ancestorExclusionRule(mesh, root);
    if (ancestor) return ancestor;
  }
  if (OWN.call(mesh, 'onBeforeRender') || OWN.call(mesh, 'onAfterRender')) return 'custom-hook';
  const range = mesh.geometry.drawRange;
  if (range.start !== 0 || range.count !== Infinity) return 'draw-range';
  if (!mesh.frustumCulled) return 'frustum-culled-off';
  // three r186 flips a mesh's front face by its own world matrix only (`object.isMesh &&
  // matrixWorld.determinantAffine() < 0`), never per instance, and a batch's world matrix is the root's: an instance
  // must not mirror relative to the root. Under a mirrored root that excludes a mesh mirrored again (positive in the
  // world) and keeps one that is not (negative in the world).
  const determinant = mesh.matrixWorld.determinant();
  if ((root ? determinant * root.matrixWorld.determinant() : determinant) < 0) return 'mirrored';
  return null;
}

/**
 * Walks the graph and decides, per mesh, what the compiler may do with it. Every decision names its rule
 * so the ledger and the compile report can explain themselves. Updates world matrices first (mirroring check).
 */
export function classify(root: Object3D, options: ClassifyOptions = {}): Classification[] {
  const policy = options.policy ?? 'tagged';
  root.updateMatrixWorld(true);
  const animated = animatedRoots(root, options.animations ?? []);
  const result: Classification[] = [];
  root.traverse((object) => {
    const mesh = object as MeshLike;
    if (!mesh.isMesh) return;
    result.push({ object: mesh, ...decide(mesh, policy, animated, root) });
  });
  return result;
}

/** Objects targeted by any track of the given clips, resolved the way AnimationMixer does (name, uuid or path). */
export function animatedRoots(root: Object3D, sources: AnimationSource[]): Set<Object3D> {
  const roots = new Set<Object3D>();
  for (const source of sources) {
    const base = (source as { root?: Object3D }).root ?? root;
    const clips = (source as { clips?: AnimationClip[] }).clips ?? [source as AnimationClip];
    for (const clip of clips) {
      for (const track of clip.tracks) {
        const { nodeName } = PropertyBinding.parseTrackName(track.name);
        const node = nodeName ? PropertyBinding.findNode(base, nodeName) : base;
        if (node) roots.add(node as Object3D);
      }
    }
  }
  return roots;
}

function underBone(object: Object3D): boolean {
  let current: Object3D | null = object.parent;
  while (current) {
    if ((current as { isBone?: boolean }).isBone) return true;
    current = current.parent;
  }
  return false;
}

function underAnimated(object: Object3D, animated: Set<Object3D>): boolean {
  if (animated.size === 0) return false;
  let current: Object3D | null = object;
  while (current) {
    if (animated.has(current)) return true;
    current = current.parent;
  }
  return false;
}

function decide(mesh: MeshLike, policy: 'tagged' | 'auto', animated: Set<Object3D>, root: Object3D): { kind: MeshKind; rule: string } {
  if (mesh.isSkinnedMesh) return { kind: 'skinned', rule: 'skinned-mesh' };
  if (mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) return { kind: 'morph', rule: 'morph-targets' };
  if (isShader(mesh.material)) return { kind: 'unsupported', rule: 'shader-material' };
  const tag = effectiveTag(mesh);
  if (tag === 'dynamic') return { kind: 'dynamic', rule: 'tag:dynamic' };
  // Anything hanging off a bone (a weapon in a hand) moves with the rig, whatever its tag says.
  if (underBone(mesh)) return { kind: 'dynamic', rule: 'bone-parented' };
  if (underAnimated(mesh, animated)) return { kind: 'dynamic', rule: 'animated' };
  const excluded = exclusionRule(mesh, root);
  if (excluded) return { kind: 'excluded', rule: excluded };
  if (tag === 'static') return { kind: 'static', rule: 'tag:static' };
  if (policy === 'auto') return { kind: 'static', rule: 'auto' };
  return { kind: 'untagged', rule: 'untagged' };
}

