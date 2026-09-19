import {
  type BufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Material,
  type Object3D,
  Sprite,
  type Texture,
} from 'three';

/** Something that owns render targets and frees them itself: three's `ReflectorBaseNode` and its per-camera targets. */
export interface TargetOwner {
  dispose(): void;
}

export interface ResourceSets {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  textures: Set<Texture>;
  /** Owners of render targets noted under the subtree (`noteTargetOwner`); releasing the subtree disposes them. */
  targetOwners: Set<TargetOwner>;
}

export function emptyResourceSets(): ResourceSets {
  return { geometries: new Set(), materials: new Set(), textures: new Set(), targetOwners: new Set() };
}

const targetOwners = new WeakMap<Object3D, TargetOwner>();

/**
 * Files `owner` under `anchor`, an object of the scene graph, so that `collectResources` finds it from there. three
 * builds a reflector inside the shader and leaves only its `target` object in the graph: nothing a scene holds points
 * at the node, and `material.dispose()` never reaches its `dispose()`, so its targets outlive the mesh. An attached
 * ledger notes the reflectors it sees drawn.
 */
export function noteTargetOwner(anchor: Object3D, owner: TargetOwner): void {
  targetOwners.set(anchor, owner);
}

/**
 * Whether `texture` belongs to a render target. Such a texture is accounted for but never disposed alone: the target
 * is disposed, by whoever owns it.
 */
export function isRenderTargetTexture(texture: Texture): boolean {
  return texture.isRenderTargetTexture === true || texture.renderTarget != null;
}

let spriteGeometry: BufferGeometry | undefined;

/**
 * Whether `geometry` is the one three shares between every `Sprite` (module-level in Sprite.js): it belongs to no
 * scene, and sprites the caller knows nothing about draw it, so freeing a scene's resources leaves it.
 */
export function isSharedSpriteGeometry(geometry: BufferGeometry): boolean {
  spriteGeometry ??= new Sprite().geometry;
  return geometry === spriteGeometry;
}

const renewedBuffers = new WeakMap<InterleavedBuffer, InterleavedBuffer>();

function interleavedAttributes(geometry: BufferGeometry): [string, InterleavedBufferAttribute][] {
  return Object.entries(geometry.attributes).filter(
    (entry): entry is [string, InterleavedBufferAttribute] =>
      (entry[1] as InterleavedBufferAttribute).isInterleavedBufferAttribute === true,
  );
}

/**
 * `geometry.dispose()` that leaves the geometry drawable. three r186 cannot draw an interleaved geometry again after
 * a dispose: on WebGPU `WebGPUAttributeUtils.destroyAttribute` keeps the destroyed buffer's record under the
 * `InterleavedBuffer` and the next upload reuses it ("used in submit while destroyed"); on WebGL2
 * `Geometries.updateAttribute` skips every attribute after the first of a buffer it has seen before, so they get no
 * buffer back and the draw fails with INVALID_OPERATION, silently. Both key on object identity, so the interleaved
 * attributes are replaced by new ones over a new `InterleavedBuffer` on the same array; geometries that shared a
 * buffer share the new one. The old objects keep working for code that holds them: an old attribute reads the new
 * buffer, and the old buffer's version and update ranges are the new one's, so `needsUpdate` on either uploads.
 */
export function disposeGeometry(geometry: BufferGeometry): void {
  geometry.dispose();
  for (const [name, attribute] of interleavedAttributes(geometry)) {
    const old = attribute.data;
    let buffer = renewedBuffers.get(old);
    if (!buffer) {
      const instanced = old as InstancedInterleavedBuffer & { isInstancedInterleavedBuffer?: boolean };
      buffer = instanced.isInstancedInterleavedBuffer
        ? new InstancedInterleavedBuffer(old.array, old.stride, instanced.meshPerAttribute)
        : new InterleavedBuffer(old.array, old.stride);
      buffer.setUsage(old.usage);
      buffer.updateRanges = old.updateRanges;
      const live = buffer;
      Object.defineProperty(old, 'version', {
        get: () => live.version,
        set: (version: number) => {
          live.version = version;
        },
      });
      renewedBuffers.set(old, buffer);
    }
    attribute.data = buffer;
    const renewed = new InterleavedBufferAttribute(buffer, attribute.itemSize, attribute.offset, attribute.normalized);
    renewed.name = attribute.name;
    geometry.setAttribute(name, renewed);
  }
}

/**
 * Disposes each of `geometries` that nothing `inUse` still needs. `left` are the ones it left uploaded although they
 * are not in use themselves: the geometry every Sprite shares, and a geometry reading an `InterleavedBuffer` that one
 * in use reads too (GLTFLoader caches one buffer per accessor, so primitives reusing an accessor share it), since
 * disposing it would destroy the buffer under the geometry still drawn. Pass those back in with a later call: they go
 * once nothing in use shares their buffer. `drawnElsewhere` names geometries the caller does not manage but that are
 * drawn all the same (a scene's other meshes); it is asked only when one of `geometries` is interleaved.
 */
