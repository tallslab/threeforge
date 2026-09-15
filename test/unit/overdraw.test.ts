import { describe, expect, it } from 'vitest';
import {
  AddEquation,
  BackSide,
  BoxGeometry,
  Color,
  CustomBlending,
  DataTexture,
  FrontSide,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  PlaneGeometry,
  Points,
  RenderTarget,
  Sprite,
  SpriteMaterial,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
} from 'three';
import { float } from 'three/tsl';
import { MeshBasicNodeMaterial, PointsNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { disposeOverdraw, measureOverdraw } from '../../src/ledger/overdraw.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

type RenderObjectFn = (object: Object3D, scene: Scene, camera: Camera, geometry: unknown, material: Material, group: unknown, lightsNode: unknown, clippingContext: unknown, passId: unknown) => void;
type CountMaterial = Material & {
  isNodeMaterial?: boolean;
  outputNode?: { node?: { value?: { toArray(): number[] } } } | null;
  map: Texture | null;
  alphaMap: Texture | null;
  lights: boolean;
  fog: boolean;
  toneMapped: boolean;
  opacityNode?: unknown;
  alphaTestNode?: unknown;
  maskNode?: unknown;
  rotation?: number;
  sizeAttenuation?: boolean;
  scaleNode?: unknown;
  rotationNode?: unknown;
  positionNode?: unknown;
  displacementMap?: Texture | null;
};
type NodeScene = Scene & { backgroundNode?: unknown };

/** What the scene and the renderer looked like inside one render() call. */
interface Captured {
  override: CountMaterial | null;
  background: unknown;
  backgroundNode: unknown;
  target: unknown;
  mrt: unknown;
  renderObjectFunction: RenderObjectFn | null;
  clear: number[];
  autoClear: boolean;
  autoClearColor: boolean;
  opaque: boolean;
  transparent: boolean;
}

const APP_MRT = { isMRTNode: true, name: 'app' };
const appRenderObject: RenderObjectFn = () => {};

/**
 * The common Renderer surface the measurement drives, recording the state of each render() call and each renderObject()
 * call made through the installed render-object function. Starts from app state that differs from every value the
 * count renders need, so a missed restore shows.
 */
function protocolRenderer(sums: number[]) {
  const calls: Captured[] = [];
  const objectCalls: Array<{
    object: Object3D;
    material: Material;
    /** The scene's override material during the call, and its per-object fields then. */
    override: CountMaterial;
    count: [Texture | null, number, boolean, number];
    nodes: [unknown, unknown, unknown];
    sprite: [number | undefined, boolean | undefined, unknown, unknown];
  }> = [];
  let reads = 0;
  return {
    calls,
    objectCalls,
    opaque: true,
    transparent: true,
    autoClear: false,
    autoClearColor: false,
    target: null as unknown,
    cubeFace: 0,
    mipmapLevel: 0,
    mrt: APP_MRT as unknown,
    renderObjectFunction: appRenderObject as RenderObjectFn | null,
    clearColor: new Color(0.2, 0.4, 0.6),
    clearAlpha: 1,
    render(scene: NodeScene, _camera: Camera) {
      calls.push({
        override: scene.overrideMaterial as CountMaterial | null,
        background: scene.background,
        backgroundNode: scene.backgroundNode,
        target: this.target,
        mrt: this.mrt,
        renderObjectFunction: this.renderObjectFunction,
        clear: [this.clearColor.r, this.clearColor.g, this.clearColor.b, this.clearAlpha],
        autoClear: this.autoClear,
        autoClearColor: this.autoClearColor,
        opaque: this.opaque,
        transparent: this.transparent,
      });
    },
    renderObject(object: Object3D, scene: Scene, _camera: Camera, _geometry: unknown, material: Material) {
      const count = scene.overrideMaterial as CountMaterial;
      count.alphaMap = (material as MeshBasicMaterial).alphaMap ?? null; // Renderer.renderObject's override path, which does not restore it
      objectCalls.push({
        object,
        material,
        override: count,
        count: [count.map, count.opacity, count.alphaHash, count.side],
        nodes: [count.opacityNode, count.alphaTestNode, count.maskNode],
        sprite: [count.rotation, count.sizeAttenuation, count.scaleNode, count.rotationNode],
      });
    },
    setRenderTarget(target: unknown, cubeFace = 0, mipmapLevel = 0) {
      this.target = target;
      this.cubeFace = cubeFace;
      this.mipmapLevel = mipmapLevel;
    },
    getRenderTarget() {
      return this.target;
    },
    getActiveCubeFace() {
      return this.cubeFace;
    },
    getActiveMipmapLevel() {
      return this.mipmapLevel;
    },
    setMRT(mrt: unknown) {
      this.mrt = mrt;
      return this;
    },
    getMRT() {
      return this.mrt;
    },
    setRenderObjectFunction(fn: RenderObjectFn | null) {
      this.renderObjectFunction = fn;
    },
    getRenderObjectFunction() {
      return this.renderObjectFunction;
    },
    getClearColor(target: Color) {
      return target.copy(this.clearColor);
    },
    setClearColor(color: Color, alpha = 1) {
      this.clearColor.copy(color);
      this.clearAlpha = alpha;
    },
    getClearAlpha() {
      return this.clearAlpha;
    },
    getDrawingBufferSize(v: { x: number; y: number }) {
      v.x = 800;
      v.y = 600;
      return v;
    },
    readRenderTargetPixelsAsync(t: { width: number; height: number }): Promise<ArrayLike<number>> {
      const n = t.width * t.height;
      const px = new Float32Array(n * 4);
      for (let k = 0; k < n; k++) px[k * 4] = sums[reads] ?? 0;
      reads++;
      return Promise.resolve(px);
    },
  };
}

type Protocol = ReturnType<typeof protocolRenderer>;

/**
 * Puts app state on the scene and the renderer that differs from every value the count renders set (an override material,
 * a background and a background node, a cube-face target at mipmap level 2, the transparent list only), and returns the
 * check that all of it, with the protocol renderer's own starting state, is back.
 */
function installAppState(scene: Scene, renderer: Protocol): () => void {
  const background = new Color(0x336699);
  const backgroundNode = { isNode: true };
  const override = new MeshBasicMaterial();
  Object.assign(scene, { background, backgroundNode, overrideMaterial: override });
  const target = new RenderTarget(4, 4);
  renderer.setRenderTarget(target, 3, 2);
  renderer.opaque = false;
  return () => {
    expect(scene.overrideMaterial).toBe(override);
    expect(scene.background).toBe(background);
    expect((scene as NodeScene).backgroundNode).toBe(backgroundNode);
    expect(renderer.getRenderTarget()).toBe(target);
    expect([renderer.getActiveCubeFace(), renderer.getActiveMipmapLevel()]).toEqual([3, 2]);
    expect(renderer.getMRT()).toBe(APP_MRT);
    expect(renderer.getRenderObjectFunction()).toBe(appRenderObject);
    expect([renderer.clearColor.r, renderer.clearColor.g, renderer.clearColor.b, renderer.clearAlpha]).toEqual([0.2, 0.4, 0.6, 1]);
    expect([renderer.autoClear, renderer.autoClearColor, renderer.opaque, renderer.transparent]).toEqual([false, false, false, true]);
  };
}

/** What every count material shares: a constant output, one per fragment whatever the colour, additive, no depth, one pass, unlit. */
function expectCountSettings(m: CountMaterial): void {
  expect(m.isNodeMaterial).toBe(true);
  // NodeMaterial.setup (three r186 ~547-549): a non-null outputNode replaces the diffuse result, so instance, batch and
  // vertex colours no longer scale the count, while setupDiffuseColor still runs its alphaTest and alphaHash discards.
  expect(m.outputNode?.node?.value?.toArray()).toEqual([1, 0, 0, 1]); // TSL's vec4(1, 0, 0, 1): a VarNode over a ConstNode
  expect([m.blending, m.blendSrc, m.blendDst, m.blendEquation]).toEqual([CustomBlending, OneFactor, OneFactor, AddEquation]);
  expect([m.depthTest, m.depthWrite, m.transparent, m.forceSinglePass]).toEqual([false, false, true, true]);
  expect([m.lights, m.fog, m.toneMapped]).toEqual([false, false, false]);
}

/** Makes render() record its state, then call the installed render-object function on each object as a renderer method, as Renderer._renderObjects does. */
function drawEach(renderer: Protocol, camera: Camera, objects: Object3D[]): void {
  const record = renderer.render;
  renderer.render = function (this: Protocol, scene: NodeScene) {
    record.call(this, scene, camera);
    const fn = this.getRenderObjectFunction()!;
    for (const o of objects) fn.call(this, o, scene, camera, (o as Mesh).geometry, (o as Mesh).material as Material, null, null, null, null);
  };
}

describe('measureOverdraw', () => {
  it('renders opaque then transparent into a 1/8 half-float target, background-free, cleared to 0 with no MRT, and averages the red channel', async () => {
    const { scene, camera } = sceneWithCamera();
    scene.background = new Color(0xffffff);
    const renderer = protocolRenderer([1.5, 0.75]);
    const result = await measureOverdraw(renderer as never, scene, camera);
    expect(result).toEqual({ opaque: 1.5, transparent: 0.75 });
    expect(renderer.calls.map((c) => [c.opaque, c.transparent])).toEqual([
      [true, false],
      [false, true],
    ]);
    for (const c of renderer.calls) {
      expect(c.override?.type).toBe('MeshBasicNodeMaterial');
      expect([c.background, c.backgroundNode, c.mrt]).toEqual([null, null, null]);
      expect([c.clear, c.autoClear, c.autoClearColor]).toEqual([[0, 0, 0, 0], true, true]);
      expect(typeof c.renderObjectFunction).toBe('function');
      expect(c.renderObjectFunction).not.toBe(appRenderObject);
      expect(c.target).toBe(renderer.calls[0]!.target);
    }
    const target = renderer.calls[0]!.target as RenderTarget;
    expect([target.width, target.height]).toEqual([128, 96]); // 800x600 / 8 rounded up to 32-texel rows (no read-back padding)
    expect([target.texture.type, target.depthBuffer, target.stencilBuffer]).toEqual([HalfFloatType, false, false]);
  });

  it('restores every scene and renderer state it changed before it awaits the read-backs', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([]);
    const expectAppState = installAppState(scene, renderer);
    const release: Array<() => void> = [];
    renderer.readRenderTargetPixelsAsync = (t: { width: number; height: number }) =>
      new Promise((resolve) => release.push(() => resolve(new Float32Array(t.width * t.height * 4).fill(1))));

    const pending = measureOverdraw(renderer as never, scene, camera);
    // Nothing has been awaited yet: both counts rendered, both read-backs started, and the app's state is back.
    expect(renderer.calls).toHaveLength(2);
    expect(release).toHaveLength(2);
    expectAppState();

    for (const r of release) r();
    await expect(pending).resolves.toEqual({ opaque: 1, transparent: 1 });
  });

  it('restores the state and rejects when a count render throws', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([]);
    const expectAppState = installAppState(scene, renderer);
    let renders = 0;
    renderer.render = () => {
      if (++renders === 2) throw new Error('device lost');
    };
    await expect(measureOverdraw(renderer as never, scene, camera)).rejects.toThrow('device lost');
    expectAppState();
  });

  it("clears the positionNode and displacementMap three's override copied when a draw throws before three puts them back", async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([]);
    const positionNode = float(1);
    const displacementMap = new DataTexture(new Uint8Array(4), 1, 1);
    const animated = new Mesh(new PlaneGeometry(), Object.assign(new MeshBasicNodeMaterial(), { positionNode, displacementMap }));
    drawEach(renderer, camera, [animated]);
    // Renderer.renderObject copies both onto the override (Renderer.js ~3744-3752) and puts them back after the draw
    // (~3805-3809), outside any finally: a draw that throws in between leaves the copies on the count material.
    renderer.renderObject = (_object: Object3D, s: Scene, _camera: Camera, _geometry: unknown, material: Material) => {
      const count = s.overrideMaterial as CountMaterial;
      count.positionNode = (material as CountMaterial).positionNode;
      count.displacementMap = (material as CountMaterial).displacementMap ?? null;
      throw new Error('pipeline failed');
    };

    await expect(measureOverdraw(renderer as never, scene, camera)).rejects.toThrow('pipeline failed');

    const count = renderer.calls[0]!.override!;
    expect([count.positionNode ?? null, count.displacementMap ?? null]).toEqual([null, null]);
  });

  it('decodes raw half-float read-backs (0x3C00 is 1.0)', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([]);
    renderer.readRenderTargetPixelsAsync = (t: { width: number; height: number }) => {
      const px = new Uint16Array(t.width * t.height * 4);
      for (let k = 0; k < t.width * t.height; k++) px[k * 4] = k % 2 === 0 ? 0x3c00 : 0x4000; // 1.0 and 2.0 alternating
      return Promise.resolve(px);
    };
    const result = await measureOverdraw(renderer as never, scene, camera);
    expect(result.opaque).toBeCloseTo(1.5, 6);
  });

  it('counts with a node material whose output is a constant: one per fragment whatever the colour, additive, no depth, one pass, unlit', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([0, 0]);
    await measureOverdraw(renderer as never, scene, camera);
    const m = renderer.calls[0]!.override!;
    expect(m.type).toBe('MeshBasicNodeMaterial');
    expectCountSettings(m);
  });

  it("draws each object with the count material carrying its own material's map, opacity, alphaHash and side, and skips what never writes colour", async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([0, 0]);
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const geometry = new PlaneGeometry();
    const cutout = new Mesh(geometry, new MeshBasicMaterial({ map, alphaMap: new DataTexture(new Uint8Array(4), 1, 1), opacity: 0.25, alphaHash: true, side: BackSide }));
    const plain = new Mesh(geometry, new MeshBasicMaterial());
    const noOverride = new Mesh(geometry, Object.assign(new MeshBasicMaterial(), { allowOverride: false }));
    const noColour = new Mesh(geometry, new MeshBasicMaterial({ colorWrite: false }));
    const proxy = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    proxy.userData.forge = { kind: 'occlusion-proxy' };
    drawEach(renderer, camera, [cutout, plain, noOverride, noColour, proxy]);

    await measureOverdraw(renderer as never, scene, camera);

    // Three's own override path in renderObject copies alphaTest, alphaMap and positionNode from the material it is given.
    expect(renderer.objectCalls.map((c) => [c.object, c.material])).toEqual([
      [cutout, cutout.material],
      [plain, plain.material],
      [cutout, cutout.material],
      [plain, plain.material],
    ]);
    expect(renderer.objectCalls[0]!.count).toEqual([map, 0.25, true, BackSide]);
    expect(renderer.objectCalls[1]!.count).toEqual([null, 1, false, FrontSide]);
    const count = renderer.objectCalls[0]!.override;
    expect([count.map, count.alphaMap]).toEqual([null, null]); // no texture kept alive between measurements
  });

  it("carries a node material's opacityNode, alphaTestNode and maskNode into the count for that draw only", async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([0, 0]);
    const [opacityNode, alphaTestNode, maskNode] = [float(0.5), float(0.25), float(1)];
    const cutout = new Mesh(new PlaneGeometry(), Object.assign(new MeshBasicNodeMaterial(), { opacityNode, alphaTestNode, maskNode }));
    const plain = new Mesh(new PlaneGeometry(), new MeshBasicMaterial());
    drawEach(renderer, camera, [cutout, plain]);

    await measureOverdraw(renderer as never, scene, camera);

    const [onCutout, onPlain] = renderer.objectCalls;
    expect(onCutout!.nodes[0]).toBe(opacityNode);
    expect(onCutout!.nodes[1]).toBe(alphaTestNode);
    expect(onCutout!.nodes[2]).toBe(maskNode);
    expect(onPlain!.nodes).toEqual([null, null, null]);
    const count = onCutout!.override;
    expect([count.opacityNode, count.alphaTestNode, count.maskNode]).toEqual([null, null, null]);
  });

  it('draws sprite materials with a sprite count material that billboards like its source, then puts the mesh count material back and drops what it copied', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = protocolRenderer([0, 0]);
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const [scaleNode, rotationNode] = [float(2), float(0.3)];
    // A plain Sprite with a classic material (three draws it as a SpriteNodeMaterial), and a World sprite batch: a Mesh
    // whose SpriteNodeMaterial places each instance with position and scale nodes. PointsNodeMaterial extends
    // SpriteNodeMaterial, but a Points object draws points (PointsNodeMaterial.setupVertex), so it keeps the mesh count.
    const sprite = new Sprite(new SpriteMaterial({ map, rotation: 0.5, sizeAttenuation: false, opacity: 0.5 }));
    const batch = new Mesh(new PlaneGeometry(), Object.assign(new SpriteNodeMaterial(), { scaleNode, rotationNode, side: BackSide }));
    const points = new Points(new PlaneGeometry(), new PointsNodeMaterial());
    const mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial());
    drawEach(renderer, camera, [sprite, batch, points, mesh]);

    await measureOverdraw(renderer as never, scene, camera);

    const [onSprite, onBatch, onPoints, onMesh] = renderer.objectCalls;
    expect([onSprite, onBatch, onPoints, onMesh].map((c) => c!.override.type)).toEqual(['SpriteNodeMaterial', 'SpriteNodeMaterial', 'MeshBasicNodeMaterial', 'MeshBasicNodeMaterial']);
    expect(onBatch!.override).toBe(onSprite!.override);
    // The scene's count material is back after each sprite draw.
    expect(onPoints!.override).toBe(renderer.calls[0]!.override);
    expect(onMesh!.override).toBe(renderer.calls[0]!.override);
    expect(onSprite!.count).toEqual([map, 0.5, false, FrontSide]);
    expect(onSprite!.sprite).toEqual([0.5, false, null, null]);
    expect(onBatch!.count).toEqual([null, 1, false, BackSide]);
    expect(onBatch!.sprite.slice(0, 2)).toEqual([0, true]);
    expect(onBatch!.sprite[2]).toBe(scaleNode);
    expect(onBatch!.sprite[3]).toBe(rotationNode);
    expect(scene.overrideMaterial).toBeNull();

    const spriteCount = onSprite!.override;
    expectCountSettings(spriteCount);
    expect([spriteCount.map, spriteCount.alphaMap, spriteCount.scaleNode, spriteCount.rotationNode]).toEqual([null, null, null, null]);
    let disposed = false;
    spriteCount.addEventListener('dispose', () => {
      disposed = true;
    });
    disposeOverdraw(renderer as never);
    expect(disposed).toBe(true);
  });

  it('a scene rendered inside a count render (a render-to-texture hook) keeps its own override and draws its sprites with their own materials', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = new FakeRenderer({ record: true });
    // Renderer._renderScene installs the render-object function for nested renders too (Renderer.js ~1736), so the
    // count's function also sees the draws of a scene an onBeforeRender renders during a count render.
    const bare = sceneWithCamera().scene;
    const bareSprite = new Sprite(new SpriteMaterial());
    bare.add(bareSprite);
    const overridden = sceneWithCamera().scene;
    const appOverride = new MeshBasicMaterial();
    overridden.overrideMaterial = appOverride;
    const overriddenSprite = new Sprite(new SpriteMaterial());
    overridden.add(overriddenSprite);
    // Transparent, so it draws in the transparent count render, whose renderer flags let the nested renders draw sprites.
    const mirror = new Mesh(new PlaneGeometry(), new MeshBasicMaterial({ transparent: true }));
    const nestedOverrides: unknown[] = [];
    mirror.onBeforeRender = () => {
      renderer.render(bare, camera);
      renderer.render(overridden, camera);
      nestedOverrides.push(bare.overrideMaterial, overridden.overrideMaterial);
    };
    scene.add(mirror);
    for (const s of [scene, bare, overridden]) s.updateMatrixWorld();

    await measureOverdraw(renderer as never, scene, camera);

    const drawOf = (object: Object3D) => renderer.passes.flatMap((p) => p.draws).find((d) => d.object === object);
    expect(drawOf(mirror)?.material.type).toBe('MeshBasicNodeMaterial');
    expect(drawOf(bareSprite)?.material).toBe(bareSprite.material);
    expect(drawOf(overriddenSprite)?.material).toBe(appOverride);
    expect(nestedOverrides).toEqual([null, appOverride]);
    expect([bare.overrideMaterial, overridden.overrideMaterial]).toEqual([null, appOverride]);
    disposeOverdraw(renderer);
  });

  it('keeps one count target and material per renderer until disposeOverdraw() releases them', async () => {
    const { scene, camera } = sceneWithCamera();
    const a = protocolRenderer([]);
    const b = protocolRenderer([]);
    await measureOverdraw(a as never, scene, camera);
    await measureOverdraw(a as never, scene, camera);
    await measureOverdraw(b as never, scene, camera);
    const [first, again] = [a.calls[0]!, a.calls[2]!];
    expect([again.target, again.override]).toEqual([first.target, first.override]);
    expect(again.target).toBe(first.target);
    expect(again.override).toBe(first.override);
    expect(b.calls[0]!.target).not.toBe(first.target);
    expect(b.calls[0]!.override).not.toBe(first.override);

    const disposed: string[] = [];
    (first.target as RenderTarget).addEventListener('dispose', () => disposed.push('a target'));
    first.override!.addEventListener('dispose', () => disposed.push('a material'));
    (b.calls[0]!.target as RenderTarget).addEventListener('dispose', () => disposed.push('b target'));
    b.calls[0]!.override!.addEventListener('dispose', () => disposed.push('b material'));
    disposeOverdraw(a as never);
    expect(disposed.sort()).toEqual(['a material', 'a target']);
    disposeOverdraw(a as never); // a second call finds nothing to release

    await measureOverdraw(a as never, scene, camera);
    expect(a.calls[4]!.target).not.toBe(first.target);
    expect(a.calls[4]!.override).not.toBe(first.override);
    expect(disposed).toHaveLength(2);
  });
});

