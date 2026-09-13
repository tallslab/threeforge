import { describe, expect, it } from 'vitest';
import { AmbientLight, DirectionalLight, PointLight, Scene, SpotLight } from 'three';
import { lightingOf, scanLights, skinningOf } from '../../src/ledger/sections.js';
import type { SubmissionRecord } from '../../src/ledger/snapshot.js';

const rec = (over: Partial<SubmissionRecord>): SubmissionRecord => ({
  name: 'x', kind: 'mesh', materialType: 'M', programHash: 'p', variantHash: 'v', transparent: false, pass: 'main', reason: 'untagged', flags: [],
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
    expect(skinningOf(items)).toEqual({ submissions: 3, vertices: 220, bones: 52, skeletons: 2, maxBones: 40, morphTargets: 3 });
  });
});

describe('lighting', () => {
  it('scans visible lights by type and shadow settings', () => {
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
    scene.add(sun, lamp, spot, hidden, new AmbientLight());
    const lights = scanLights(scene);
    expect(lights.map((l) => l.type)).toEqual(['DirectionalLight', 'PointLight', 'SpotLight', 'AmbientLight']);
    expect(lights.find((l) => l.type === 'PointLight')).toEqual({ type: 'PointLight', name: '', castShadow: true, mapSize: [512, 512], faces: 6 });
  });

  it('lightingOf counts shadow passes, unique casters and texels', () => {
    const lights = [
      { type: 'DirectionalLight', name: 'sun', castShadow: true, mapSize: [2048, 2048] as [number, number], faces: 1 },
      { type: 'PointLight', name: 'lamp', castShadow: true, mapSize: [512, 512] as [number, number], faces: 6 },
      { type: 'AmbientLight', name: '', castShadow: false, mapSize: [0, 0] as [number, number], faces: 1 },
    ];
    const items = [rec({ pass: 'shadow:sun', name: 'a' }), rec({ pass: 'shadow:sun', name: 'b' }), rec({ pass: 'shadow:lamp', name: 'a' }), rec({ pass: 'main', name: 'a' })];
    expect(lightingOf(lights, items)).toEqual({
      lights: { directional: 1, point: 1, spot: 0, hemisphere: 0, ambient: 1, other: 0 },
      shadowLights: 2,
      shadowPasses: 2,
      shadowCasters: 2,
      shadowTexels: 2048 * 2048 + 512 * 512 * 6,
      shadowSubmissions: 3,
    });
  });
});
