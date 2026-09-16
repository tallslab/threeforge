import { REVISION, type Camera, type Light, type Material, type Object3D, type Scene } from 'three';
import { MaterialRegistry, type MaterialHashes } from '../registry/MaterialRegistry.js';
import { expectedGpuDraws, sideFactor, writeInstanceCounts, type BackendInfo } from './expectedDraws.js';
import { flagsInto, isVsmBlur, kindOf, reasonOf, type Reason } from './reasons.js';
import { DisplayNames, type PathCache } from './names.js';
import { budgetsFor, type Budgets } from './budgets.js';
import { Vector2 } from 'three';
import { hintsFor, type HintContext } from './hints.js';
import { estimateMemory } from './memory.js';
import { disposeOverdraw, measureOverdraw, overdrawTargetOf, type OverdrawRenderer, type OverdrawResult } from './overdraw.js';
import { formatCostRows, formatHints } from '../overlay/index.js';
import { FORGE_TAG_KEY } from '../tags.js';
import { lightInfoOf, type LightInfo } from './sections.js';
import { shadowPassIds } from './shadowPasses.js';
import { buildFrame, emptyFrame, emptySections, type BudgetResult, type FrameEnv, type FrameSnapshot, type JsSnapshot, type MemorySnapshot, type SubmissionRecord, type Tier } from './snapshot.js';

/** The slice of three's common Renderer the ledger patches and reads. Structural so tests can fake it. */
export interface LedgerRenderer {
  render(scene: Scene, camera: Camera): unknown;
  renderObject(...args: unknown[]): unknown;
  info: {
    render: { drawCalls: number; triangles: number };
    memory: { programs: number; textures?: number; geometries?: number; texturesSize?: number; attributesSize?: number; indexAttributesSize?: number; renderTargets?: number; total?: number };
    /** Info.createTexture and destroyTexture: wrapped while attached to count three's DFG_LUT (see `attach`). */
    createTexture?(texture: unknown): void;
    destroyTexture?(texture: unknown): void;
  };
  /** `renderer.shadowMap`: its type tells the memory section whether built maps hold VSM blur targets. */
  shadowMap?: { type?: number };
  backend?: unknown;
  getRenderTarget?(): { name?: string; texture?: { name?: string } } | null;
  /** Drawing-buffer size in pixels; `overdraw.pixels` stays 0 without it. */
  getDrawingBufferSize?(target: Vector2): Vector2;
}

interface BackendLike {
  isWebGPUBackend?: boolean;
  hasFeature?(name: string): boolean;
}

export interface DrawCallLedgerOptions {
  registry?: MaterialRegistry;
  /** Clock for the js section (defaults to `performance.now`). */
  now?: () => number;
  /** Per-tier budget overrides for the hints. */
  budgets?: Partial<Budgets>;
}

/** Scene-graph statistics recounted at most every RESCAN_EVERY frames (a full traversal). */
const _bufferSize = new Vector2();
const RESCAN_EVERY = 60;
/** Layer 31 mask, where World parks batched originals. */
const HIDDEN_MASK = (1 << 31) >>> 0;
const FRAME_WINDOW = 60;

/** One `render()` call. The outermost call of a frame is `main`; nested calls are passes of it. */
interface RenderContext {
  root: Object3D;
  pass: string;
  /** The display-name cache of `root`. */
  paths: PathCache;
  /** A shadow-map render: its scene submissions are shadow casters. */
  shadow: boolean;
}

/** A light as the ledger's walk reads it. */
type WalkedLight = Light & { isPointLight?: boolean; shadow?: { camera?: Camera; mapSize: { x: number; y: number } } };

/** A shadow-casting light walked this frame, and the pass id its shadow map renders under. */
interface ShadowPass {
  light: WalkedLight;
  id: string;
}

/**
 * Submission records, reused frame after frame. The ledger keeps two: the frame in progress writes one while the last
 * completed frame's items stay intact in the other, so a read between or inside frames never sees a half-written frame.
 */
interface RecordBuffer {
  /** Every record this buffer has created, in acquisition order; never shrinks. */
  records: SubmissionRecord[];
  /** The records filed this frame, in filing order (a pass nested inside a draw files before that draw). */
  items: SubmissionRecord[];
  acquired: number;
}

