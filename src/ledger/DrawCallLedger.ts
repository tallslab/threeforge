import { type Camera, type Light, type Material, type Object3D, REVISION, type Scene, Vector2 } from 'three';
import { type MaterialHashes, MaterialRegistry } from '../registry/MaterialRegistry.js';
import { type Budgets, budgetsFor } from './budgets.js';
import { type BackendInfo, type DrawGroup, expectedGpuDraws, writeInstanceCounts } from './expectedDraws.js';
import {
  acquire,
  type FrameState,
  newFrameState,
  type PooledRecord,
  type RecordBuffer,
  type RenderContext,
  snapshotRecord,
} from './frameState.js';
import { type HintContext, hintsFor, type MainPassObjects } from './hints.js';
import { MaterialUses } from './materialUses.js';
import { PerFrameMemo } from './memo.js';
import { type AllowedRenderTarget, estimateMemory } from './memory.js';
import { DisplayNames } from './names.js';
import {
  disposeOverdraw,
  measureOverdraw,
  type OverdrawRenderer,
  type OverdrawResult,
  overdrawTargetOf,
} from './overdraw.js';
import { passIdOf } from './passNames.js';
import { flagsInto, kindOf, type Reason, reasonOf } from './reasons.js';
import {
  type DrawnTarget,
  detectBackend,
  type LedgerRenderer,
  patchRenderer,
  type RendererOriginals,
  type TextureInfoWrap,
  unpatchRenderer,
  unwrapTextureInfo,
  wrapTextureInfo,
} from './rendererPatch.js';
import { formatCostRows, formatHints } from './report.js';
import { readLights, scanScene, walkLights } from './sceneScan.js';
import { lightInfoOf } from './sections.js';
import {
  type BudgetResult,
  buildFrame,
  emptyFrame,
  emptySections,
  type FrameEnv,
  type FrameSnapshot,
  type JsSnapshot,
  type MemorySnapshot,
  type Tier,
} from './snapshot.js';
import { forgetInternalResources, frameBufferTargetsOf, noteGeometry, WeakMembers } from './weakMembers.js';

export type { LedgerRenderer } from './rendererPatch.js';

export interface DrawCallLedgerOptions {
  registry?: MaterialRegistry;
  /** Clock for the js section (defaults to `performance.now`). */
  now?: () => number;
  /** Per-tier budget overrides for the hints. */
  budgets?: Partial<Budgets>;
}

const _bufferSize = new Vector2();
/** Scene-graph statistics recounted at most every RESCAN_EVERY frames (a full traversal). */
const RESCAN_EVERY = 60;
const FRAME_WINDOW = 60;

/**
 * Attributes every render item to a reason. Patches `renderObject` and `render` on the renderer instance: every
 * render-object function three installs (including ShadowNode's) ends in `renderer.renderObject`, so this sees main,
 * shadow and post-processing passes without composing `setRenderObjectFunction`.
 * The outermost `render()` call is a frame; nested calls are passes of it. `renderAsync` needs no patch of its own
 * (docs/threeforge.md section 4, "How it hooks in").
 *
 * The per-submission path allocates nothing in a steady scene: records are pooled, material hashes and the canonical a
 * drawn material resolves to are read once per material per frame, display names come from a validated cache, and a
 * frame walks each scene once (docs/threeforge.md section 4, "Overhead").
 */
