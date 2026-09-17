import {
  AddEquation,
  BackSide,
  BoxGeometry,
  Color,
  CustomBlending,
  DataTexture,
  FrontSide,
  HalfFloatType,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OneFactor,
  PlaneGeometry,
  Points,
  RenderTarget,
  type Scene,
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three';
import { float } from 'three/tsl';
import { MeshBasicNodeMaterial, PointsNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { disposeOverdraw, measureOverdraw } from '../../src/ledger/overdraw.js';
import { type FakePass, FakeRenderer, type RenderObjectFunction, sceneWithCamera } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';

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
  scaleNode?: unknown;
  rotationNode?: unknown;
  positionNode?: unknown;
  displacementMap?: Texture | null;
};
type NodeScene = Scene & { backgroundNode?: unknown };

const APP_MRT = { isMRTNode: true, name: 'app' };
const appRenderObject: RenderObjectFunction = () => {};

/** The count material's per-draw slots (its own, and what three's override path copies), read as each draw is issued. */
const SLOTS = [
  'map',
  'alphaMap',
  'opacity',
  'alphaHash',
  'side',
  'opacityNode',
  'alphaTestNode',
  'maskNode',
  'rotation',
  'sizeAttenuation',
  'scaleNode',
  'rotationNode',
] as const;

/**
 * A recording fake with an 800x600 drawing buffer whose read-backs average to `sums`, one per count render. `renders`
 * keeps the passes of every outermost render() call (the fake's own `passes` holds the last call only).
 */
function countRenderer(sums: number[] = []): FakeRenderer & { renders: FakePass[] } {
  const renderer = Object.assign(new FakeRenderer({ record: true, materialSlots: SLOTS }), {
    renders: [] as FakePass[],
  });
  renderer.drawingBufferSize.set(800, 600);
  renderer.readbacks = sums;
  const render = renderer.render.bind(renderer);
  let depth = 0;
  renderer.render = (scene, camera) => {
    depth++;
    try {
      render(scene, camera);
    } finally {
      if (--depth === 0) renderer.renders.push(...renderer.passes);
    }
  };
  return renderer;
}

/**
 * Puts app state on the scene and the renderer that differs from every value the count renders set (an override material,
 * a background and a background node, a cube-face target at mipmap level 2, an MRT, a render-object function, a clear
 * colour, no auto-clear, the transparent list only), and returns the check that all of it is back.
 */
function installAppState(scene: Scene, renderer: FakeRenderer): () => void {
  const background = new Color(0x336699);
  const backgroundNode = { isNode: true };
  const override = new MeshBasicMaterial();
  Object.assign(scene, { background, backgroundNode, overrideMaterial: override });
  const target = new RenderTarget(4, 4);
  renderer.setRenderTarget(target, 3, 2);
  renderer.setMRT(APP_MRT);
  renderer.setRenderObjectFunction(appRenderObject);
  renderer.setClearColor(new Color(0.2, 0.4, 0.6), 1);
  renderer.autoClear = false;
  renderer.autoClearColor = false;
  renderer.opaque = false;
  return () => {
    expect(scene.overrideMaterial).toBe(override);
    expect(scene.background).toBe(background);
    expect((scene as NodeScene).backgroundNode).toBe(backgroundNode);
    expect(renderer.getRenderTarget()).toBe(target);
    expect([renderer.getActiveCubeFace(), renderer.getActiveMipmapLevel()]).toEqual([3, 2]);
    expect(renderer.getMRT()).toBe(APP_MRT);
    expect(renderer.getRenderObjectFunction()).toBe(appRenderObject);
    expect([...renderer.getClearColor(new Color()).toArray(), renderer.getClearAlpha()]).toEqual([0.2, 0.4, 0.6, 1]);
    expect([renderer.autoClear, renderer.autoClearColor, renderer.opaque, renderer.transparent]).toEqual([
      false,
      false,
      false,
      true,
    ]);
  };
}

/** What every count material shares: a constant output, one per fragment whatever the colour, additive, no depth, one pass, unlit. */
function expectCountSettings(m: CountMaterial): void {
  expect(m.isNodeMaterial).toBe(true);
  // NodeMaterial.setup (three r186 ~547-549): a non-null outputNode replaces the diffuse result, so instance, batch and
  // vertex colours no longer scale the count, while setupDiffuseColor still runs its alphaTest and alphaHash discards.
  expect(m.outputNode?.node?.value?.toArray()).toEqual([1, 0, 0, 1]); // TSL's vec4(1, 0, 0, 1): a VarNode over a ConstNode
  expect([m.blending, m.blendSrc, m.blendDst, m.blendEquation]).toEqual([
    CustomBlending,
    OneFactor,
    OneFactor,
    AddEquation,
  ]);
  expect([m.depthTest, m.depthWrite, m.transparent, m.forceSinglePass]).toEqual([false, false, true, true]);
  expect([m.lights, m.fog, m.toneMapped]).toEqual([false, false, false]);
}

/** The draws of every count render, in issue order: the opaque render's, then the transparent render's. */
const drawsOf = (renderer: ReturnType<typeof countRenderer>) => renderer.renders.flatMap((p) => p.draws);

describe('measureOverdraw', () => {
  it('renders opaque then transparent into a 1/8 half-float target, background-free, cleared to 0 with no MRT, and averages the red channel', async () => {
    const { scene, camera } = sceneWithCamera();
    scene.background = new Color(0xffffff);
    const renderer = countRenderer([1.5, 0.75]);
    const result = await measureOverdraw(renderer as never, scene, camera);
    expect(result).toEqual({ opaque: 1.5, transparent: 0.75 });
    const states = renderer.renders.map((p) => p.state);
    expect(states.map((s) => [s.opaque, s.transparent])).toEqual([
      [true, false],
      [false, true],
    ]);
    for (const s of states) {
      expect(s.overrideMaterial?.type).toBe('MeshBasicNodeMaterial');
      expect([s.background, s.backgroundNode, s.mrt]).toEqual([null, null, null]);
      expect([s.clearColor, s.autoClear, s.autoClearColor]).toEqual([[0, 0, 0, 0], true, true]);
      expect(typeof s.renderObjectFunction).toBe('function'); // the count's own, installed for both renders
    }
    const target = renderer.renders[0]!.renderTarget as RenderTarget;
    expect(renderer.renders[1]!.renderTarget).toBe(target);
    expect([target.width, target.height]).toEqual([128, 96]); // 800x600 / 8 rounded up to 32-texel rows (no read-back padding)
    expect([target.texture.type, target.depthBuffer, target.stencilBuffer]).toEqual([HalfFloatType, false, false]);
  });

  it('restores every scene and renderer state it changed before it awaits the read-backs', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
    const expectAppState = installAppState(scene, renderer);
    const release: Array<() => void> = [];
    renderer.readRenderTargetPixelsAsync = (t: { width: number; height: number }) =>
      new Promise((resolve) => release.push(() => resolve(new Float32Array(t.width * t.height * 4).fill(1))));

    const pending = measureOverdraw(renderer as never, scene, camera);
    // Nothing has been awaited yet: both counts rendered, both read-backs started, and the app's state is back.
    expect(renderer.info.render.calls).toBe(2);
    expect(release).toHaveLength(2);
    expectAppState();

    for (const r of release) r();
    await expect(pending).resolves.toEqual({ opaque: 1, transparent: 1 });
  });

  it('restores the state and rejects when a count render throws', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
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
    const renderer = countRenderer();
    const positionNode = float(1);
    const displacementMap = new DataTexture(new Uint8Array(4), 1, 1);
    const animated = new Mesh(
      new PlaneGeometry(),
      Object.assign(new MeshBasicNodeMaterial(), { positionNode, displacementMap }),
    );
    scene.add(animated);
    // Renderer.renderObject copies both onto the override (Renderer.js ~3744-3752) and puts them back after the draw
    // (~3805-3809), outside any finally: a draw that throws in between leaves the copies on the count material. The fake
    // makes the same copies, then reads the geometry to size the draw: this throw lands between them.
    Object.defineProperty(animated.geometry, 'drawRange', {
      get() {
        throw new Error('pipeline failed');
      },
    });

    await expect(measureOverdraw(renderer as never, scene, camera)).rejects.toThrow('pipeline failed');

    const count = renderer.passes[0]!.state.overrideMaterial as CountMaterial;
    expect([count.positionNode ?? null, count.displacementMap ?? null]).toEqual([null, null]);
  });

  it('decodes raw half-float read-backs (0x3C00 is 1.0)', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
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
    const renderer = countRenderer();
    await measureOverdraw(renderer as never, scene, camera);
    const m = renderer.renders[0]!.state.overrideMaterial as CountMaterial;
    expect(m.type).toBe('MeshBasicNodeMaterial');
    expectCountSettings(m);
  });

  it("draws each object with the count material carrying its own material's map, opacity, alphaHash and side, and skips what never writes colour", async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const alphaMap = new DataTexture(new Uint8Array(4), 1, 1);
    const geometry = new PlaneGeometry();
    const cutout = new Mesh(
      geometry,
      new MeshBasicMaterial({ map, alphaMap, opacity: 0.25, alphaHash: true, side: BackSide }),
    );
    const plain = new Mesh(geometry, new MeshBasicMaterial());
    const noOverride = new Mesh(geometry, Object.assign(new MeshBasicMaterial(), { allowOverride: false }));
    const noColour = new Mesh(geometry, new MeshBasicMaterial({ colorWrite: false }));
    const proxy = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    proxy.userData.forge = { kind: 'occlusion-proxy' };
    scene.add(cutout, plain, noOverride, noColour, proxy);
    scene.updateMatrixWorld();

    await measureOverdraw(renderer as never, scene, camera);

    // Every material here is opaque, so the opaque count render draws what is counted and the transparent one nothing.
    const draws = drawsOf(renderer);
    expect(draws.map((d) => [d.object, d.source])).toEqual([
      [cutout, cutout.material],
      [plain, plain.material],
    ]);
    // Three's own override path in renderObject copies alphaTest and alphaMap from the material it is given.
    expect(draws[0]!.slots).toMatchObject({ map, alphaMap, opacity: 0.25, alphaHash: true, side: BackSide });
    expect(draws[1]!.slots).toMatchObject({ map: null, alphaMap: null, opacity: 1, alphaHash: false, side: FrontSide });
    const count = draws[0]!.material as CountMaterial;
    expect([count.map, count.alphaMap]).toEqual([null, null]); // no texture kept alive between measurements
  });

  it('counts an object whose userData is null instead of throwing', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
    const geometry = new PlaneGeometry();
    const plain = new Mesh(geometry, new MeshBasicMaterial());
    const stray = new Mesh(geometry, new MeshBasicMaterial());
    // app code and non-three loaders assign null, and Object3D.copy propagates it to every clone; three draws it fine.
    (stray as { userData: unknown }).userData = null;
    scene.add(plain, stray);
    scene.updateMatrixWorld();

    await measureOverdraw(renderer as never, scene, camera);

    // Counted like any other object: a null userData simply carries no `forge` kind, so it is not an occlusion proxy.
    expect(drawsOf(renderer).map((d) => d.object)).toEqual([plain, stray]);
  });

  it("carries a node material's opacityNode, alphaTestNode and maskNode into the count for that draw only", async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
    const [opacityNode, alphaTestNode, maskNode] = [float(0.5), float(0.25), float(1)];
    const cutout = new Mesh(
      new PlaneGeometry(),
      Object.assign(new MeshBasicNodeMaterial(), { opacityNode, alphaTestNode, maskNode }),
    );
    const plain = new Mesh(new PlaneGeometry(), new MeshBasicMaterial());
    scene.add(cutout, plain);
    scene.updateMatrixWorld();

    await measureOverdraw(renderer as never, scene, camera);

    const [onCutout, onPlain] = drawsOf(renderer);
    expect(onCutout!.slots!.opacityNode).toBe(opacityNode);
    expect(onCutout!.slots!.alphaTestNode).toBe(alphaTestNode);
    expect(onCutout!.slots!.maskNode).toBe(maskNode);
    expect(onPlain!.slots).toMatchObject({ opacityNode: null, alphaTestNode: null, maskNode: null });
    const count = onCutout!.material as CountMaterial;
    expect([count.opacityNode, count.alphaTestNode, count.maskNode]).toEqual([null, null, null]);
  });

  it('draws sprite materials with a sprite count material that billboards like its source, then puts the mesh count material back and drops what it copied', async () => {
    const { scene, camera } = sceneWithCamera();
    const renderer = countRenderer();
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const [scaleNode, rotationNode] = [float(2), float(0.3)];
    // A plain Sprite with a classic material (three draws it as a SpriteNodeMaterial), and a World sprite batch: a Mesh
    // whose SpriteNodeMaterial places each instance with position and scale nodes. PointsNodeMaterial extends
    // SpriteNodeMaterial, but a Points object draws points (PointsNodeMaterial.setupVertex), so it keeps the mesh count.
    const sprite = new Sprite(new SpriteMaterial({ map, rotation: 0.5, sizeAttenuation: false, opacity: 0.5 }));
    const batch = new Mesh(
      new PlaneGeometry(),
      Object.assign(new SpriteNodeMaterial(), { scaleNode, rotationNode, side: BackSide }),
    );
    const points = new Points(new PlaneGeometry(), new PointsNodeMaterial());
    const mesh = new Mesh(new PlaneGeometry(), new MeshBasicMaterial());
    scene.add(sprite, batch, points, mesh);
    scene.updateMatrixWorld();

    await measureOverdraw(renderer as never, scene, camera);

    // Sprite materials, PointsNodeMaterial included, are transparent by default: the mesh draws in the opaque count
    // render, the rest in the transparent one.
    const draws = drawsOf(renderer);
    expect(draws.map((d) => d.object)).toEqual([mesh, sprite, batch, points]);
    const drawOf = (object: Object3D) => draws.find((d) => d.object === object)!;
    const [onSprite, onBatch, onPoints, onMesh] = [sprite, batch, points, mesh].map(drawOf);
    expect([onSprite, onBatch, onPoints, onMesh].map((d) => d!.material.type)).toEqual([
      'SpriteNodeMaterial',
      'SpriteNodeMaterial',
      'MeshBasicNodeMaterial',
      'MeshBasicNodeMaterial',
    ]);
    expect(onBatch!.material).toBe(onSprite!.material);
    // The scene's count material is back after each sprite draw.
    expect(onPoints!.material).toBe(renderer.renders[0]!.state.overrideMaterial);
    expect(onMesh!.material).toBe(renderer.renders[0]!.state.overrideMaterial);
    expect(onSprite!.slots).toMatchObject({
      map,
      opacity: 0.5,
      alphaHash: false,
      side: FrontSide,
      rotation: 0.5,
      sizeAttenuation: false,
      scaleNode: null,
      rotationNode: null,
    });
    expect(onBatch!.slots).toMatchObject({ map: null, opacity: 1, alphaHash: false, side: BackSide });
    expect(onBatch!.slots).toMatchObject({ rotation: 0, sizeAttenuation: true });
    expect(onBatch!.slots!.scaleNode).toBe(scaleNode);
    expect(onBatch!.slots!.rotationNode).toBe(rotationNode);
    expect(scene.overrideMaterial).toBeNull();

    const spriteCount = onSprite!.material as CountMaterial;
    expectCountSettings(spriteCount);
    expect([spriteCount.map, spriteCount.alphaMap, spriteCount.scaleNode, spriteCount.rotationNode]).toEqual([
      null,
      null,
      null,
      null,
    ]);
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
    // A count render draws into the count target, and so do the nested renders inside it: three applies its output
    // colour transform only when writing the output target (Renderer.js:1563, :2686), so none of these passes draws an
    // "Output Color Transform" quad and no count includes one.
    expect(renderer.passes.flatMap((p) => p.draws).filter((d) => d.object === renderer.outputQuad)).toEqual([]);
    disposeOverdraw(renderer);
  });

  it('keeps one count target and material per renderer until disposeOverdraw() releases them', async () => {
    const { scene, camera } = sceneWithCamera();
    const a = countRenderer();
    const b = countRenderer();
    await measureOverdraw(a as never, scene, camera);
    await measureOverdraw(a as never, scene, camera);
    await measureOverdraw(b as never, scene, camera);
    const [first, again] = [a.renders[0]!, a.renders[2]!];
    expect(again.renderTarget).toBe(first.renderTarget);
    expect(again.state.overrideMaterial).toBe(first.state.overrideMaterial);
    expect(b.renders[0]!.renderTarget).not.toBe(first.renderTarget);
    expect(b.renders[0]!.state.overrideMaterial).not.toBe(first.state.overrideMaterial);

    const disposed: string[] = [];
    (first.renderTarget as RenderTarget).addEventListener('dispose', () => disposed.push('a target'));
    first.state.overrideMaterial!.addEventListener('dispose', () => disposed.push('a material'));
    (b.renders[0]!.renderTarget as RenderTarget).addEventListener('dispose', () => disposed.push('b target'));
    b.renders[0]!.state.overrideMaterial!.addEventListener('dispose', () => disposed.push('b material'));
    disposeOverdraw(a as never);
    expect(disposed.sort()).toEqual(['a material', 'a target']);
    disposeOverdraw(a as never); // a second call finds nothing to release

    await measureOverdraw(a as never, scene, camera);
    expect(a.renders[4]!.renderTarget).not.toBe(first.renderTarget);
    expect(a.renders[4]!.state.overrideMaterial).not.toBe(first.state.overrideMaterial);
    expect(disposed).toHaveLength(2);
  });
});

describe('DrawCallLedger.measureOverdraw', () => {
  const depthOf = (ledger: DrawCallLedger) => (ledger as unknown as { depth: number }).depth;
  const box = new BoxGeometry(1, 1, 1);

  function setup() {
    const { renderer, ledger, scene, camera } = attachedLedger({ record: true });
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
