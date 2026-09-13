import { REVISION, type Camera, type Light, type Material, type Object3D, type Scene } from 'three';
import { MaterialRegistry } from '../registry/MaterialRegistry.js';
import { expectedGpuDraws, instanceCounts, type BackendInfo } from './expectedDraws.js';
import { displayName, flagsOf, kindOf, reasonOf, type Reason } from './reasons.js';
import { buildFrame, emptyFrame, type BudgetResult, type FrameSnapshot, type SubmissionRecord } from './snapshot.js';

/** The slice of three's common Renderer the ledger patches and reads. Structural so tests can fake it. */
export interface LedgerRenderer {
  render(scene: Scene, camera: Camera): unknown;
  renderAsync?(scene: Scene, camera: Camera): Promise<unknown>;
  renderObject(...args: unknown[]): unknown;
  info: { render: { drawCalls: number; triangles: number }; memory: { programs: number } };
  backend?: unknown;
  getRenderTarget?(): { name?: string; texture?: { name?: string } } | null;
}

interface BackendLike {
  isWebGPUBackend?: boolean;
  hasFeature?(name: string): boolean;
}

export interface DrawCallLedgerOptions {
  registry?: MaterialRegistry;
}

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

  constructor(options: DrawCallLedgerOptions = {}) {
    this.registry = options.registry ?? new MaterialRegistry();
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
    const reasons = Object.entries(f.byReason).sort(([, a], [, b]) => b.submissions - a.submissions);
    for (const [reason, r] of reasons) {
      lines.push(`  ${reason.padEnd(24)} ${String(r.submissions).padStart(5)}   ${r.top.join(', ')}${r.submissions > r.top.length ? ', …' : ''}`);
    }
    if (f.passes.length > 1) lines.push(`  passes: ${f.passes.map((p) => `${p.id}=${p.submissions}`).join(', ')}`);
    return lines.join('\n');
  }

  private env(): FrameSnapshot['env'] {
    return { three: REVISION, backend: this.backendInfo.backend, multiDraw: this.backendInfo.multiDraw };
  }

  private enter(scene: Object3D, camera: Camera): void {
    if (this.depth === 0 && this.renderer) {
      this.current = {
        mainScene: null,
        items: [],
        drawCallsStart: this.renderer.info.render.drawCalls,
        trianglesStart: this.renderer.info.render.triangles,
        shadowCameras: new Map(),
        scannedScenes: new Set(),
        nestedScenes: 0,
      };
    }
    const state = this.current!;
    const isScene = (scene as Scene).isScene === true;
    if (isScene && !state.scannedScenes.has(scene)) {
      state.scannedScenes.add(scene);
      scene.traverse((o) => {
        const light = o as Light & { shadow?: { camera?: Camera } };
        if (light.isLight && light.shadow?.camera) state.shadowCameras.set(light.shadow.camera, light);
      });
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
    this.depth--;
    this.contexts.pop();
    if (this.depth > 0 || !this.current || !this.renderer) return;
    const descriptions = new Map<string, { type: string; description: string }>();
    for (const item of this.current.items) {
      if (!descriptions.has(item.programHash)) descriptions.set(item.programHash, { type: item.materialType, description: item.description });
    }
    this.lastItems = this.current.items.map(({ description: _d, ...rest }) => rest);
    this.last = buildFrame({
      env: this.env(),
      items: this.lastItems,
      reportedDrawCalls: this.renderer.info.render.drawCalls - this.current.drawCallsStart,
      triangles: this.renderer.info.render.triangles - this.current.trianglesStart,
      programs: this.renderer.info.memory.programs,
      descriptions,
    });
    this.current = null;
  }

  private begin(object: Object3D, material: Material, group: unknown): InternalRecord {
    const context = this.contexts[this.contexts.length - 1]!;
    const described = this.registry.describe(material);
    const reason = reasonOf({ object, material, group, root: context.root, unsupported: described.unsupported, annotation: this.annotations.get(object) });
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