export class DrawCallLedger {
  readonly registry: MaterialRegistry;
  private renderer: LedgerRenderer | null = null;
  private originals: RendererOriginals | null = null;
  private depth = 0;
  private current: FrameState | null = null;
  private readonly contexts: RenderContext[] = [];
  private last: FrameSnapshot;
  private lastItems: PooledRecord[] = [];
  private readonly buffers: [RecordBuffer, RecordBuffer] = [
    { records: [], items: [], acquired: 0 },
    { records: [], items: [], acquired: 0 },
  ];
  /** The buffer the next frame writes: never the one holding `lastItems`. */
  private write = 0;
  private readonly names = new DisplayNames();
  /** This frame's registry reads, by material: at most one `registry.keys()` per material per frame (`PerFrameMemo`). */
  private readonly hashes: PerFrameMemo<MaterialHashes>;
  private readonly annotations = new WeakMap<Object3D, Reason>();
  /** Frames entered: the marks below compare against it, so nothing is cleared between frames. */
  private frameStamp = 0;
  /** The frame each object was last counted as a shadow caster in. */
  private readonly casterFrames = new WeakMap<Object3D, number>();
  /** The frame each object was last counted as drawn with an unsupported material in, over every pass. */
  private readonly unsupportedFrames = new WeakMap<Object3D, number>();
  /** The frame each light's shadow-map texels were last counted in. */
  private readonly shadowMapFrames = new WeakMap<Light, number>();
  /** This frame's material uses: `SubmissionRecord.material` and the main-pass users behind `static-unbatched`. */
  private readonly uses: MaterialUses;
  private backendInfo: BackendInfo = { backend: 'unknown', multiDraw: false };
  private environment: { tier: Tier; gpu: string; dpr: number; viewport: [number, number] } = {
    tier: 'desktop',
    gpu: 'unknown',
    dpr: 1,
    viewport: [0, 0],
  };
  private readonly now: () => number;
  private readonly frameStarts: number[] = [];
  private framesSeen = 0;
  private lastScene: Object3D | null = null;
  /** `framesSeen` at the last `rescan()`, or -1: the scene-graph statistics it wrote live in `last.js`. */
  private rescannedAt = -1;
  private scheduler: { skippedRecently(): number } | null = null;
  private streamer: { stats(): { chunks: number; resident: number } } | null = null;
  private memoryStats: MemorySnapshot = emptySections().memory;
  /** Live DFG_LUT textures three created on the attached renderer (see `wrapTextureInfo`). */
  private readonly internalTextures = new Set<object>();
  /** Live render-target textures three's PMREMGenerator created on the attached renderer (`isPMREMTexture`, see `wrapTextureInfo`). */
  private readonly pmremTextures = new Set<object>();
  /**
   * Geometries three draws for itself outside every scene, until disposed: PMREMGenerator's LOD planes (a render whose root
   * is a mesh with an `outputDirection` attribute) and renderer-internal objects other than the shared output quad (the
   * background sphere). Held weakly. See `noteGeometry`.
   */
  private readonly internalGeometries = new WeakMembers<object>();
  /**
   * Render targets a render drew into while attached (shadow maps, their blur passes and the frame-buffer target
   * excepted), until disposed: held by a pass or a cache of three's (post-processing, CubeMapNode's cube, a mirror).
   * Held weakly.
   */
  private readonly drawnTargets = new WeakMembers<DrawnTarget>();
  /** One listener for every noted geometry and target: a disposed one is no longer three's to hold. */
  private readonly onResourceDispose = (event: { target: unknown }): void => {
    this.internalGeometries.delete(event.target as object);
    this.drawnTargets.delete(event.target as DrawnTarget);
  };
  private textureInfo: TextureInfoWrap | null = null;
  private hintContext: HintContext = {};
  /** Distinct objects the last frame's main pass drew, per reason the draw-call hints count (filled in `exit()`). */
  private readonly mainObjects: MainPassObjects = {
    untagged: 0,
    'unique-material': 0,
    'static-unbatched': 0,
    sprite: 0,
  };
  /** Distinct objects the last frame drew with an unsupported material, over every pass (`HintContext.unsupportedObjects`). */
  private unsupportedObjects = 0;
  private overdraw: OverdrawResult | null = null;
  private paused = false;
  private readonly budgetOverrides: Partial<Budgets>;

