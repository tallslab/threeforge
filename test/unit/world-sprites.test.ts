import { describe, expect, it } from 'vitest';
import {
  BackSide,
  CustomBlending,
  DataTexture,
  FrontSide,
  GreaterDepth,
  Group,
  IncrementStencilOp,
  InstancedBufferGeometry,
  NotEqualStencilFunc,
  OneFactor,
  PerspectiveCamera,
  Plane,
  ReverseSubtractEquation,
  Scene,
  Sprite,
  SpriteMaterial,
  SubtractEquation,
  Vector3,
  WebGLCoordinateSystem,
  ZeroFactor,
  type Texture,
} from 'three';
import { ClippingGroup, SpriteNodeMaterial } from 'three/webgpu';
import { color, float, vec2, vec3, vec4 } from 'three/tsl';
import { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { FORGE_HOOK } from '../../src/compiler/culling.js';
import { FakeRenderer, sceneWithCamera } from './helpers/fakeRenderer.js';

function sprites(scene: Scene, n: number, material: SpriteMaterial, prefix: string): Sprite[] {
  const out: Sprite[] = [];
  for (let i = 0; i < n; i++) {
    const s = new Sprite(material);
    s.name = `${prefix}-${i}`;
    s.position.set(i, 0, -5 - i);
    scene.add(s);
    out.push(s);
  }
  return out;
}

function setup() {
  const renderer = new FakeRenderer();
  const registry = new MaterialRegistry();
  const ledger = new DrawCallLedger({ registry });
  ledger.attach(renderer as never);
  const { scene, camera } = sceneWithCamera();
  const rain = sprites(scene, 6, new SpriteMaterial({ color: 0xffffff, transparent: true, depthWrite: false }), 'rain');
  const hits = sprites(scene, 6, new SpriteMaterial({ color: 0xff4040, transparent: true }), 'hit');
  const singles = sprites(scene, 2, new SpriteMaterial({ color: 0x00ff00 }), 'bar');
  return { renderer, registry, ledger, scene, camera, rain, hits, singles };
}

describe('World sprite batching', () => {
  it('batches sprites per material, hides originals, syncs per frame and restores on decompile', () => {
    const { renderer, registry, ledger, scene, camera, rain, hits, singles } = setup();
    const world = new World(scene, { registry, ledger });
    const report = world.compile();
    expect(report.after.spriteBatches).toBe(2);
    expect(report.skipped.filter((s) => s.rule === 'sprite-threshold').map((s) => s.name)).toEqual(['bar-0', 'bar-1']);
    expect(world.spriteBatches.map((m) => m.name.startsWith('forge:sprites:'))).toEqual([true, true]);
    for (const s of [...rain, ...hits]) expect(s.layers.mask).toBe((1 << FORGE_HIDDEN_LAYER) >>> 0);
    for (const s of singles) expect(s.layers.mask).toBe(1);
    const batch = world.spriteBatches[0]!;
    expect((batch.userData.forge as { kind: string }).kind).toBe('sprites');
    expect((batch.geometry as InstancedBufferGeometry).instanceCount).toBe(6);
    expect((batch.onBeforeRender as unknown as Record<symbol, boolean>)[FORGE_HOOK]).toBe(true);
    rain[2]!.visible = false;
    renderer.render(scene, camera);
    const frame = ledger.frame({ items: true });
    expect(frame.byReason['sprite-batch']?.submissions).toBe(2);
    expect(frame.byReason.sprite?.submissions).toBe(2);
    expect(frame.overdraw.particles).toBe(6 + 6 + 2);
    expect(frame.totals.unattributed).toBe(0);
    world.decompile();
    for (const s of [...rain, ...hits]) expect(s.layers.mask).toBe(1);
    expect(scene.children.some((c) => c.name.startsWith('forge:sprites:'))).toBe(false);
    renderer.render(scene, camera);
    // rain-2 was hidden above and stays hidden: 14 sprites minus one.
    expect(ledger.frame().byReason.sprite?.submissions).toBe(13);
  });

  it("leaves sprites alone with sprites: 'keep' and honours spriteThreshold", () => {
    const { registry, ledger, scene } = setup();
    expect(new World(scene, { registry, ledger, sprites: 'keep' }).compile().after.spriteBatches).toBe(0);
    const { registry: r2, ledger: l2, scene: s2 } = setup();
    const report = new World(s2, { registry: r2, ledger: l2, spriteThreshold: 2 }).compile();
    expect(report.after.spriteBatches).toBe(3);
  });

  it('skips sprites under a render-ordered Group ancestor or an enabled ClippingGroup ancestor, naming the rule (root threaded from the scene)', () => {
    const renderer = new FakeRenderer();
    const registry = new MaterialRegistry();
    const ledger = new DrawCallLedger({ registry });
    ledger.attach(renderer as never);
    const { scene } = sceneWithCamera();
    const shared = new SpriteMaterial({ color: 0xffffff });
    const ordered = new Group();
    ordered.renderOrder = 3;
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(shared);
      s.name = `ordered-${i}`;
      ordered.add(s);
    }
    scene.add(ordered);
    const clipper = new ClippingGroup();
    const clipped: Sprite[] = [];
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(shared);
      s.name = `clipped-${i}`;
      clipper.add(s);
      clipped.push(s);
    }
    scene.add(clipper);
    const world = new World(scene, { registry, ledger });
    const report = world.compile();
    expect(report.skipped.filter((s) => s.name.startsWith('ordered-')).map((s) => s.rule)).toEqual(Array(6).fill('group-render-order'));
    expect(report.skipped.filter((s) => s.name.startsWith('clipped-')).map((s) => s.rule)).toEqual(Array(6).fill('clipping-group'));
  });
});