interface FrameState {
  mainScene: Object3D | null;
  buffer: RecordBuffer;
  /** Items filed into `buffer.items` so far. */
  count: number;
  /** programHash → the type and description of the first item filed with it. */
  descriptions: Map<string, { type: string; description: string }>;
  drawCallsStart: number;
  trianglesStart: number;
  /** Shadow camera → its light and pass id, for every world-visible shadow-casting light this frame's walks found. */
  shadowCameras: Map<Camera, ShadowPass>;
  /** The shadow pass ids given out this frame, across scenes. */
  shadowIds: Set<string>;
  /** Σ mapSize.x · mapSize.y · faces over the lights whose shadow map rendered this frame, each light once. */
  shadowTexels: number;
  /** Distinct objects drawn into a shadow map this frame. */
  shadowCasters: number;
  /** The last shadow-map pass entered: three renders a map's VSM blur quads right after the map. */
  lastShadowPass: string | null;
  scannedScenes: Set<Object3D>;
  nestedScenes: number;
  skeletons: Map<unknown, number>;
  /** The main scene's world-visible lights from this frame's walk: the lighting section's fallback. */
  visibleLights: Light[];
  /** The lights three projected for the main pass (`lightsNode.getLights()`), or null when none was read. */
  lights: LightInfo[] | null;
  /** The first main-pass scene submission was seen: its lights node read, or found missing. */
  lightsRead: boolean;
  startedAt: number;
}

/**
 * A canonical material's marks for the frame in progress: one per material the ledger has seen, reused frame after frame
 * and reset when first read in a new frame. It holds no material or object, so a mark outliving its frame retains nothing.
 */
interface MaterialMark {
  /** The `frameStamp` the fields below belong to. */
  frame: number;
  /** `SubmissionRecord.material`: the order this frame first drew the material in. */
  index: number;
  /** The `Object3D.id` of the first object that drew the material in this frame's main pass, or -1. */
  user: number;
  /** Another object drew it in this frame's main pass too. */
  shared: boolean;
}

/** A blank record; the property order is `SubmissionRecord`'s, which `frame({ items: true })` copies. */
function newRecord(): SubmissionRecord {
  return { name: '', kind: 'other', material: 0, materialType: '', programHash: '', variantHash: '', transparent: false, pass: '', reason: 'unclassified', flags: [], expectedGpuDraws: 0, instances: 0, instancesDrawn: 0, vertices: 0, bones: 0, skeleton: null, morphTargets: 0 };
}

function acquire(buffer: RecordBuffer): SubmissionRecord {
  if (buffer.acquired === buffer.records.length) buffer.records.push(newRecord());
  return buffer.records[buffer.acquired++]!;
}

/**
 * Attributes every render item to a reason. Patches `renderObject` and `render` on the renderer instance: every
 * render-object function three installs (including ShadowNode's) ends in `renderer.renderObject`, so this sees main,
 * shadow and post-processing passes without composing `setRenderObjectFunction`.
 * The outermost `render()` call is a frame; nested calls are passes of it. `renderAsync` needs no patch: three r186's
 * awaits `init()` and then calls `this.render()`.
 *
 * The per-submission path allocates nothing in a steady scene: records are pooled, material hashes are read from the
 * registry's key cache once per material per frame, display names come from a validated cache, and a frame walks
 * each scene once (docs/threeforge.md section 4, "Overhead").
 */
export class DrawCallLedger {
  readonly registry: MaterialRegistry;
  private renderer: LedgerRenderer | null = null;
  private originals: { render: LedgerRenderer['render']; renderObject: LedgerRenderer['renderObject'] } | null = null;
  private depth = 0;
  private current: FrameState | null = null;
  private readonly contexts: RenderContext[] = [];
  private last: FrameSnapshot;
  private lastItems: SubmissionRecord[] = [];
  private readonly buffers: [RecordBuffer, RecordBuffer] = [
    { records: [], items: [], acquired: 0 },
    { records: [], items: [], acquired: 0 },
  ];
  /** The buffer the next frame writes: never the one holding `lastItems`. */
  private write = 0;
  private readonly names = new DisplayNames();
  /** This frame's registry reads, by material; cleared at frame boundaries and whenever `registry.keysRevision` moves. */
  private readonly hashes = new Map<Material, MaterialHashes>();
  private hashesRevision = -1;
  private lastMaterial: Material | null = null;
  private lastHashes: MaterialHashes | null = null;
  private readonly annotations = new WeakMap<Object3D, Reason>();
  /** Frames entered: the marks below compare against it, so nothing is cleared between frames. */
  private frameStamp = 0;
  /** The frame each object was last counted as a shadow caster in. */
  private readonly casterFrames = new WeakMap<Object3D, number>();
  /** The frame each light's shadow-map texels were last counted in. */
  private readonly shadowMapFrames = new WeakMap<Light, number>();
  /** Canonical material → its marks (`MaterialMark`): main-pass users and `SubmissionRecord.material`. */
  private readonly materialMarks = new WeakMap<Material, MaterialMark>();
  /** This frame's marks by index; entries from `markCount` on are earlier frames' and never read. */
  private readonly frameMarks: MaterialMark[] = [];
  private markCount = 0;
  private backendInfo: BackendInfo = { backend: 'unknown', multiDraw: false };
  private environment: { tier: Tier; gpu: string; dpr: number; viewport: [number, number] } = { tier: 'desktop', gpu: 'unknown', dpr: 1, viewport: [0, 0] };
  private readonly now: () => number;
  private readonly frameStarts: number[] = [];
  private framesSeen = 0;
  private lastScene: Object3D | null = null;
  private graphStats: { objects: number; autoUpdatedMatrices: number; hiddenOriginals: number; at: number } = { objects: 0, autoUpdatedMatrices: 0, hiddenOriginals: 0, at: -1 };
  private scheduler: { skippedRecently(): number } | null = null;
  private streamer: { stats(): { chunks: number; resident: number } } | null = null;
  private memoryStats: MemorySnapshot = emptySections().memory;
  /** Live DFG_LUT textures three created on the attached renderer (see `wrapTextureInfo`). */
  private readonly internalTextures = new Set<object>();
  private textureInfo: { info: LedgerRenderer['info']; create: (texture: unknown) => void; destroy: (texture: unknown) => void; own: { create: boolean; destroy: boolean } } | null = null;
  private hintContext: HintContext = {};
  private overdraw: OverdrawResult | null = null;
  private paused = false;
  private readonly budgetOverrides: Partial<Budgets>;