  constructor(options: DrawCallLedgerOptions = {}) {
    this.registry = options.registry ?? new MaterialRegistry();
    this.hashes = new PerFrameMemo(this.registry, (material) => this.registry.keys(material));
    this.uses = new MaterialUses(this.registry);
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
    forgetInternalResources(this.internalGeometries, this.drawnTargets, this.onResourceDispose);
    this.renderer = renderer;
    this.backendInfo = detectBackend(renderer);
    this.last = emptyFrame(this.env());
    // The blank snapshot holds no scene-graph statistics: the first frame recounts them.
    this.rescannedAt = -1;
    // A detach() from inside a draw leaves the running render wrapper's exit() to take depth below 0; a re-attached
    // ledger must start from 0.
    this.depth = 0;
    this.originals = patchRenderer(renderer, {
      attributing: () => this.depth !== 0 && this.current !== null && !this.paused,
      hashesOf: (material) => this.hashes.get(material),
      begin: (object, material, group, hashes, sides, lightsNode) =>
        this.begin(object, material, group, hashes, sides, lightsNode),
      file: (record, object, material, group, sides, hashes, backSide) =>
        this.file(record, object, material, group, sides, hashes, backSide),
      enter: (scene, camera) => this.enter(scene, camera),
      exit: () => this.exit(),
    });
    this.textureInfo = wrapTextureInfo(renderer, this.internalTextures, this.pmremTextures);
  }