describe('World sprite batch material', () => {
  /** A sprite material with every field off its default, except `side` (FrontSide shows the mirrored swap) and `visible` (hidden sprites are not batched). */
  function everyField(): SpriteMaterial {
    const material = new SpriteMaterial({
      name: 'every-field',
      color: 0x3366cc,
      map: new DataTexture(new Uint8Array(16), 2, 2),
      alphaMap: new DataTexture(new Uint8Array(16), 2, 2),
      rotation: 0.4,
      sizeAttenuation: false,
      fog: false,
      transparent: false,
      opacity: 0.8,
      alphaTest: 0.25,
      alphaHash: true,
      alphaToCoverage: true,
      premultipliedAlpha: true,
      vertexColors: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: ZeroFactor,
      blendEquation: ReverseSubtractEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: ZeroFactor,
      blendEquationAlpha: SubtractEquation,
      blendAlpha: 0.5,
      depthFunc: GreaterDepth,
      depthTest: false,
      depthWrite: false,
      stencilWriteMask: 0x0f,
      stencilFunc: NotEqualStencilFunc,
      stencilRef: 3,
      stencilFuncMask: 0x0f,
      stencilFail: IncrementStencilOp,
      stencilZFail: IncrementStencilOp,
      stencilZPass: IncrementStencilOp,
      stencilWrite: true,
      clippingPlanes: [new Plane(new Vector3(0, 1, 0), 2)],
      clipIntersection: true,
      clipShadows: true,
      shadowSide: BackSide,
      colorWrite: false,
      precision: 'mediump',
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 3,
      dithering: true,
      forceSinglePass: true,
      allowOverride: false,
      toneMapped: false,
    });
    material.blendColor.set(0x102030);
    material.userData = { kind: 'rain' };
    return material;
  }

  it("takes every field of the sprites' material (alphaMap and alphaTest included), then its own instance nodes; under a mirrored scene the side stays fitted", () => {
    const defaults = new SpriteMaterial();
    const keys = [...Object.keys(defaults), 'alphaTest'].filter((k) => !/^(_|is[A-Z])|^(id|uuid|version|type)$/.test(k));
    const field = (material: object, key: string): unknown => (material as Record<string, unknown>)[key];
    for (const mirrored of [false, true]) {
      const source = everyField();
      const notSet = keys.filter((k) => k !== 'side' && k !== 'visible' && JSON.stringify(field(source, k)) === JSON.stringify(field(defaults, k)));
      expect(notSet, 'fields the fixture leaves at their default').toEqual([]);
      const scene = new Scene();
      sprites(scene, 4, source, 'every');
      if (mirrored) scene.scale.x = -1;
      scene.updateMatrixWorld(true);
      const world = new World(scene);
      expect(world.compile().after.spriteBatches).toBe(1);
      const batch = world.spriteBatches[0]!;
      const material = batch.material as SpriteNodeMaterial;
      const mismatches = (label: string): string[] => {
        const out: string[] = [];
        for (const key of keys) {
          const got = field(material, key);
          const want = key === 'side' ? (mirrored ? BackSide : FrontSide) : field(source, key);
          const same = (want as Texture | null)?.isTexture ? got === want : JSON.stringify(got) === JSON.stringify(want);
          if (!same) out.push(`${label}: ${key} ${JSON.stringify(got)} instead of ${JSON.stringify(want)}`);
        }
        if (material.positionNode === null || material.scaleNode === null) out.push(`${label}: instance nodes missing`);
        return out;
      };
      const label = mirrored ? 'mirrored' : 'unmirrored';
      const camera = new PerspectiveCamera(60, 1, 0.1, 100);
      camera.updateMatrixWorld();
      const atCompile = mismatches(`${label}, at compile`);
      batch.onBeforeRender({ coordinateSystem: WebGLCoordinateSystem } as never, scene, camera, batch.geometry, material as never, null as never);
      expect([...atCompile, ...mismatches(`${label}, after a render`)]).toEqual([]);
    }
  });

  it("from a node material takes its node slots too, but places the instances itself: the source's position, scale and vertex nodes are not carried", () => {
    const source = new SpriteNodeMaterial({ transparent: false });
    source.colorNode = color(1, 0, 0);
    source.opacityNode = float(0.5);
    source.rotationNode = float(0.3);
    source.positionNode = vec3(0, 1, 0);
    source.scaleNode = vec2(2, 2);
    source.vertexNode = vec4(0, 0, 0, 1);
    const scene = new Scene();
    sprites(scene, 4, source as unknown as SpriteMaterial, 'node');
    scene.updateMatrixWorld(true);
    const world = new World(scene);
    expect(world.compile().after.spriteBatches).toBe(1);
    const material = world.spriteBatches[0]!.material as SpriteNodeMaterial;
    expect({ color: material.colorNode === source.colorNode, opacity: material.opacityNode === source.opacityNode, rotation: material.rotationNode === source.rotationNode }, 'node slots carried').toEqual({ color: true, opacity: true, rotation: true });
    expect(
      { position: material.positionNode !== null && material.positionNode !== source.positionNode, scale: material.scaleNode !== null && material.scaleNode !== source.scaleNode, vertex: material.vertexNode },
      'instance placement kept',
    ).toEqual({ position: true, scale: true, vertex: null });
  });
});