describe('DrawCallLedger.measureOverdraw', () => {
  const depthOf = (ledger: DrawCallLedger) => (ledger as unknown as { depth: number }).depth;
  const box = new BoxGeometry(1, 1, 1);

  function setup() {
    const renderer = new FakeRenderer({ record: true });
    const ledger = new DrawCallLedger();
    ledger.attach(renderer as never);
    const { scene, camera } = sceneWithCamera();
    const mesh = new Mesh(box, new MeshBasicMaterial());
    scene.add(mesh, new Mesh(box, new MeshBasicMaterial({ transparent: true })));
    scene.updateMatrixWorld();
    return { renderer, ledger, scene, camera, mesh };
  }

  it('measured outside a render: no frame stays open and the next frame counts only its own draws', async () => {
    const { renderer, ledger, scene, camera } = setup();
    renderer.render(scene, camera);
    const plain = ledger.frame();
    await ledger.measureOverdraw(scene, camera);
    expect(depthOf(ledger)).toBe(0);
    renderer.render(scene, camera);
    const next = ledger.frame();
    expect(next.totals).toEqual(plain.totals);
    expect(next.passes.map((p) => p.id)).toEqual(['main']);
    expect(next.overdraw.measured).toBe(true);
  });

  it('measured from inside a render hook: the frame around it still ends, files only its own draws, and the next frame is a frame', async () => {
    const { renderer, ledger, scene, camera, mesh } = setup();
    let pending: Promise<unknown> | null = null;
    let started = false;
    mesh.onBeforeRender = () => {
      // The count renders draw this mesh too, before measureOverdraw() has returned.
      if (started) return;
      started = true;
      pending = ledger.measureOverdraw(scene, camera);
    };
    renderer.render(scene, camera);
    expect(pending).not.toBeNull();
    expect(depthOf(ledger)).toBe(0);
    const hooked = ledger.frame();
    expect(hooked.passes.map((p) => p.id)).toEqual(['main']);
    expect(hooked.totals.sceneSubmissions).toBe(2);
    await pending;
    expect(depthOf(ledger)).toBe(0);
    renderer.render(scene, camera);
    const next = ledger.frame();
    expect(next.passes.map((p) => p.id)).toEqual(['main']);
    expect(next.totals).toEqual(hooked.totals);
    expect(next.overdraw.measured).toBe(true);
  });

  it('detach() disposes the count target and material the ledger measured with', async () => {
    const { renderer, ledger, scene, camera, mesh } = setup();
    const seen = new Set<{ addEventListener(type: 'dispose', listener: () => void): void }>();
    const setRenderTarget = renderer.setRenderTarget.bind(renderer);
    renderer.setRenderTarget = (target, ...rest) => {
      if (target) seen.add(target as RenderTarget);
      setRenderTarget(target, ...rest);
    };
    mesh.onBeforeRender = (_r, s) => {
      if (s.overrideMaterial) seen.add(s.overrideMaterial);
    };
    await ledger.measureOverdraw(scene, camera);
    expect(seen.size).toBe(2);
    let disposed = 0;
    for (const resource of seen) resource.addEventListener('dispose', () => disposed++);
    ledger.detach();
    expect(disposed).toBe(2);
  });
});
