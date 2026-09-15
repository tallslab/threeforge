import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, type Material } from 'three';
import * as WEBGPU from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { World } from '../../src/compiler/World.js';
import { hasOwnFunctions, isBuiltInMaterial } from '../../src/compiler/batchStatics.js';
import { tag } from '../../src/tags.js';

/** three r186's material classes, from `src/materials/Materials.js` and `src/materials/nodes/NodeMaterials.js`. */
const CLASSIC = ['LineBasicMaterial', 'LineDashedMaterial', 'Material', 'MeshBasicMaterial', 'MeshDepthMaterial', 'MeshDistanceMaterial', 'MeshLambertMaterial', 'MeshMatcapMaterial', 'MeshNormalMaterial', 'MeshPhongMaterial', 'MeshPhysicalMaterial', 'MeshStandardMaterial', 'MeshToonMaterial', 'PointsMaterial', 'RawShaderMaterial', 'ShaderMaterial', 'ShadowMaterial', 'SpriteMaterial'] as const;
const NODE = ['Line2NodeMaterial', 'LineBasicNodeMaterial', 'LineDashedNodeMaterial', 'MeshBasicNodeMaterial', 'MeshLambertNodeMaterial', 'MeshMatcapNodeMaterial', 'MeshNormalNodeMaterial', 'MeshPhongNodeMaterial', 'MeshPhysicalNodeMaterial', 'MeshSSSNodeMaterial', 'MeshStandardNodeMaterial', 'MeshToonNodeMaterial', 'NodeMaterial', 'PointsNodeMaterial', 'ShadowNodeMaterial', 'SpriteNodeMaterial', 'VolumeNodeMaterial'] as const;
const construct = (namespace: Record<string, unknown>, name: string): Material => new (namespace[name] as new () => Material)();

describe('built-in material checks', () => {
  it.each([...CLASSIC.map((name) => ['three', name] as const), ...NODE.map((name) => ['three/webgpu', name] as const)])('isBuiltInMaterial accepts %s %s, and rejects a subclass of it', (from, name) => {
    const namespace = (from === 'three' ? THREE : WEBGPU) as unknown as Record<string, unknown>;
    expect(isBuiltInMaterial(construct(namespace, name))).toBe(true);
    const Sub = class extends (namespace[name] as new () => Material) {};
    expect(isBuiltInMaterial(new Sub())).toBe(false);
  });

  it('the list covers every material class three and three/webgpu export', () => {
    const exported = new Set<string>();
    for (const namespace of [THREE, WEBGPU] as unknown as Array<Record<string, unknown>>) {
      for (const [name, value] of Object.entries(namespace)) {
        if (typeof value === 'function' && name.endsWith('Material') && (() => { try { return (new (value as new () => { isMaterial?: boolean })()).isMaterial === true; } catch { return false; } })()) exported.add(name);
      }
    }
    expect([...exported].sort()).toEqual([...CLASSIC, ...NODE].sort());
  });

  it('hasOwnFunctions is false for every fresh built-in material and true once code is assigned to an instance', () => {
    for (const name of CLASSIC) expect(hasOwnFunctions(construct(THREE as unknown as Record<string, unknown>, name)), name).toBe(false);
    for (const name of NODE) expect(hasOwnFunctions(construct(WEBGPU as unknown as Record<string, unknown>, name)), name).toBe(false);
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
    instanced: { options: { instanceThreshold: 2 }, material: (world: World) => world.instancedMeshes[0]!.material as Material },
    baked: { options: { bake: true }, material: (world: World) => world.bakedMeshes[0]!.material as Material },
  } as const;

  it.each(Object.keys(paths) as Array<keyof typeof paths>)("the %s material keeps a classic source's onBeforeCompile, customProgramCacheKey, defines and alphaTest", (path) => {
    const onBeforeCompile = (): void => {};
    const customProgramCacheKey = (): string => 'custom-program';
    const { scene, sources } = tintedScene((i) => Object.assign(new MeshStandardMaterial({ color: tints[i]!, alphaTest: 0.5 }), { onBeforeCompile, customProgramCacheKey, defines: { STANDARD: '', MY_DEFINE: '' } }));
    const world = new World(scene, paths[path].options);
    world.compile();
    const material = paths[path].material(world);
    expect(sources, 'a tinted group renders with a clone').not.toContain(material);
    expect(material.onBeforeCompile, 'onBeforeCompile').toBe(onBeforeCompile);
    expect(material.customProgramCacheKey, 'customProgramCacheKey').toBe(customProgramCacheKey);
    expect((material as MeshStandardMaterial).defines, 'defines').toEqual({ STANDARD: '', MY_DEFINE: '' });
    expect((material as MeshStandardMaterial).defines, 'defines is a copy').not.toBe((sources[0] as MeshStandardMaterial).defines);
    expect(material.alphaTest, 'alphaTest').toBe(0.5);
  });

  it.each(Object.keys(paths) as Array<keyof typeof paths>)('the %s material keeps a node source\'s instance setupOutput and alphaTest', (path) => {
    const setupOutput = function (this: MeshStandardNodeMaterial, ...args: Parameters<MeshStandardNodeMaterial['setupOutput']>) {
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
});