  detach(): void {
    if (!this.renderer || !this.originals) return;
    unpatchRenderer(this.renderer, this.originals);
    unwrapTextureInfo(this.textureInfo, this.internalTextures, this.pmremTextures);
    this.textureInfo = null;
    forgetInternalResources(this.internalGeometries, this.drawnTargets, this.onResourceDispose);
    disposeOverdraw(this.renderer);
    this.renderer = null;
    this.originals = null;
    this.depth = 0;
    this.current = null;
    this.contexts.length = 0;
    this.clearHashes();
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
    const scan = scanScene(scene, this.names, this.renderer?.shadowMap?.enabled !== false);
    this.hintContext = scan.hints;
    this.rescannedAt = this.framesSeen;
    const memory = this.renderer?.info.memory;
    const info = {
      textures: memory?.textures ?? 0,
      geometries: memory?.geometries ?? 0,
      texturesSize: memory?.texturesSize,
      attributesSize: memory?.attributesSize,
      indexAttributesSize: memory?.indexAttributesSize,
      renderTargets: memory?.renderTargets,
      total: memory?.total,
    };
    // The overdraw count target is the renderer's own, held while nothing in the scene reaches it.
    // A target a render drew into and nobody disposed is held by a pass or by three (post-processing, CubeMapNode's cube
    // of an equirect background, a mirror). One drawn once and then abandoned undisposed is not told apart: it is allowed
    // too, a missed hint rather than a false one.
    const renderTargets: Array<AllowedRenderTarget | null> = [
      this.renderer ? overdrawTargetOf(this.renderer) : null,
      ...this.drawnTargets.live(),
    ];
    // three r186 keeps its frame-buffer targets in `_frameBufferTargets` (Renderer.js ~1561-1601) and draws none when a
    // RenderPipeline renders the output itself; without the map the estimate allows the usual colour and depth.
    const frameBuffers = frameBufferTargetsOf(this.renderer);
    this.memoryStats = estimateMemory(scene, info, this.environment.viewport, {
      renderTargets,
      internalTextures: this.internalTextures.size,
      rendererTextures: this.pmremTextures,
      internalGeometries: this.internalGeometries.live(),
      shadowMapType: this.renderer?.shadowMap?.type,
      ...(frameBuffers ? { frameBufferTargets: frameBuffers } : {}),
    });
    this.last = {
      ...this.last,
      js: {
        ...this.last.js,
        objects: scan.objects,
        autoUpdatedMatrices: scan.autoUpdatedMatrices,
        hiddenOriginals: scan.hiddenOriginals,
      },
      memory: this.memoryNow(),
    };
    this.last = {
      ...this.last,
      hints: hintsFor(this.last, this.budgets(), {
        ...this.hintContext,
        items: this.lastItems,
        objects: this.mainObjects,
        unsupportedObjects: this.unsupportedObjects,
      }),
    };
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
    return options.items ? { ...this.last, items: this.lastItems.map(snapshotRecord) } : this.last;
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
      lines.push(
        `  ${reason.padEnd(24)} ${String(r.submissions).padStart(5)}   ${r.top.join(', ')}${r.submissions > r.top.length ? ', …' : ''}`,
      );
    }
    if (f.passes.length > 1) lines.push(`  passes: ${f.passes.map((p) => `${p.id}=${p.submissions}`).join(', ')}`);
    for (const hint of formatHints(f)) lines.push(`  ${hint}`);
    return lines.join('\n');
  }

  private env(): FrameEnv {
    return {
      three: REVISION,
      backend: this.backendInfo.backend,
      multiDraw: this.backendInfo.multiDraw,
      ...this.environment,
      viewport: [...this.environment.viewport] as [number, number],
    };
  }

  private enter(scene: Object3D, camera: Camera): void {
    if (this.paused) return;
    if (this.depth === 0 && this.renderer) {
      const buffer = this.buffers[this.write]!;
      buffer.acquired = 0;
      this.clearHashes();
      const info = this.renderer.info.render;
      this.current = newFrameState(buffer, info.drawCalls, info.triangles, this.now());
      this.frameStamp++;
      // Material marks reset lazily against the uses' own frame stamp; the frame's indices start again at 0.
      this.uses.beginFrame();
      this.frameStarts.push(this.current.startedAt);
      if (this.frameStarts.length > FRAME_WINDOW + 1) this.frameStarts.shift();
    }
    const state = this.current!;
    const isScene = (scene as Scene).isScene === true;
    if (isScene && !state.scannedScenes.has(scene)) {
      state.scannedScenes.add(scene);
      walkLights(state, scene);
    }
    const shadowPass = state.shadowCameras.get(camera);
    const shadow = shadowPass !== undefined;
    const pass = passIdOf(state, scene, isScene, shadowPass, this.renderer);
    if (shadowPass !== undefined) {
      const light = shadowPass.light;
      // A light's texels count once per frame: a point light renders its six faces with one camera, and three renders a
      // map again for each other camera of the frame (ShadowNode keys its once-per-frame check by camera).
      if (light.shadow && this.shadowMapFrames.get(light) !== this.frameStamp) {
        this.shadowMapFrames.set(light, this.frameStamp);
        // A point light's six cube faces are each rendered at the map's width, the height never (three r186,
        // nodes/lighting/PointShadowNode.js:227 allocates the cube target and :254 sizes it, both from mapSize.width).
        const map = light.shadow.mapSize;
        state.shadowTexels += light.isPointLight ? map.x * map.x * 6 : map.x * map.y;
      }
    }
    // What the memory section allows for three's own resources: the target this render draws into, unless it is a shadow
    // map, a VSM blur target or the frame-buffer target (each allowed on its own), and PMREMGenerator's LOD planes, which it
    // renders as the root of their own render() (PMREMGenerator.js `_textureToCubeUV`, `_applyGGXFilter`, `_halfBlur`).
    if (!shadow && !isScene) {
      const geometry = (scene as { geometry?: { attributes?: Record<string, unknown> } }).geometry;
      if (geometry?.attributes?.outputDirection !== undefined)
        noteGeometry(this.internalGeometries, geometry, this.onResourceDispose);
    }
    const target = shadow || pass.endsWith(':vsm') ? null : (this.renderer?.getRenderTarget?.() ?? null);
    if (target !== null && target.isPostProcessingRenderTarget !== true && this.drawnTargets.add(target))
      target.addEventListener?.('dispose', this.onResourceDispose);
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
    let transparentSubmissions = 0;
    let particles = 0;
    const objects = this.mainObjects;
    objects.untagged = objects['unique-material'] = objects['static-unbatched'] = objects.sprite = 0;
    // An index loop, deliberately, not `for…of`: this walks every submission of every frame, on the same V8
    // iterator-elision boundary a sibling walk fell off (a 40-byte iterator result per submission: 0.80 -> 1.20 MB per
    // frame at 10k). See `skinningOf` in sections.ts; test/unit/ledger-hot-path.test.ts guards every such walk.
    for (let k = 0; k < items.length; k++) {
      const i = items[k]!;
      // Drawn alone is `unique-material` only while no other object of the main pass draws the material; every pass's
      // record of the object follows, since its index names the same mark.
      if (i.reason === 'unique-material' && this.uses.shared(i.material)) i.reason = 'static-unbatched';
      if (i.pass !== 'main') continue;
      // Objects, not submissions, for the draw-call hints: a shadow map or a nested pass draws an object again, and three's
      // back-side pass of a double-sided transmissive material draws it twice in the main pass itself.
      if (
        !i.backSide &&
        (i.reason === 'untagged' ||
          i.reason === 'unique-material' ||
          i.reason === 'static-unbatched' ||
          i.reason === 'sprite')
      )
        objects[i.reason]++;
      if (i.transparent && i.reason !== 'renderer-internal') transparentSubmissions++;
      particles +=
        i.kind === 'points' ? i.vertices : i.reason === 'sprite-batch' ? i.instances : i.kind === 'sprite' ? 1 : 0;
    }
    this.lastItems = items;
    this.write = state.buffer === this.buffers[0] ? 1 : 0;
    this.clearHashes();
    this.framesSeen++;
    this.lastScene = state.mainScene;
    if (this.rescannedAt < 0 || this.framesSeen - this.rescannedAt >= RESCAN_EVERY) this.rescan();
    const intervals: number[] = [];
    for (let i = 1; i < this.frameStarts.length; i++) intervals.push(this.frameStarts[i]! - this.frameStarts[i - 1]!);
    intervals.sort((a, b) => a - b);
    const frameMs = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0;
    // The scene-graph statistics are the last rescan's (this frame's, when it rescanned above).
    const graph = this.last.js;
    const js: JsSnapshot = {
      renderMs: renderEnd - state.startedAt,
      ledgerMs: 0,
      frameMs,
      objects: graph.objects,
      autoUpdatedMatrices: graph.autoUpdatedMatrices,
      hiddenOriginals: graph.hiddenOriginals,
      skipped: this.scheduler?.skippedRecently() ?? 0,
    };
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
        pixels: this.renderer.getDrawingBufferSize
          ? (() => {
              const s = this.renderer.getDrawingBufferSize!(_bufferSize);
              return s.x * s.y;
            })()
          : 0,
        measured: this.overdraw !== null,
      },
    });
    this.unsupportedObjects = state.unsupportedObjects;
    this.last.hints = hintsFor(this.last, this.budgets(), {
      ...this.hintContext,
      items,
      objects: this.mainObjects,
      unsupportedObjects: this.unsupportedObjects,
    });
    this.current = null;
    // `js` is this frame's own object (buildFrame keeps it): no earlier snapshot shares it.
    js.ledgerMs = this.now() - renderEnd;
  }

  /** Between frames nothing here holds a material: neither the hash memo nor the uses' resolved canonicals. */
  private clearHashes(): void {
    this.hashes.clear();
    this.uses.clear();
  }

  /** Fills a pooled record with everything known before the renderer processes the object; `sides` is `sideFactor()`. */
  private begin(
    object: Object3D,
    material: Material,
    group: unknown,
    hashes: MaterialHashes,
    sides: number,
    lightsNode: unknown,
  ): PooledRecord {
    const state = this.current!;
    const context = this.contexts[this.contexts.length - 1]!;
    const reason = reasonOf(object, material, group, context.root, hashes.unsupported, this.annotations.get(object));
    // A scene submission's lights node: three draws the output quad with an empty default one.
    if (!state.lightsRead && context.pass === 'main' && reason !== 'renderer-internal') readLights(state, lightsNode);
    if (context.shadow && reason !== 'renderer-internal' && this.casterFrames.get(object) !== this.frameStamp) {
      // One caster per object per frame, across every shadow map: a batch or an instanced mesh is one, whatever it draws.
      this.casterFrames.set(object, this.frameStamp);
      state.shadowCasters++;
    }
    // One per object per frame, across every pass: the material renders in none of them on WebGPU, so an object drawn only
    // into a shadow map or a nested pass is one more mesh the hint names, and one drawn in several passes is still one.
    if (reason === 'unsupported-material' && this.unsupportedFrames.get(object) !== this.frameStamp) {
      this.unsupportedFrames.set(object, this.frameStamp);
      state.unsupportedObjects++;
    }
    const geometry = (
      object as {
        geometry?: {
          attributes?: { position?: { count: number } };
          morphAttributes?: { position?: unknown[] };
          drawRange?: { start: number; count: number };
        };
      }
    ).geometry;
    // three drew this outside every scene (the background sphere): its geometry is three's. The output pass's and the VSM
    // blur's QuadMesh share one geometry the memory section always allows.
    if (
      reason === 'renderer-internal' &&
      geometry !== undefined &&
      (object as { isQuadMesh?: boolean }).isQuadMesh !== true &&
      !this.internalGeometries.has(geometry)
    )
      noteGeometry(this.internalGeometries, geometry, this.onResourceDispose);
    const positionCount = geometry?.attributes?.position?.count ?? 0;
    const range = geometry?.drawRange;
    // Points draw what drawRange allows (ParticleBudget caps them there); meshes count their whole geometry.
    const vertices =
      (object as { isPoints?: boolean }).isPoints && range && Number.isFinite(range.count)
        ? Math.max(0, Math.min(positionCount - range.start, range.count))
        : positionCount;
    const skinned = object as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } };
    let skeleton: number | null = null;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      const known = state.skeletons;
      if (!known.has(skinned.skeleton)) known.set(skinned.skeleton, known.size);
      skeleton = known.get(skinned.skeleton)!;
    }
    // Main-pass uses count per object: a mesh drawn twice there (a transmissive material's back-side pass) is one use.
    const materialIndex = this.uses.use(material, object.id, context.pass === 'main' && reason !== 'renderer-internal');
    const record = acquire(state.buffer);
    record.name = this.names.of(object, context.root, context.paths);
    record.kind = kindOf(object);
    record.material = materialIndex;
    record.materialType = material.type;
    record.programHash = hashes.programHash;
    record.variantHash = hashes.variantHash;
    record.transparent = material.transparent;
    record.pass = context.pass;
    record.reason = reason;
    // In place: a record's flags are rewritten only where they change (see `flagsInto`).
    if (reason !== 'renderer-internal') flagsInto(object, material, sides, record.flags);
    else if (record.flags.length !== 0) record.flags.length = 0;
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
  private file(
    record: PooledRecord,
    object: Object3D,
    material: Material,
    group: DrawGroup | null,
    sides: number,
    hashes: MaterialHashes,
    backSide: boolean,
  ): void {
    record.expectedGpuDraws = expectedGpuDraws(object, sides, this.backendInfo, material, group);
    writeInstanceCounts(object, record, material, group);
    record.backSide = backSide;
    const state = this.current;
    if (state === null) return; // detached inside the draw
    state.buffer.items[state.count++] = record;
    if (!state.descriptions.has(record.programHash))
      state.descriptions.set(record.programHash, { type: record.materialType, description: hashes.description });
  }
}
