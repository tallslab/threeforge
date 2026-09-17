import {
  BackSide,
  CustomBlending,
  DataTexture,
  FrontSide,
  GreaterDepth,
  Group,
  IncrementStencilOp,
  type InstancedBufferGeometry,
  type Material,
  NotEqualStencilFunc,
  OneFactor,
  PerspectiveCamera,
  Plane,
  ReverseSubtractEquation,
  Scene,
  Sprite,
  SpriteMaterial,
  SubtractEquation,
  type Texture,
  Vector3,
  ZeroFactor,
} from 'three';
import { positionWorld, vec2, vec3 } from 'three/tsl';
import { ClippingGroup, type Node, type NodeBuilder, SpriteNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { FORGE_HOOK } from '../../src/compiler/culling.js';
import { FORGE_HIDDEN_LAYER, World } from '../../src/compiler/World.js';
import { attachedLedger } from './helpers/ledger.js';
import { webglRenderer } from './helpers/renderers.js';

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
  const { renderer, registry, ledger, scene, camera } = attachedLedger();
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

  it('skips sprites under a render-ordered Group or a ClippingGroup, naming the rule', () => {
    const { registry, ledger, scene } = attachedLedger();
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
    expect(report.skipped.filter((s) => s.name.startsWith('ordered-')).map((s) => s.rule)).toEqual(
      Array(6).fill('group-render-order'),
    );
    expect(report.skipped.filter((s) => s.name.startsWith('clipped-')).map((s) => s.rule)).toEqual(
      Array(6).fill('clipping-group'),
    );
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
    const keys = [...Object.keys(defaults), 'alphaTest'].filter(
      (k) => !/^(_|is[A-Z])|^(id|uuid|version|type)$/.test(k),
    );
    const field = (material: object, key: string): unknown => (material as Record<string, unknown>)[key];
    for (const mirrored of [false, true]) {
      const source = everyField();
      const notSet = keys.filter(
        (k) =>
          k !== 'side' && k !== 'visible' && JSON.stringify(field(source, k)) === JSON.stringify(field(defaults, k)),
      );
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
          // userData stays out of the copy (NodeMaterial.copy would JSON-serialise it).
          const want =
            key === 'side' ? (mirrored ? BackSide : FrontSide) : key === 'userData' ? {} : field(source, key);
          const same = (want as Texture | null)?.isTexture
            ? got === want
            : JSON.stringify(got) === JSON.stringify(want);
          if (!same) out.push(`${label}: ${key} ${JSON.stringify(got)} instead of ${JSON.stringify(want)}`);
        }
        if (material.positionNode === null || material.scaleNode === null) out.push(`${label}: instance nodes missing`);
        return out;
      };
      const label = mirrored ? 'mirrored' : 'unmirrored';
      const camera = new PerspectiveCamera(60, 1, 0.1, 100);
      camera.updateMatrixWorld();
      const atCompile = mismatches(`${label}, at compile`);
      batch.onBeforeRender(webglRenderer as never, scene, camera, batch.geometry, material as never, null as never);
      expect([...atCompile, ...mismatches(`${label}, after a render`)]).toEqual([]);
    }
  });

  it('compiles sprites with unserialisable userData, restores it, leaves the batch none', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['circular', circular],
      ['BigInt', { big: BigInt(1) }],
    ];
    for (const [label, userData] of cases) {
      const source = new SpriteMaterial({ color: 0xffffff });
      source.userData = userData;
      const scene = new Scene();
      sprites(scene, 4, source, label);
      const world = new World(scene);
      let spriteBatches = -1;
      expect(() => {
        spriteBatches = world.compile().after.spriteBatches;
      }, `${label}: compile`).not.toThrow();
      expect(spriteBatches, `${label}: batches`).toBe(1);
      expect(
        (world.spriteBatches[0]!.material as SpriteNodeMaterial).userData,
        `${label}: batch material userData`,
      ).toEqual({});
      expect(source.userData, `${label}: the source keeps its userData`).toBe(userData);
    }
  });

  it('skips, naming a rule, sprites with a node slot set or a count other than one', () => {
    // A node material with every slot null still batches.
    const scene = new Scene();
    const node = (set: (m: SpriteNodeMaterial) => void): SpriteMaterial => {
      const material = new SpriteNodeMaterial({ transparent: false });
      set(material);
      return material as unknown as SpriteMaterial;
    };
    sprites(
      scene,
      4,
      node((m) => (m.positionNode = vec3(0, 1, 0))),
      'bobbing',
    );
    sprites(
      scene,
      4,
      node((m) => (m.scaleNode = vec2(2, 2))),
      'pulsing',
    );
    sprites(
      scene,
      4,
      node((m) => (m.colorNode = positionWorld)),
      'world-coloured',
    );
    for (const s of sprites(scene, 4, new SpriteMaterial({ color: 0x00ff00 }), 'particles'))
      (s as Sprite & { count: number }).count = 3;
    sprites(
      scene,
      4,
      node(() => {}),
      'plain-node',
    );
    sprites(scene, 4, new SpriteMaterial({ color: 0xff0000 }), 'plain');
    scene.updateMatrixWorld(true);
    const report = new World(scene).compile();
    const prefixes = ['bobbing', 'pulsing', 'world-coloured', 'particles', 'plain-node', 'plain'];
    const rules = Object.fromEntries(
      prefixes.map((p) => [p, report.skipped.filter((s) => s.name.startsWith(`${p}-`)).map((s) => s.rule)]),
    );
    expect(rules).toEqual({
      bobbing: Array(4).fill('sprite-node-material'),
      pulsing: Array(4).fill('sprite-node-material'),
      'world-coloured': Array(4).fill('sprite-node-material'),
      particles: Array(4).fill('sprite-count'),
      'plain-node': [],
      plain: [],
    });
    expect(report.after.spriteBatches, 'the plain SpriteMaterial and the all-null node material').toBe(2);
  });

  /** A sprite node material class whose billboard placement is the app's own code. */
  class CustomPlacementSpriteMaterial extends SpriteNodeMaterial {
    override setupPositionView(builder: NodeBuilder): Node {
      return super.setupPositionView(builder);
    }
  }

  /** A classic sprite material class with its own shader hook. */
  class CustomCompileSpriteMaterial extends SpriteMaterial {
    override onBeforeCompile(): void {}
  }

  it.each<[string, () => Material]>([
    [
      'a SpriteNodeMaterial subclass overriding setupPositionView',
      () => new CustomPlacementSpriteMaterial({ transparent: false }),
    ],
    [
      'a SpriteMaterial subclass overriding onBeforeCompile',
      () => new CustomCompileSpriteMaterial({ transparent: false }),
    ],
    [
      'a SpriteNodeMaterial with an instance setup',
      () =>
        Object.assign(new SpriteNodeMaterial({ transparent: false }), {
          setup(this: SpriteNodeMaterial, builder: NodeBuilder): void {
            SpriteNodeMaterial.prototype.setup.call(this, builder);
          },
        }),
    ],
    [
      'a SpriteNodeMaterial with an instance onBeforeRender',
      () => Object.assign(new SpriteNodeMaterial({ transparent: false }), { onBeforeRender(): void {} }),
    ],
  ])(
    'leaves %s unbatched as sprite-custom-material: the batch builds a plain SpriteNodeMaterial and would drop that code',
    (label, make) => {
      const scene = new Scene();
      sprites(scene, 4, make() as unknown as SpriteMaterial, 'custom');
      sprites(scene, 4, new SpriteMaterial({ color: 0xff0000 }), 'plain');
      scene.updateMatrixWorld(true);
      const report = new World(scene).compile();
      expect(
        report.skipped.filter((s) => s.name.startsWith('custom-')).map((s) => s.rule),
        label,
      ).toEqual(Array(4).fill('sprite-custom-material'));
      expect(report.after.spriteBatches, `${label}: only the plain sprites batch`).toBe(1);
    },
  );
});