export function disposeGeometries(
  geometries: Iterable<BufferGeometry>,
  inUse: ReadonlySet<BufferGeometry>,
  drawnElsewhere: () => Iterable<BufferGeometry> = () => [],
): { disposed: number; left: BufferGeometry[] } {
  let readers: Map<InterleavedBuffer, Set<BufferGeometry>> | undefined;
  const readersOf = (buffer: InterleavedBuffer): Set<BufferGeometry> => {
    if (!readers) {
      readers = new Map();
      for (const g of [...inUse, ...drawnElsewhere()])
        for (const [, a] of interleavedAttributes(g)) readers.set(a.data, (readers.get(a.data) ?? new Set()).add(g));
    }
    return readers.get(buffer) ?? new Set();
  };
  // A reader other than the geometry itself: the same geometry drawn elsewhere is renewed along with this one.
  const sharesBufferInUse = (geometry: BufferGeometry): boolean =>
    interleavedAttributes(geometry).some(([, a]) => [...readersOf(a.data)].some((reader) => reader !== geometry));
  const left: BufferGeometry[] = [];
  let disposed = 0;
  for (const geometry of new Set(geometries)) {
    if (inUse.has(geometry)) continue;
    if (isSharedSpriteGeometry(geometry) || sharesBufferInUse(geometry)) {
      left.push(geometry);
      continue;
    }
    disposeGeometry(geometry);
    disposed++;
  }
  return { disposed, left };
}

/** Adds `value` when it is a texture: material properties, a scene's background and a mesh's internal maps all arrive untyped. */
function addTexture(value: unknown, into: Set<Texture>): void {
  if ((value as Texture | null)?.isTexture) into.add(value as Texture);
}

/** A TSL node as far as the scan reads it. */
interface NodeLike {
  isNode?: boolean;
  isTextureNode?: boolean;
  value?: unknown;
  getChildren?(): Iterable<NodeLike>;
}

/**
 * Textures held by the texture nodes under `node`. What an `Fn` creates does not exist until the shader is built, so
 * this finds what is held as a node beforehand (a slot's `texture(map)`, WaterMesh's `waterNormals`); the ledger adds
 * what the draws bind.
 */
function nodeTextures(node: NodeLike, into: Set<Texture>, seen: Set<NodeLike>): void {
  const pending = [node];
  for (let next = pending.pop(); next; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (next.isTextureNode) addTexture(next.value, into);
    for (const child of next.getChildren?.() ?? []) pending.push(child);
  }
}

/** Texture properties of `holder`, and the textures of the nodes it holds. */
function heldTextures(holder: object, into: Set<Texture>, seen: Set<NodeLike>): void {
  for (const value of Object.values(holder)) {
    addTexture(value, into);
    if ((value as NodeLike | null)?.isNode) nodeTextures(value as NodeLike, into, seen);
  }
}

function texturesOf(material: Material, into: Set<Texture>, seen: Set<NodeLike>): void {
  heldTextures(material, into, seen);
  // Node materials sample textures through TSL nodes the properties do not show; modules list them here (AnimatedInstances does).
  const extra = material.userData.forgeTextures as unknown;
  if (Array.isArray(extra)) for (const t of extra) addTexture(t, into);
}

/**
 * Every geometry, material and texture reachable from `root`: material properties and the texture nodes a material
 * or a node-material mesh holds, node textures listed in `material.userData.forgeTextures`, a BatchedMesh's
 * matrix/indirect/colour textures, a skeleton's bone texture, and for a Scene its background and environment; and the
 * render-target owners noted under it. Reaching a texture is not owning it: see `isRenderTargetTexture`.
 */
export function collectResources(root: Object3D, into: ResourceSets = emptyResourceSets()): ResourceSets {
  // A material shared by thousands of meshes has its properties read once per call. Only materials seen in this call
  // are skipped: one already in `into` is read again (`ResourceTracker.track(material)` files it without its textures).
  const seen = new Set<Material>();
  const seenNodes = new Set<NodeLike>();
  const addMaterial = (material: Material): void => {
    if (seen.has(material)) return;
    seen.add(material);
    into.materials.add(material);
    texturesOf(material, into.textures, seenNodes);
  };
  root.traverse((o) => {
    const mesh = o as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
      isBatchedMesh?: boolean;
      _matricesTexture?: Texture | null;
      _indirectTexture?: Texture | null;
      _colorsTexture?: Texture | null;
      isSkinnedMesh?: boolean;
      skeleton?: { boneTexture?: Texture | null };
    };
    if (mesh.geometry) into.geometries.add(mesh.geometry);
    if (mesh.isBatchedMesh)
      for (const t of [mesh._matricesTexture, mesh._indirectTexture, mesh._colorsTexture]) addTexture(t, into.textures);
    if (mesh.isSkinnedMesh) addTexture(mesh.skeleton?.boneTexture, into.textures);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) addMaterial(m);
    } else if (material) {
      addMaterial(material);
      // A mesh built around a node material keeps nodes of its own (WaterMesh's `waterNormals`). Only such a mesh is
      // read: every other object of a large scene would be enumerated for nothing.
      if ((material as { isNodeMaterial?: boolean }).isNodeMaterial) heldTextures(o, into.textures, seenNodes);
    }
    const owner = targetOwners.get(o);
    if (owner) into.targetOwners.add(owner);
  });
  const scene = root as Object3D & { isScene?: boolean; background?: unknown; environment?: unknown };
  if (scene.isScene) for (const value of [scene.background, scene.environment]) addTexture(value, into.textures);
  return into;
}

/**
 * Resources the renderer still holds (`renderer.info.memory` counts) that the scene no longer references: what was
 * removed without `dispose()`. `allowance` is what the renderer allocates for itself (render-target textures).
 */
export function unreferencedResources(
  info: { geometries: number; textures: number },
  scene: Object3D,
  allowance: { geometries?: number; textures?: number } = {},
): { geometries: number; textures: number } {
  const reachable = collectResources(scene);
  return {
    geometries: Math.max(0, info.geometries - reachable.geometries.size - (allowance.geometries ?? 0)),
    textures: Math.max(0, info.textures - reachable.textures.size - (allowance.textures ?? 0)),
  };
}