  constructor(options: DrawCallLedgerOptions = {}) {
    this.registry = options.registry ?? new MaterialRegistry();
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.budgetOverrides = options.budgets ?? {};
    this.last = emptyFrame(this.env());
  }

  /**
   * Patches `render` and `renderObject` to attribute every draw, and wraps `renderer.info.createTexture` and
   * `destroyTexture` (calling three's own with the same `this` and arguments) to count three's `DFG_LUT` texture for the
   * memory section: three r186 creates it the first time a lit Standard or Physical material builds and holds it with
   * nothing in the scene reaching it. A LUT three created before `attach()` is not seen. `detach()` restores all four.
   */
  attach(renderer: LedgerRenderer): void {
    if (this.renderer) this.detach();
    this.renderer = renderer;
    this.backendInfo = detectBackend(renderer);
    this.last = emptyFrame(this.env());
    // A detach() from inside a draw leaves the running render wrapper's exit() to take depth below 0.
    this.depth = 0;
    const originals = { render: renderer.render, renderObject: renderer.renderObject };
    this.originals = originals;
    const ledger = this;

    // `arguments` forwards exactly what three passed without copying it into a rest array on every call.
    renderer.renderObject = function (this: LedgerRenderer, object: Object3D, scene: Scene, _camera: Camera, _geometry: unknown, material: Material, group: unknown, lightsNode: unknown) {
      // Paused: an overdraw count render, possibly inside a draw of the open frame (a measurement from a render hook).
      if (ledger.depth === 0 || ledger.current === null || ledger.paused) return originals.renderObject.apply(this, arguments as unknown as unknown[]);
      const hashes = ledger.hashesOf(material);
      // Read before the call: three puts the override material's side back as renderObject returns.
      const sides = sideFactor(material, scene);
      const record = ledger.begin(object, material, group, hashes, sides, lightsNode);
      const result = originals.renderObject.apply(this, arguments as unknown as unknown[]);
      // Draw state is read after the call returns: BatchedMesh fills `_multiDrawCount` in its onBeforeRender (a sprite
      // batch its `instanceCount`), and a pass nested inside this draw (the shadow map a receiver triggers) restores the
      // counts it changed as it ends.
      ledger.file(record, object, sides, hashes);
      return result;
    };
    renderer.render = function (this: LedgerRenderer, scene: Scene, camera: Camera) {
      ledger.enter(scene, camera);
      try {
        return originals.render.call(this, scene, camera);
      } finally {
        ledger.exit();
      }
    };
    this.wrapTextureInfo(renderer);
    // `renderAsync` stays three's own. r186's is `await this.init(); this.render(scene, camera);`, so its frame enters the
    // wrapper above once, after the await, and every enter() is paired with an exit() inside one synchronous call. A wrapper
    // of its own opened the frame before the await: the render inside became a nested pass, and any render() made during
    // the await merged into that frame.
  }

  detach(): void {
    if (!this.renderer || !this.originals) return;
    this.renderer.render = this.originals.render;
    this.renderer.renderObject = this.originals.renderObject;
    this.unwrapTextureInfo();
    disposeOverdraw(this.renderer);
    this.renderer = null;
    this.originals = null;
    this.depth = 0;
    this.current = null;
    this.contexts.length = 0;
    this.clearHashes();
  }

