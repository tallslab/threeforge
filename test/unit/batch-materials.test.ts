import * as THREE from 'three';
import { BoxGeometry, Color, type Material, Mesh, MeshStandardMaterial, Scene } from 'three';
import * as WEBGPU from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { hasOwnFunctions } from '../../src/compiler/materialCode.js';
import { World } from '../../src/compiler/World.js';
import { isBuiltInMaterial } from '../../src/registry/builtInMaterials.js';
import { tag } from '../../src/tags.js';

/** three r186's material classes, from `src/materials/Materials.js` and `src/materials/nodes/NodeMaterials.js`. */
const CLASSIC = [
  'LineBasicMaterial',
  'LineDashedMaterial',
  'Material',
  'MeshBasicMaterial',
  'MeshDepthMaterial',
  'MeshDistanceMaterial',
  'MeshLambertMaterial',
  'MeshMatcapMaterial',
  'MeshNormalMaterial',
  'MeshPhongMaterial',
  'MeshPhysicalMaterial',
  'MeshStandardMaterial',
  'MeshToonMaterial',
  'PointsMaterial',
  'RawShaderMaterial',
  'ShaderMaterial',
  'ShadowMaterial',
  'SpriteMaterial',
] as const;
const NODE = [
  'Line2NodeMaterial',
  'LineBasicNodeMaterial',
  'LineDashedNodeMaterial',
  'MeshBasicNodeMaterial',
  'MeshLambertNodeMaterial',
  'MeshMatcapNodeMaterial',
  'MeshNormalNodeMaterial',
  'MeshPhongNodeMaterial',
  'MeshPhysicalNodeMaterial',
  'MeshSSSNodeMaterial',
  'MeshStandardNodeMaterial',
  'MeshToonNodeMaterial',
  'NodeMaterial',
  'PointsNodeMaterial',
  'ShadowNodeMaterial',
  'SpriteNodeMaterial',
  'VolumeNodeMaterial',
] as const;
const construct = (namespace: Record<string, unknown>, name: string): Material =>
  new (namespace[name] as new () => Material)();

describe('built-in material checks', () => {
  it.each([...CLASSIC.map((name) => ['three', name] as const), ...NODE.map((name) => ['three/webgpu', name] as const)])(
    'isBuiltInMaterial accepts %s %s, and rejects a subclass of it',
    (from, name) => {
      const namespace = (from === 'three' ? THREE : WEBGPU) as unknown as Record<string, unknown>;
      expect(isBuiltInMaterial(construct(namespace, name))).toBe(true);
      const Sub = class extends (namespace[name] as new () => Material) {};
      expect(isBuiltInMaterial(new Sub())).toBe(false);
    },
  );

  it('the list covers every material class three and three/webgpu export', () => {
    const exported = new Set<string>();
    for (const namespace of [THREE, WEBGPU] as unknown as Array<Record<string, unknown>>) {
      for (const [name, value] of Object.entries(namespace)) {
        if (
          typeof value === 'function' &&
          name.endsWith('Material') &&
          (() => {
            try {
              return new (value as new () => { isMaterial?: boolean })().isMaterial === true;
            } catch {
              return false;
            }
          })()
        )
          exported.add(name);
      }
    }
    expect([...exported].sort()).toEqual([...CLASSIC, ...NODE].sort());
  });

  it('hasOwnFunctions is false for every fresh built-in material and true once code is assigned to an instance', () => {
    for (const name of CLASSIC)
      expect(hasOwnFunctions(construct(THREE as unknown as Record<string, unknown>, name)), name).toBe(false);
    for (const name of NODE)
      expect(hasOwnFunctions(construct(WEBGPU as unknown as Record<string, unknown>, name)), name).toBe(false);
    expect(hasOwnFunctions(Object.assign(new MeshStandardMaterial(), { onBeforeRender: () => {} }))).toBe(true);
    expect(hasOwnFunctions(Object.assign(new MeshStandardNodeMaterial(), { setupOutput: () => {} }))).toBe(true);
  });
});

