import { describe, expect, it } from 'vitest';
import { AmbientLight, DirectionalLight, Group, PointLight, Scene, SpotLight } from 'three';
import { lightingOf, NO_SHADOW_WORK, scanLights, skinningOf } from '../../src/ledger/sections.js';
import type { SubmissionRecord } from '../../src/ledger/snapshot.js';
import * as entry from '../../src/index.js';

const rec = (over: Partial<SubmissionRecord>): SubmissionRecord => ({
  name: 'x', kind: 'mesh', material: 0, materialType: 'M', programHash: 'p', variantHash: 'v', transparent: false, pass: 'main', reason: 'untagged', flags: [],
  expectedGpuDraws: 1, instances: 1, instancesDrawn: 1, vertices: 0, bones: 0, skeleton: null, morphTargets: 0, ...over,
});

describe('skinningOf', () => {
  it('sums skinned vertices and counts unique skeletons from main-pass items only', () => {
    const items = [
      rec({ kind: 'skinned', vertices: 100, bones: 40, skeleton: 0 }),
      rec({ kind: 'skinned', vertices: 50, bones: 40, skeleton: 0 }),
      rec({ kind: 'skinned', vertices: 70, bones: 12, skeleton: 1, morphTargets: 3 }),
      rec({ kind: 'skinned', vertices: 999, bones: 40, skeleton: 0, pass: 'shadow:sun' }),
      rec({ kind: 'mesh', vertices: 1000 }),
    ];
    expect(skinningOf(items)).toEqual({ submissions: 3, vertices: 220, bones: 52, skeletons: 2, maxBones: 40, morphTargets: 3, vatInstances: 0, vatVertices: 0 });
  });
});

describe('lighting', () => {
  it('scans world-visible lights by type and shadow settings', () => {
    const scene = new Scene();
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const lamp = new PointLight();
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(512, 512);
    const spot = new SpotLight();
    const hidden = new SpotLight();
    hidden.visible = false;
    // A visible light under a hidden group: three does not light with it.
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    hiddenGroup.add(new PointLight());
    scene.add(sun, lamp, spot, hidden, hiddenGroup, new AmbientLight());
    const lights = scanLights(scene);
    expect(lights.map((l) => l.type)).toEqual(['DirectionalLight', 'PointLight', 'SpotLight', 'AmbientLight']);
    expect(lights.find((l) => l.type === 'PointLight')).toEqual({ type: 'PointLight', name: '', castShadow: true, mapSize: [512, 512], faces: 6 });
  });

  const lights = [
    { type: 'DirectionalLight', name: 'sun', castShadow: true, mapSize: [2048, 2048] as [number, number], faces: 1 },
    { type: 'PointLight', name: 'lamp', castShadow: true, mapSize: [512, 512] as [number, number], faces: 6 },
    { type: 'PointLight', name: 'lamp', castShadow: true, mapSize: [512, 512] as [number, number], faces: 6 },
    { type: 'AmbientLight', name: '', castShadow: false, mapSize: [0, 0] as [number, number], faces: 1 },
  ];
  // Two lamps share a name (their passes are numbered); the first lamp's VSM blur quads are renderer-internal.
  const items = [
    rec({ pass: 'shadow:lamp#1', name: 'a' }),
    rec({ pass: 'shadow:lamp#1', name: 'b' }),
    rec({ pass: 'shadow:lamp#2', name: 'a' }),
    rec({ pass: 'shadow:lamp#1:vsm', name: '', reason: 'renderer-internal' }),
    rec({ pass: 'shadow:lamp#1:vsm', name: '', reason: 'renderer-internal' }),
    rec({ pass: 'main', name: 'a' }),
  ];

  it('lightingOf counts shadow-map passes and submissions from the items, and takes texels and casters from the shadow work the ledger saw', () => {
    expect(lightingOf(lights, items, { texels: 512 * 512 * 6, casters: 3 })).toEqual({
      lights: { directional: 1, point: 2, spot: 0, hemisphere: 0, ambient: 1, other: 0 },
      shadowLights: 3,
      shadowPasses: 2,
      shadowCasters: 3,
      shadowTexels: 512 * 512 * 6,
      shadowSubmissions: 3,
    });
  });

  it('lightingOf without shadow work reports no texels and no casters, whatever the lights are configured to', () => {
    expect(lightingOf(lights, items, NO_SHADOW_WORK)).toMatchObject({ shadowLights: 3, shadowPasses: 2, shadowCasters: 0, shadowTexels: 0, shadowSubmissions: 3 });
  });

  it('NO_SHADOW_WORK is exported from the package entry point beside lightingOf, whose doc tells callers to pass it', () => {
    expect(entry.NO_SHADOW_WORK).toBe(NO_SHADOW_WORK);
    expect(entry.lightingOf).toBe(lightingOf);
  });
});