  /**
   * three r186 nodes/functions/BSDF/DFGLUT.js keeps its 16 x 16 RG half-float lookup texture in a module variable that
   * nothing exports (`three/tsl` exports the TSL function only), creates it on the first shader build that samples it and
   * never disposes it. Info.createTexture and destroyTexture see every texture three uploads and destroys, so the live
   * LUTs are counted by three's name for it, `DFG_LUT`, on a DataTexture.
   */
  private wrapTextureInfo(renderer: LedgerRenderer): void {
    const info = renderer.info;
    const create = info.createTexture;
    const destroy = info.destroyTexture;
    this.internalTextures.clear();
    if (typeof create !== 'function' || typeof destroy !== 'function') return;
    const internal = this.internalTextures;
    const own = { create: Object.prototype.hasOwnProperty.call(info, 'createTexture'), destroy: Object.prototype.hasOwnProperty.call(info, 'destroyTexture') };
    info.createTexture = function (this: unknown, texture: unknown) {
      const t = texture as { name?: string; isDataTexture?: boolean } | null;
      if (t && t.isDataTexture === true && t.name === 'DFG_LUT') internal.add(t);
      return create.apply(this, arguments as unknown as [unknown]);
    };
    info.destroyTexture = function (this: unknown, texture: unknown) {
      internal.delete(texture as object);
      return destroy.apply(this, arguments as unknown as [unknown]);
    };
    this.textureInfo = { info, create, destroy, own };
  }

  private unwrapTextureInfo(): void {
    const wrapped = this.textureInfo;
    this.textureInfo = null;
    this.internalTextures.clear();
    if (!wrapped) return;
    // three's own are prototype methods: removing the wrappers exposes them again; a renderer's own methods are put back.
    if (wrapped.own.create) wrapped.info.createTexture = wrapped.create;
    else delete wrapped.info.createTexture;
    if (wrapped.own.destroy) wrapped.info.destroyTexture = wrapped.destroy;
    else delete wrapped.info.destroyTexture;
  }

  /** Describe the device and canvas for the snapshot's `env` (the harness and the bench page call this once). */
  setEnvironment(env: Partial<{ tier: Tier; gpu: string; dpr: number; viewport: [number, number] }>): void {
    this.environment = { ...this.environment, ...env };
    this.last = { ...this.last, env: this.env() };
  }

