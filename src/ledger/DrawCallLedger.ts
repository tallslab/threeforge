import { REVISION, type Camera, type Light, type Material, type Object3D, type Scene } from 'three';
import { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { expectedGpuDraws, instanceCounts, type BackendInfo } from './expectedDraws.js';
import { displayName, flagsOf, kindOf, reasonOf, type Reason } from './reasons.js';
import { budgetsFor, type Budgets } from './budgets.js';
import { Vector2 } from 'three';
import { hintsFor, type HintContext } from './hints.js';
import { estimateMemory } from './memory.js';
import { measureOverdraw, type OverdrawRenderer, type OverdrawResult } from './overdraw.js';
import { formatCostRows, formatHints } from '../overlay/index.js';
import { FORGE_TAG_KEY } from '../tags.js';
import { scanLights, type LightInfo } from './sections.js';
import { buildFrame, emptyFrame, emptySections, type BudgetResult, type FrameEnv, type FrameSnapshot, type MemorySnapshot, type SubmissionRecord, type Tier } from './snapshot.js';

/** The slice of three's common Renderer the ledger patches and reads. Structural so tests can fake it. */
export interface LedgerRenderer {
  render(scene: Scene, camera: Camera): unknown;
  renderAsync?(scene: Scene, camera: Camera): Promise<unknown>;
  renderObject(...args: unknown[]): unknown;
  info: { render: { drawCalls: number; triangles: number }; memory: { programs: number; textures?: number; geometries?: number } };
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
const FRAME_WINDOW = 60;

type InternalRecord = SubmissionRecord & { description: string };

/** One `render()` call. The outermost call of a frame is `main`; nested calls are passes of it. */
interface RenderContext {
  root: Object3D;
  pass: string;
}

interface FrameState {
  mainScene: Object3D | null;
  items: InternalRecord[];
  drawCallsStart: number;
  trianglesStart: number;
  shadowCameras: Map<Camera, Light>;
  scannedScenes: Set<Object3D>;
  nestedScenes: number;
  skeletons: Map<unknown, number>;
  lights: LightInfo[];
  startedAt: number;
}

/**
 * Attributes every render item to a reason. Patches `renderObject`, `render` and `renderAsync` on the renderer
 * instance: every render-object function three installs (including ShadowNode's) ends in `renderer.renderObject`,
 * so this sees main, shadow and post-processing passes without composing `setRenderObjectFunction`.
 * The outermost `render()` call is a frame; nested calls are passes of it.
 */
export class DrawCallLedger {
  readonly registry: MaterialRegistry;
  private renderer: LedgerRenderer | null = null;
  private originals: { render: LedgerRenderer['render']; renderAsync: LedgerRenderer['renderAsync']; renderObject: LedgerRenderer['renderObject'] } | null = null;
  private depth = 0;
  private current: FrameState | null = null;
  private readonly contexts: RenderContext[] = [];
  private last: FrameSnapshot;
  private lastItems: SubmissionRecord[] = [];
  private readonly annotations = new WeakMap<Object3D, Reason>();
  private backendInfo: BackendInfo = { backend: 'unknown', multiDraw: false };
  private environment: { tier: Tier; gpu: string; dpr: number; viewport: [number, number] } = { tier: 'desktop', gpu: 'unknown', dpr: 1, viewport: [0, 0] };
  private readonly now: () => number;
  private readonly frameStarts: number[] = [];
  private framesSeen = 0;
  private lastScene: Object3D | null = null;
  private graphStats: { objects: number; autoUpdatedMatrices: number; at: number } = { objects: 0, autoUpdatedMatrices: 0, at: -1 };
  private memoryStats: MemorySnapshot = emptySections().memory;
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

  attach(renderer: LedgerRenderer): void {
    if (this.renderer) this.detach();
    this.renderer = renderer;
    this.backendInfo = detectBackend(renderer);
    this.last = emptyFrame(this.env());
    const originals = { render: renderer.render, renderAsync: renderer.renderAsync, renderObject: renderer.renderObject };
    this.originals = originals;
    const ledger = this;

    renderer.renderObject = function (this: LedgerRenderer, ...args: unknown[]) {
      if (ledger.depth === 0 || ledger.current === null) return originals.renderObject.apply(this, args);
      const [object, scene, , , material, group] = args as [Object3D, Scene, Camera, unknown, Material, unknown];
      const record = ledger.begin(object, material, group);
      const result = originals.renderObject.apply(this, args);
      record.expectedGpuDraws = expectedGpuDraws(object, material, scene, ledger.backendInfo);
      const counts = instanceCounts(object);
      record.instances = counts.instances;
      record.instancesDrawn = counts.instancesDrawn;
      ledger.current.items.push(record);
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
    if (originals.renderAsync) {
      renderer.renderAsync = async function (this: LedgerRenderer, scene: Scene, camera: Camera) {
        ledger.enter(scene, camera);
        try {
          return await originals.renderAsync!.call(this, scene, camera);
        } finally {
          ledger.exit();
        }
      };
    }
  }

  detach(): void {
    if (!this.renderer || !this.originals) return;
    this.renderer.render = this.originals.render;
    this.renderer.renderObject = this.originals.renderObject;
    if (this.originals.renderAsync) this.renderer.renderAsync = this.originals.renderAsync;
    this.renderer = null;
    this.originals = null;
    this.depth = 0;
    this.current = null;
    this.contexts.length = 0;
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
    const ctx: Required<HintContext> = { staticAutoUpdated: [], pointShadowLights: [], transmissive: [] };
    scene.traverse((o) => {
      objects++;
      if (o.matrixAutoUpdate && o.matrixWorldAutoUpdate) {
        auto++;
        if ((o.userData as Record<string, unknown>)[FORGE_TAG_KEY] === 'static' && (o as { isMesh?: boolean }).isMesh) ctx.staticAutoUpdated.push(displayName(o, scene));
      }
      const light = o as Light & { isPointLight?: boolean };
      if (light.isLight && light.isPointLight && light.castShadow && light.visible) ctx.pointShadowLights.push(displayName(o, scene));
      const material = (o as { material?: Material | Material[] }).material;
      for (const m of Array.isArray(material) ? material : material ? [material] : []) {
        if (((m as Material & { transmission?: number }).transmission ?? 0) > 0) {
          ctx.transmissive.push(displayName(o, scene));
          break;
        }
      }
    });
    this.hintContext = ctx;
    // The scene object itself is not part of the count.
    this.graphStats = { objects: objects - 1, autoUpdatedMatrices: auto - 1, at: this.framesSeen };
    const memory = this.renderer?.info.memory;
    this.memoryStats = estimateMemory(scene, { textures: memory?.textures ?? 0, geometries: memory?.geometries ?? 0 }, this.environment.viewport);
    this.last = { ...this.last, js: { ...this.last.js, objects: this.graphStats.objects, autoUpdatedMatrices: this.graphStats.autoUpdatedMatrices }, memory: this.memoryStats };
    this.last = { ...this.last, hints: hintsFor(this.last, this.budgets(), this.hintContext) };
  }

  /** The budgets hints are judged against: the environment's tier plus constructor overrides. */
  budgets(): Budgets {
    return budgetsFor(this.environment.tier, this.budgetOverrides);
  }

  /**
   * Measure overdraw (fragments per pixel, opaque and transparent) with two low-resolution count renders; the
   * result rides along in every following `frame()` until the next measurement. Not counted as a frame.
   */
  async measureOverdraw(scene: Scene, camera: Camera, options: { scale?: number } = {}): Promise<OverdrawResult> {
    if (!this.renderer) throw new Error('attach a renderer first');
    this.paused = true;
    try {
      this.overdraw = await measureOverdraw(this.renderer as unknown as OverdrawRenderer, scene, camera, options);
    } finally {
      this.paused = false;
    }
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
      this.current = {
        mainScene: null,
        items: [],
        drawCallsStart: this.renderer.info.render.drawCalls,
        trianglesStart: this.renderer.info.render.triangles,
        shadowCameras: new Map(),
        scannedScenes: new Set(),
        nestedScenes: 0,
        skeletons: new Map(),
        lights: [],
        startedAt: this.now(),
      };
      this.frameStarts.push(this.current.startedAt);
      if (this.frameStarts.length > FRAME_WINDOW + 1) this.frameStarts.shift();
    }
    const state = this.current!;
    const isScene = (scene as Scene).isScene === true;
    if (isScene && !state.scannedScenes.has(scene)) {
      state.scannedScenes.add(scene);
      scene.traverse((o) => {
        const light = o as Light & { shadow?: { camera?: Camera } };
        if (light.isLight && light.shadow?.camera) state.shadowCameras.set(light.shadow.camera, light);
      });
      if (state.mainScene === null) state.lights = scanLights(scene);
    }
    let pass: string;
    const light = state.shadowCameras.get(camera);
    if (light) pass = `shadow:${light.name || light.type}`;
    else if ((scene as Scene).overrideMaterial) pass = 'override';
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
    this.contexts.push({ root: scene, pass });
    this.depth++;
  }

  private exit(): void {
    if (this.paused) return;
    this.depth--;
    this.contexts.pop();
    if (this.depth > 0 || !this.current || !this.renderer) return;
    const descriptions = new Map<string, { type: string; description: string }>();
    for (const item of this.current.items) {
      if (!descriptions.has(item.programHash)) descriptions.set(item.programHash, { type: item.materialType, description: item.description });
    }
    this.lastItems = this.current.items.map(({ description: _d, ...rest }) => rest);
    this.framesSeen++;
    this.lastScene = this.current.mainScene;
    if (this.graphStats.at < 0 || this.framesSeen - this.graphStats.at >= RESCAN_EVERY) this.rescan();
    const intervals: number[] = [];
    for (let i = 1; i < this.frameStarts.length; i++) intervals.push(this.frameStarts[i]! - this.frameStarts[i - 1]!);
    intervals.sort((a, b) => a - b);
    const frameMs = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0;
    this.last = buildFrame({
      env: this.env(),
      items: this.lastItems,
      reportedDrawCalls: this.renderer.info.render.drawCalls - this.current.drawCallsStart,
      triangles: this.renderer.info.render.triangles - this.current.trianglesStart,
      programs: this.renderer.info.memory.programs,
      descriptions,
      lights: this.current.lights,
      js: { renderMs: this.now() - this.current.startedAt, frameMs, objects: this.graphStats.objects, autoUpdatedMatrices: this.graphStats.autoUpdatedMatrices },
      memory: this.memoryStats,
      overdraw: {
        opaque: this.overdraw?.opaque ?? 0,
        transparent: this.overdraw?.transparent ?? 0,
        transparentSubmissions: this.lastItems.filter((i) => i.transparent && i.pass === 'main' && i.reason !== 'renderer-internal').length,
        particles: this.lastItems.reduce((sum, i) => (i.pass !== 'main' ? sum : i.kind === 'points' ? sum + i.vertices : i.reason === 'sprite-batch' ? sum + i.instances : i.kind === 'sprite' ? sum + 1 : sum), 0),
        pixels: this.renderer.getDrawingBufferSize ? (() => { const s = this.renderer.getDrawingBufferSize!(_bufferSize); return s.x * s.y; })() : 0,
        measured: this.overdraw !== null,
      },
    });
    this.last.hints = hintsFor(this.last, this.budgets(), this.hintContext);
    this.current = null;
  }

  private begin(object: Object3D, material: Material, group: unknown): InternalRecord {
    const context = this.contexts[this.contexts.length - 1]!;
    const described = this.registry.describe(material);
    const reason = reasonOf({ object, material, group, root: context.root, unsupported: described.unsupported, annotation: this.annotations.get(object) });
    const geometry = (object as { geometry?: { attributes?: { position?: { count: number } }; morphAttributes?: { position?: unknown[] }; drawRange?: { start: number; count: number } } }).geometry;
    const positionCount = geometry?.attributes?.position?.count ?? 0;
    const range = geometry?.drawRange;
    // Points draw what drawRange allows (ParticleBudget caps them there); meshes count their whole geometry.
    const vertices = (object as { isPoints?: boolean }).isPoints && range && Number.isFinite(range.count) ? Math.max(0, Math.min(positionCount - range.start, range.count)) : positionCount;
    const skinned = object as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } };
    let skeleton: number | null = null;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      const known = this.current!.skeletons;
      if (!known.has(skinned.skeleton)) known.set(skinned.skeleton, known.size);
      skeleton = known.get(skinned.skeleton)!;
    }
    return {
      name: displayName(object, context.root),
      kind: kindOf(object),
      materialType: material.type,
      programHash: described.programHash,
      variantHash: described.variantHash,
      transparent: material.transparent,
      pass: context.pass,
      reason,
      flags: reason === 'renderer-internal' ? [] : flagsOf(object, material),
      expectedGpuDraws: 0,
      instances: 0,
      instancesDrawn: 0,
      vertices,
      bones: skinned.isSkinnedMesh ? (skinned.skeleton?.bones.length ?? 0) : 0,
      skeleton,
      morphTargets: geometry?.morphAttributes?.position?.length ?? 0,
      description: described.description,
    };
  }
}

function detectBackend(renderer: LedgerRenderer): BackendInfo {
  const backend = renderer.backend as BackendLike | undefined;
  if (!backend) return { backend: 'unknown', multiDraw: false };
  if (backend.isWebGPUBackend) return { backend: 'webgpu', multiDraw: false };
  return { backend: 'webgl2', multiDraw: typeof backend.hasFeature === 'function' ? backend.hasFeature('WEBGL_multi_draw') : false };
}