describe('World sprite batch material on decompile', () => {
  it('forgets and disposes a registered sprite batch material nothing merges into', () => {
    const { registry, ledger, scene } = setup();
    const world = new World(scene, { registry, ledger });
    world.compile();
    const material = world.spriteBatches[0]!.material as SpriteNodeMaterial;
    // The batch material is reachable through `world.spriteBatches`, so app code can register it.
    expect(registry.register(material as unknown as Material)).toBe(material);
    let disposed = 0;
    material.addEventListener('dispose', () => disposed++);
    world.decompile();
    expect(disposed, 'the World created it, so it is still disposed').toBe(1);
    expect(registry.describe(material as unknown as Material).outcome, 'and forgotten first').toBe('unregistered');
  });

  it('never leaves a live registered material resolving to a disposed sprite batch material', () => {
    const { registry, ledger, scene } = setup();
    const world = new World(scene, { registry, ledger });
    world.compile();
    const material = world.spriteBatches[0]!.material as SpriteNodeMaterial;
    expect(registry.register(material as unknown as Material)).toBe(material);
    const twin = material.clone();
    expect(registry.register(twin as unknown as Material), 'an identical material merges into the batch material').toBe(
      material,
    );
    let disposed = 0;
    material.addEventListener('dispose', () => disposed++);
    world.decompile();
    expect(disposed, 'disposing it would break every mesh drawn with the twin').toBe(0);
    expect(registry.canonicalOf(twin as unknown as Material), 'which still resolves to it').toBe(material);
    expect(registry.describe(material as unknown as Material).outcome, 'so it stays registered too').not.toBe(
      'unregistered',
    );
  });
});