  /**
   * Recount the scene-graph statistics of the js section now (objects, matrices three updates every frame).
   * Runs on its own every 60 frames; call it after large scene changes.
   */
  rescan(): void {
    const scene = this.current?.mainScene ?? this.lastScene;
    if (!scene) return;
    let objects = 0;
    let auto = 0;
    let hidden = 0;
    const ctx: Required<Omit<HintContext, 'items'>> = { staticAutoUpdated: [], pointShadowLights: [], transmissive: [] };
    const paths = this.names.forRoot(scene);
    scene.traverse((o) => {
      objects++;
      if (o.layers.mask === HIDDEN_MASK) hidden++;
      if (o.matrixAutoUpdate && o.matrixWorldAutoUpdate) {
        auto++;
        if ((o.userData as Record<string, unknown>)[FORGE_TAG_KEY] === 'static' && (o as { isMesh?: boolean }).isMesh) ctx.staticAutoUpdated.push(this.names.of(o, scene, paths));
      }
      const light = o as Light & { isPointLight?: boolean };
      if (light.isLight && light.isPointLight && light.castShadow && light.visible) ctx.pointShadowLights.push(this.names.of(o, scene, paths));
      const material = (o as { material?: Material | Material[] }).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        if (((m as Material & { transmission?: number }).transmission ?? 0) > 0) {
          ctx.transmissive.push(this.names.of(o, scene, paths));
          break;
        }
      }
    });
    this.hintContext = ctx;
    // The scene object itself is not part of the count.
    this.graphStats = { objects: objects - 1, autoUpdatedMatrices: auto - 1, hiddenOriginals: hidden, at: this.framesSeen };
    const memory = this.renderer?.info.memory;
    const info = { textures: memory?.textures ?? 0, geometries: memory?.geometries ?? 0, texturesSize: memory?.texturesSize, attributesSize: memory?.attributesSize, indexAttributesSize: memory?.indexAttributesSize, renderTargets: memory?.renderTargets, total: memory?.total };
    // The overdraw count target is the renderer's own, held while nothing in the scene reaches it.
    this.memoryStats = estimateMemory(scene, info, this.environment.viewport, {
      renderTargets: [this.renderer ? overdrawTargetOf(this.renderer) : null],
      internalTextures: this.internalTextures.size,
      shadowMapType: this.renderer?.shadowMap?.type,
    });
    this.last = { ...this.last, js: { ...this.last.js, objects: this.graphStats.objects, autoUpdatedMatrices: this.graphStats.autoUpdatedMatrices, hiddenOriginals: this.graphStats.hiddenOriginals }, memory: this.memoryNow() };
    this.last = { ...this.last, hints: hintsFor(this.last, this.budgets(), { ...this.hintContext, items: this.lastItems }) };
  }

  /** A RenderScheduler whose skipped ticks the js section reports; null detaches. */
  attachScheduler(scheduler: { skippedRecently(): number } | null): void {
    this.scheduler = scheduler;
  }

  /** The last estimate with the attached streamer's residency read live (its stats are cheap; the traversal is not). */
  private memoryNow(): MemorySnapshot {
    if (!this.streamer) return this.memoryStats;
    const s = this.streamer.stats();
    return { ...this.memoryStats, chunks: { total: s.chunks, resident: s.resident } };
  }

  /** A Streamer whose chunk residency the memory section reports; null detaches. */
  attachStreamer(streamer: { stats(): { chunks: number; resident: number } } | null): void {
    this.streamer = streamer;
  }

  /** The budgets hints are judged against: the environment's tier plus constructor overrides. */
  budgets(): Budgets {
    return budgetsFor(this.environment.tier, this.budgetOverrides);
  }

  /**
   * Measure overdraw (fragments per pixel, opaque and transparent) with two low-resolution count renders; the
   * result rides along in every following `frame()` until the next measurement. The count renders are not frames, nor
   * passes of a frame still open around the call. The count target and material are released by `detach()`.
   */
  async measureOverdraw(scene: Scene, camera: Camera, options: { scale?: number } = {}): Promise<OverdrawResult> {
    if (!this.renderer) throw new Error('attach a renderer first');
    // measureOverdraw() renders both counts and restores the renderer before it first awaits, so attribution pauses for that
    // synchronous part only. A render still open around the call (a render hook measuring) then exits the ledger normally,
    // and a render made while the read-backs are pending (the app's next frame) is a frame of its own. A call from a hook
    // the count render runs again finds the ledger already paused and gets the measurement in progress, drawing nothing:
    // it restores `wasPaused` (still paused) and adds a zero draw-call delta.
    let pending: Promise<OverdrawResult>;
    const wasPaused = this.paused;
    const open = this.current;
    const info = this.renderer.info.render;
    const drawCalls = info.drawCalls;
    const triangles = info.triangles;
    this.paused = true;
    try {
      pending = measureOverdraw(this.renderer as unknown as OverdrawRenderer, scene, camera, options);
    } finally {
      this.paused = wasPaused;
      // three's info counted the count draws: keep them out of the open frame's reportedDrawCalls, triangles and unattributed.
      if (open !== null && this.current === open) {
        open.drawCallsStart += info.drawCalls - drawCalls;
        open.trianglesStart += info.triangles - triangles;
      }
    }
    this.overdraw = await pending;
    this.last = { ...this.last, overdraw: { ...this.last.overdraw, ...this.overdraw, measured: true } };
    return this.overdraw;
  }

  /** Recount and return the memory estimate now. */
  measureMemory(): MemorySnapshot {
    this.rescan();
    return this.last.memory;
  }

  /** Let the compiler explain why it left a mesh alone; shows up as that submission's reason. */
  annotate(object: Object3D, reason: Reason): void {
    this.annotations.set(object, reason);
  }

  /** The last completed frame. `items: true` adds copies of its records: they stay valid however long they are held. */
  frame(options: { items?: boolean } = {}): FrameSnapshot {
    return options.items ? { ...this.last, items: this.lastItems.map((i) => ({ ...i, flags: [...i.flags] })) } : this.last;
  }

  budget(options: { maxSubmissions: number }): BudgetResult {
    const actual = this.last.totals.sceneSubmissions;
    const offenders = Object.entries(this.last.byReason)
      .filter(([reason]) => reason !== 'renderer-internal')
      .map(([reason, r]) => ({ reason, submissions: r.submissions, top: [...r.top] }))
      .sort((a, b) => b.submissions - a.submissions || a.reason.localeCompare(b.reason));
    return { pass: actual <= options.maxSubmissions, actual, max: options.maxSubmissions, offenders };
  }

  report(): string {
    const f = this.last;
    const t = f.totals;
    const lines = [
      `threeforge ledger [${f.env.backend}${f.env.multiDraw ? ', multi-draw' : ''}]: ${t.sceneSubmissions} scene submissions (${t.submissions} total), ${t.gpuDraws} gpu draws, ${t.unattributed} unattributed, ${t.programSwitches} program switches, ${t.programs} programs`,
    ];
    for (const row of formatCostRows(f)) lines.push(`  ${row}`);
    const reasons = Object.entries(f.byReason).sort(([, a], [, b]) => b.submissions - a.submissions);
    for (const [reason, r] of reasons) {
      lines.push(`  ${reason.padEnd(24)} ${String(r.submissions).padStart(5)}   ${r.top.join(', ')}${r.submissions > r.top.length ? ', …' : ''}`);
    }
    if (f.passes.length > 1) lines.push(`  passes: ${f.passes.map((p) => `${p.id}=${p.submissions}`).join(', ')}`);
    for (const hint of formatHints(f)) lines.push(`  ${hint}`);
    return lines.join('\n');
  }

  private env(): FrameEnv {
    return { three: REVISION, backend: this.backendInfo.backend, multiDraw: this.backendInfo.multiDraw, ...this.environment, viewport: [...this.environment.viewport] as [number, number] };
  }

  private enter(scene: Object3D, camera: Camera): void {
    if (this.paused) return;
    if (this.depth === 0 && this.renderer) {
      const buffer = this.buffers[this.write]!;
      buffer.acquired = 0;
      this.clearHashes();
      this.current = {
        mainScene: null,
        buffer,
        count: 0,
        descriptions: new Map(),
        drawCallsStart: this.renderer.info.render.drawCalls,
        trianglesStart: this.renderer.info.render.triangles,
        shadowCameras: new Map(),
        shadowIds: new Set(),
        shadowTexels: 0,
        shadowCasters: 0,
        lastShadowPass: null,
        scannedScenes: new Set(),
        nestedScenes: 0,
        skeletons: new Map(),
        visibleLights: [],
        lights: null,
        lightsRead: false,
        startedAt: this.now(),
      };
      this.frameStamp++;
      // Material marks reset lazily against frameStamp; the frame's indices start again at 0.
      this.markCount = 0;
      this.frameStarts.push(this.current.startedAt);
      if (this.frameStarts.length > FRAME_WINDOW + 1) this.frameStarts.shift();
    }
    const state = this.current!;
    const isScene = (scene as Scene).isScene === true;
    if (isScene && !state.scannedScenes.has(scene)) {
      state.scannedScenes.add(scene);
      this.walkLights(state, scene);
    }
    let pass: string;
    let shadow = false;
    const shadowPass = state.shadowCameras.get(camera);
    if (shadowPass) {
      pass = shadowPass.id;
      shadow = true;
      state.lastShadowPass = pass;
      const light = shadowPass.light;
      // A light's texels count once per frame: a point light renders its six faces with one camera, and three renders a
      // map again for each other camera of the frame (ShadowNode keys its once-per-frame check by camera).
      if (light.shadow && this.shadowMapFrames.get(light) !== this.frameStamp) {
        this.shadowMapFrames.set(light, this.frameStamp);
        state.shadowTexels += light.shadow.mapSize.x * light.shadow.mapSize.y * (light.isPointLight ? 6 : 1);
      }
    } else if (state.lastShadowPass !== null && isVsmBlur(scene)) {
      // ShadowNode.vsmPass blurs the map it just rendered with two quads, each its own render() call.
      pass = `${state.lastShadowPass}:vsm`;
    } else if ((scene as Scene).overrideMaterial) pass = 'override';
    else if (!isScene) pass = 'fullscreen';
    else if (state.mainScene === null) {
      state.mainScene = scene;
      pass = 'main';
    } else if (state.mainScene === scene) {
      // A nested render of the main scene: reflections, portals, picking passes. Name it after its target.
      const target = this.renderer?.getRenderTarget?.();
      const name = target?.texture?.name || target?.name;
      pass = `nested:${name || ++state.nestedScenes}`;
    } else pass = `scene:${scene.name || ++state.nestedScenes}`;
    this.contexts.push({ root: scene, pass, paths: this.names.forRoot(scene), shadow });
    this.depth++;
  }

  private exit(): void {
    if (this.paused) return;
    this.depth--;
    this.contexts.pop();
    if (this.depth > 0 || !this.current || !this.renderer) return;
    // The frame's render() is over: from here on the time is the ledger's own filing work (js.ledgerMs), not render time.
    const renderEnd = this.now();
    const state = this.current;
    const items = state.buffer.items;
    if (items.length !== state.count) items.length = state.count;
    // One pass over the frame's items, before anything reads their reasons (the rescan's hints included).
    const marks = this.frameMarks;
    let transparentSubmissions = 0;
    let particles = 0;
    for (const i of items) {
      // Drawn alone is `unique-material` only while no other object of the main pass draws the material; every pass's
      // record of the object follows, since its index names the same mark.
      if (i.reason === 'unique-material' && marks[i.material]!.shared) i.reason = 'static-unbatched';
      if (i.pass !== 'main') continue;
      if (i.transparent && i.reason !== 'renderer-internal') transparentSubmissions++;
      particles += i.kind === 'points' ? i.vertices : i.reason === 'sprite-batch' ? i.instances : i.kind === 'sprite' ? 1 : 0;
    }
    this.lastItems = items;
    this.write = state.buffer === this.buffers[0] ? 1 : 0;
    this.clearHashes();
    this.framesSeen++;
    this.lastScene = state.mainScene;
    if (this.graphStats.at < 0 || this.framesSeen - this.graphStats.at >= RESCAN_EVERY) this.rescan();
    const intervals: number[] = [];
    for (let i = 1; i < this.frameStarts.length; i++) intervals.push(this.frameStarts[i]! - this.frameStarts[i - 1]!);
    intervals.sort((a, b) => a - b);
    const frameMs = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0;
    const js: JsSnapshot = { renderMs: renderEnd - state.startedAt, ledgerMs: 0, frameMs, objects: this.graphStats.objects, autoUpdatedMatrices: this.graphStats.autoUpdatedMatrices, hiddenOriginals: this.graphStats.hiddenOriginals, skipped: this.scheduler?.skippedRecently() ?? 0 };
    this.last = buildFrame({
      env: this.env(),
      items,
      reportedDrawCalls: this.renderer.info.render.drawCalls - state.drawCallsStart,
      triangles: this.renderer.info.render.triangles - state.trianglesStart,
      programs: this.renderer.info.memory.programs,
      descriptions: state.descriptions,
      // What three projected for the main pass, else the main scene's world-visible lights.
      lights: state.lights ?? state.visibleLights.map((light) => lightInfoOf(light)),
      shadows: { texels: state.shadowTexels, casters: state.shadowCasters },
      js,
      memory: this.memoryNow(),
      overdraw: {
        opaque: this.overdraw?.opaque ?? 0,
        transparent: this.overdraw?.transparent ?? 0,
        transparentSubmissions,
        particles,
        pixels: this.renderer.getDrawingBufferSize ? (() => { const s = this.renderer.getDrawingBufferSize!(_bufferSize); return s.x * s.y; })() : 0,
        measured: this.overdraw !== null,
      },
    });
    this.last.hints = hintsFor(this.last, this.budgets(), { ...this.hintContext, items });
    this.current = null;
    // `js` is this frame's own object (buildFrame keeps it): no earlier snapshot shares it.
    js.ledgerMs = this.now() - renderEnd;
  }

  /**
   * The frame's one walk of a scene, over world-visible objects only (three's render lists skip a hidden subtree, lights
   * included). It gives every shadow-casting light's shadow camera a pass id, and keeps the main scene's lights for the
   * lighting section in case no renderObject call brings a lights node.
   */
  private walkLights(state: FrameState, scene: Object3D): void {
    const main = state.mainScene === null;
    // Scenes walked before the frame has a main scene (an outermost override render) are candidates in turn: the last one
    // walked is the one the main pass draws, so its lights replace theirs instead of adding to them.
    if (main) state.visibleLights.length = 0;
    let casting: WalkedLight[] | null = null;
    scene.traverseVisible((o) => {
      const light = o as WalkedLight;
      if (!light.isLight) return;
      if (main) state.visibleLights.push(light);
      if (light.castShadow && light.shadow?.camera) (casting ??= []).push(light);
    });
    if (casting === null) return;
    const lights: WalkedLight[] = casting;
    // The naming rules are `shadowPassIds` (shadowPasses.ts), which also files the ids it hands out in `shadowIds`.
    // Only the frame state stays here: which ids the frame has taken, and the camera each pass renders with.
    const ids = shadowPassIds(lights, state.shadowIds);
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i]!;
      state.shadowCameras.set(light.shadow!.camera!, { light, id: ids[i]! });
    }
  }

  /**
   * The lights three projected for the main pass: renderObject's lights node (argument 7), filled by RenderList.finish
   * before the first draw. Read once per frame; without a `getLights()` the frame keeps the walk's world-visible lights.
   */
  private readLights(state: FrameState, lightsNode: unknown): void {
    state.lightsRead = true;
    const lights = (lightsNode as { getLights?(): Light[] } | null | undefined)?.getLights?.();
    if (!Array.isArray(lights)) return;
    // Copied now: three reuses the array for the next render of this scene and camera.
    const infos: LightInfo[] = [];
    for (let i = 0; i < lights.length; i++) infos.push(lightInfoOf(lights[i]!));
    state.lights = infos;
  }

  /** The registry's cached hashes for `material`, read at most once per material per frame (`hashesOf`, R6). */
  private hashesOf(material: Material): MaterialHashes {
    const revision = this.registry.keysRevision;
    if (revision !== this.hashesRevision) {
      // invalidate() or forget() dropped cached keys: read every material again, even mid-frame.
      this.clearHashes();
      this.hashesRevision = revision;
    } else if (material === this.lastMaterial) {
      return this.lastHashes!;
    }
    let hashes = this.hashes.get(material);
    if (hashes === undefined) {
      hashes = this.registry.hashesOf(material);
      this.hashes.set(material, hashes);
    }
    this.lastMaterial = material;
    this.lastHashes = hashes;
    return hashes;
  }

  /** Between frames nothing here holds a material. */
  private clearHashes(): void {
    this.hashes.clear();
    this.lastMaterial = null;
    this.lastHashes = null;
  }

  /**
   * This frame's marks of `material`'s canonical (the registry's, else the instance itself): identity, not hashes, so
   * materials the registry keeps apart (instance functions, own data) stay apart. Two lookups per submission; nothing is
   * allocated once a material has been seen, and a new frame resets a mark on its first read.
   */
  private markOf(material: Material): MaterialMark {
    const canonical = this.registry.canonicalOf(material) ?? material;
    let mark = this.materialMarks.get(canonical);
    if (mark === undefined) {
      mark = { frame: -1, index: 0, user: -1, shared: false };
      this.materialMarks.set(canonical, mark);
    }
    if (mark.frame !== this.frameStamp) {
      mark.frame = this.frameStamp;
      mark.index = this.markCount;
      mark.user = -1;
      mark.shared = false;
      this.frameMarks[this.markCount++] = mark;
    }
    return mark;
  }

  /** Fills a pooled record with everything known before the renderer processes the object; `sides` is `sideFactor()`. */
  private begin(object: Object3D, material: Material, group: unknown, hashes: MaterialHashes, sides: number, lightsNode: unknown): SubmissionRecord {
    const state = this.current!;
    const context = this.contexts[this.contexts.length - 1]!;
    const reason = reasonOf(object, material, group, context.root, hashes.unsupported, this.annotations.get(object));
    // A scene submission's lights node: three draws the output quad with an empty default one.
    if (!state.lightsRead && context.pass === 'main' && reason !== 'renderer-internal') this.readLights(state, lightsNode);
    if (context.shadow && reason !== 'renderer-internal' && this.casterFrames.get(object) !== this.frameStamp) {
      // One caster per object per frame, across every shadow map: a batch or an instanced mesh is one, whatever it draws.
      this.casterFrames.set(object, this.frameStamp);
      state.shadowCasters++;
    }
    const geometry = (object as { geometry?: { attributes?: { position?: { count: number } }; morphAttributes?: { position?: unknown[] }; drawRange?: { start: number; count: number } } }).geometry;
    const positionCount = geometry?.attributes?.position?.count ?? 0;
    const range = geometry?.drawRange;
    // Points draw what drawRange allows (ParticleBudget caps them there); meshes count their whole geometry.
    const vertices = (object as { isPoints?: boolean }).isPoints && range && Number.isFinite(range.count) ? Math.max(0, Math.min(positionCount - range.start, range.count)) : positionCount;
    const skinned = object as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } };
    let skeleton: number | null = null;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      const known = state.skeletons;
      if (!known.has(skinned.skeleton)) known.set(skinned.skeleton, known.size);
      skeleton = known.get(skinned.skeleton)!;
    }
    const mark = this.markOf(material);
    // Main-pass uses count per object: a mesh drawn twice there (a transmissive material's back-side pass) is one use.
    if (context.pass === 'main' && reason !== 'renderer-internal') {
      if (mark.user === -1) mark.user = object.id;
      else if (mark.user !== object.id) mark.shared = true;
    }
    const record = acquire(state.buffer);
    record.name = this.names.of(object, context.root, context.paths);
    record.kind = kindOf(object);
    record.material = mark.index;
    record.materialType = material.type;
    record.programHash = hashes.programHash;
    record.variantHash = hashes.variantHash;
    record.transparent = material.transparent;
    record.pass = context.pass;
    record.reason = reason;
    record.flags.length = 0;
    if (reason !== 'renderer-internal') flagsInto(object, material, sides, record.flags);
    record.expectedGpuDraws = 0;
    record.instances = 0;
    record.instancesDrawn = 0;
    record.vertices = vertices;
    record.bones = skinned.isSkinnedMesh ? (skinned.skeleton?.bones.length ?? 0) : 0;
    record.skeleton = skeleton;
    record.morphTargets = geometry?.morphAttributes?.position?.length ?? 0;
    return record;
  }

  /** Snapshots the draw state into the record once the renderer returned, then files it as this frame's next item. */
  private file(record: SubmissionRecord, object: Object3D, sides: number, hashes: MaterialHashes): void {
    record.expectedGpuDraws = expectedGpuDraws(object, sides, this.backendInfo);
    writeInstanceCounts(object, record);
    const state = this.current;
    if (state === null) return; // detached inside the draw
    state.buffer.items[state.count++] = record;
    if (!state.descriptions.has(record.programHash)) state.descriptions.set(record.programHash, { type: record.materialType, description: hashes.description });
  }
}

function detectBackend(renderer: LedgerRenderer): BackendInfo {
  const backend = renderer.backend as BackendLike | undefined;
  if (!backend) return { backend: 'unknown', multiDraw: false };
  if (backend.isWebGPUBackend) return { backend: 'webgpu', multiDraw: false };
  return { backend: 'webgl2', multiDraw: typeof backend.hasFeature === 'function' ? backend.hasFeature('WEBGL_multi_draw') : false };
}