describe('tinted-group material clones keep the source material code', () => {
  const tints = [0xff0000, 0x00ff00, 0x0000ff];
  /** Three statics sharing one geometry, each with its own tinted copy of the same material code. */
  function tintedScene(material: (i: number) => Material): { scene: Scene; sources: Material[] } {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const sources: Material[] = [];
    for (let i = 0; i < 3; i++) {
      const source = material(i);
      sources.push(source);
      const mesh = new Mesh(geometry, source);
      mesh.position.x = i * 2;
      tag.static(mesh);
      scene.add(mesh);
    }
    scene.updateMatrixWorld(true);
    return { scene, sources };
  }
  const paths = {
    batched: { options: {}, material: (world: World) => world.batchedMeshes[0]!.material as Material },
    instanced: {
      options: { instanceThreshold: 2 },
      material: (world: World) => world.instancedMeshes[0]!.material as Material,
    },
    baked: { options: { bake: true }, material: (world: World) => world.bakedMeshes[0]!.material as Material },
  } as const;
  /**
   * The paths a source with an instance function reaches: under `bake: true` such a group is batched, since the bake cannot
   * prove what the function reads (`bakeProvesReads`), so the clone these cases check is the batch's.
   */
  const functionPaths = ['batched', 'instanced'] as const;

  it('a tinted group whose source carries an instance function is batched, not baked, under bake: true, and counted', () => {
    const setupOutput = function (
      this: MeshStandardNodeMaterial,
      ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>
    ) {
      return MeshStandardNodeMaterial.prototype.setupOutput.apply(this, args);
    };
    const { scene } = tintedScene((i) =>
      Object.assign(new MeshStandardNodeMaterial({ color: tints[i]! }), { setupOutput }),
    );
    const world = new World(scene, { bake: true });
    const report = world.compile();
    expect(world.bakedMeshes).toHaveLength(0);
    expect(world.batchedMeshes).toHaveLength(1);
    expect(report.bake).toEqual(expect.objectContaining({ groups: 0, unbakeableEntries: 3 }));
  });

  it.each(functionPaths)(
    "the %s material keeps a classic source's onBeforeCompile, customProgramCacheKey, defines and alphaTest",
    (path) => {
      const onBeforeCompile = (): void => {};
      const customProgramCacheKey = (): string => 'custom-program';
      const { scene, sources } = tintedScene((i) =>
        Object.assign(new MeshStandardMaterial({ color: tints[i]!, alphaTest: 0.5 }), {
          onBeforeCompile,
          customProgramCacheKey,
          defines: { STANDARD: '', MY_DEFINE: '' },
        }),
      );
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      expect(material.onBeforeCompile, 'onBeforeCompile').toBe(onBeforeCompile);
      expect(material.customProgramCacheKey, 'customProgramCacheKey').toBe(customProgramCacheKey);
      expect((material as MeshStandardMaterial).defines, 'defines').toEqual({ STANDARD: '', MY_DEFINE: '' });
      expect((material as MeshStandardMaterial).defines, 'defines is a copy').not.toBe(
        (sources[0] as MeshStandardMaterial).defines,
      );
      expect(material.alphaTest, 'alphaTest').toBe(0.5);
    },
  );

  it.each(functionPaths)("the %s material keeps a node source's instance setupOutput and alphaTest", (path) => {
    const setupOutput = function (
      this: MeshStandardNodeMaterial,
      ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>
    ) {
      return MeshStandardNodeMaterial.prototype.setupOutput.apply(this, args);
    };
    const { scene, sources } = tintedScene((i) => {
      const material = Object.assign(new MeshStandardNodeMaterial({ color: tints[i]! }), { setupOutput });
      material.alphaTest = 0.5;
      return material;
    });
    const world = new World(scene, paths[path].options);
    world.compile();
    const material = paths[path].material(world);
    expect(sources, 'a tinted group renders with a clone').not.toContain(material);
    expect((material as MeshStandardNodeMaterial).setupOutput, 'setupOutput').toBe(setupOutput);
    expect(material.alphaTest, 'alphaTest').toBe(0.5);
  });

  const kinds = {
    classic: (color: number): Material => new MeshStandardMaterial({ color }),
    node: (color: number): Material => new MeshStandardNodeMaterial({ color }),
  } as const;
  const pathsByKind = (Object.keys(paths) as Array<keyof typeof paths>).flatMap((path) =>
    (Object.keys(kinds) as Array<keyof typeof kinds>).map((kind) => [path, kind] as const),
  );

  it.each(pathsByKind)(
    'the %s material of a %s source keeps user-added own properties by reference (object and primitive)',
    (path, kind) => {
      const extra = { uTint: { value: new Color(1, 0.5, 0.25) } };
      const { scene, sources } = tintedScene((i) =>
        Object.assign(kinds[kind](tints[i]!), { extra, surface: 'crate', wear: 3 }),
      );
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world) as Material & { extra?: unknown; surface?: unknown; wear?: unknown };
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      expect(material.extra, 'object').toBe(extra);
      expect(material.surface, 'string').toBe('crate');
      expect(material.wear, 'number').toBe(3);
    },
  );

  it.each(pathsByKind)(
    "the %s material of a %s source shares the source's userData object, so values set through the source reach it",
    (path, kind) => {
      const { scene, sources } = tintedScene((i) => {
        const material = kinds[kind](tints[i]!);
        material.userData.uTime = { value: 0 };
        return material;
      });
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      expect(
        sources.map((source) => source.userData),
        "the clone's userData is its source's own object",
      ).toContain(material.userData);
    },
  );

  it.each(functionPaths)(
    'the %s material runs a classic onBeforeCompile that reads a user-added property through `this`',
    (path) => {
      const extra = { uTint: { value: new Color(1, 0.5, 0.25) } };
      const onBeforeCompile = function (
        this: { extra: typeof extra },
        shader: { uniforms: Record<string, unknown> },
      ): void {
        shader.uniforms.uTint = this.extra.uTint;
      };
      const { scene, sources } = tintedScene((i) =>
        Object.assign(new MeshStandardMaterial({ color: tints[i]! }), { extra, onBeforeCompile }),
      );
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      // WebGLRenderer calls `material.onBeforeCompile(parameters, renderer)` on the drawn material while it acquires the program.
      const shader = { uniforms: {} as Record<string, unknown> };
      (
        material.onBeforeCompile as unknown as (this: Material, shader: { uniforms: Record<string, unknown> }) => void
      ).call(material, shader);
      expect(shader.uniforms.uTint).toBe(extra.uTint);
    },
  );

  it.each(functionPaths)(
    "the %s material runs a node source's instance setupOutput that reads a user-added property through `this`",
    (path) => {
      const extra = { darken: 0.35 };
      const seen: unknown[] = [];
      const setupOutput = function (this: { extra: typeof extra }, _builder: unknown, output: unknown): unknown {
        seen.push(this.extra.darken);
        return output;
      };
      const { scene, sources } = tintedScene((i) =>
        Object.assign(new MeshStandardNodeMaterial({ color: tints[i]! }), { extra, setupOutput }),
      );
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      // NodeMaterial.setup calls `this.setupOutput(builder, outputNode)` on the drawn material while it builds the fragment stage.
      (material as unknown as { setupOutput(builder: unknown, output: unknown): unknown }).setupOutput(null, 'output');
      expect(seen).toEqual([0.35]);
    },
  );

  it.each(
    pathsByKind.flatMap(([path, kind]) =>
      (['circular', 'BigInt'] as const).map((label) => [label, path, kind] as const),
    ),
  )(
    'compiles a tinted group whose material userData cannot be serialised (%s) on the %s path of a %s source, and shares it',
    (label, path, kind) => {
      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;
      const userData = label === 'circular' ? circular : { big: BigInt(1) };
      const { scene, sources } = tintedScene((i) => {
        const material = kinds[kind](tints[i]!);
        material.userData = userData;
        return material;
      });
      const world = new World(scene, paths[path].options);
      expect(() => world.compile(), 'compile').not.toThrow();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      expect(material.userData, 'the clone shares it').toBe(userData);
      for (const source of sources) expect(source.userData, 'the source keeps it').toBe(userData);
    },
  );

  it.each(Object.keys(paths) as Array<keyof typeof paths>)(
    "the %s material keeps its own event listeners: disposing it at decompile runs none of the source's",
    (path) => {
      // WebGLRenderer (`onMaterialDispose`) and WebGPU's RenderObject register `dispose` listeners on every material they
      // draw, kept in EventDispatcher's lazily created own `_listeners`; WebGLRenderer's removes itself from the target.
      const targets: unknown[] = [];
      const onDispose = (event: { target: Material }): void => {
        targets.push(event.target);
        event.target.removeEventListener('dispose', onDispose);
      };
      const { scene, sources } = tintedScene((i) => {
        const material = new MeshStandardMaterial({ color: tints[i]! });
        material.addEventListener('dispose', onDispose);
        return material;
      });
      const world = new World(scene, paths[path].options);
      world.compile();
      const material = paths[path].material(world);
      expect(sources, 'a tinted group renders with a clone').not.toContain(material);
      const dispose = vi.spyOn(material, 'dispose');
      world.decompile();
      expect(dispose, 'decompile disposes the clone').toHaveBeenCalled();
      expect(targets, "no source listener ran for the clone's dispose").toEqual([]);
      for (const source of sources)
        expect(source.hasEventListener('dispose', onDispose), 'the source keeps its listener').toBe(true);
    },
  );
});
