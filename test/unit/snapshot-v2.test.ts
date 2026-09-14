import { describe, expect, it } from 'vitest';
import { buildFrame, emptyFrame } from '../../src/ledger/snapshot.js';

const env = { three: '0.186.0', backend: 'webgl2' as const, multiDraw: true, tier: 'desktop' as const, gpu: 'test', dpr: 1, viewport: [800, 600] as [number, number] };

describe('snapshot v2', () => {
  it('emptyFrame carries every v2 section with zeroed values', () => {
    const f = emptyFrame(env);
    expect(f.schemaVersion).toBe(2);
    expect(f.overdraw).toEqual({ opaque: 0, transparent: 0, transparentSubmissions: 0, particles: 0, pixels: 0, measured: false });
    expect(f.skinning).toEqual({ submissions: 0, vertices: 0, bones: 0, skeletons: 0, maxBones: 0, morphTargets: 0 });
    expect(f.lighting).toEqual({ lights: { directional: 0, point: 0, spot: 0, hemisphere: 0, ambient: 0, other: 0 }, shadowLights: 0, shadowPasses: 0, shadowCasters: 0, shadowTexels: 0, shadowSubmissions: 0 });
    expect(f.js).toEqual({ renderMs: 0, frameMs: 0, objects: 0, autoUpdatedMatrices: 0 });
    expect(f.memory).toEqual({ textures: { count: 0, bytes: 0 }, geometries: { count: 0, bytes: 0 }, renderTargets: { count: 0, bytes: 0 }, estimated: true });
    expect(f.hints).toEqual([]);
  });

  it('buildFrame keeps the v1 draw-call fields and marks schemaVersion 2', () => {
    const f = buildFrame({ env, items: [], reportedDrawCalls: 0, triangles: 0, programs: 0, descriptions: new Map() });
    expect(f.schemaVersion).toBe(2);
    expect(f.totals.sceneSubmissions).toBe(0);
    expect(f.hints).toEqual([]);
  });
});
