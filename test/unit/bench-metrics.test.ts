import { describe, expect, it } from 'vitest';
import { MEASURED, metricsOf, SCENE_IDS, WARM } from '../../test/app/benchMetrics.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';

describe('benchMetrics', () => {
  it('maps a snapshot to the pnpm bench metric keys', () => {
    const frame = emptyFrame({ three: '186', backend: 'webgl2', multiDraw: true, tier: 'desktop', gpu: 'x', dpr: 1, viewport: [800, 600] });
    frame.totals.sceneSubmissions = 12;
    frame.totals.gpuDraws = 30;
    frame.totals.triangles = 1000;
    frame.totals.programs = 3;
    frame.overdraw.opaque = 1.5;
    frame.overdraw.transparent = 0.25;
    frame.skinning.vertices = 400;
    frame.lighting.shadowCasters = 2;
    // The last frame's texels are not the metric: shadowTexels is the mean over the measured frames.
    frame.lighting.shadowTexels = 999;
    frame.memory.textures.bytes = 10;
    frame.memory.geometries.bytes = 20;
    frame.memory.renderTargets.bytes = 30;
    frame.overdraw.particles = 7;
    frame.overdraw.pixels = 480_000;
    frame.js.objects = 512;
    frame.js.autoUpdatedMatrices = 12;
    expect(metricsOf(frame, 2.5, 16.7, 0.5, [4096, 0, 4096])).toEqual({ sceneSubmissions: 12, gpuDraws: 30, triangles: 1000, programs: 3, overdrawOpaque: 1.5, overdrawTransparent: 0.25, skinnedVertices: 400, shadowCasters: 2, shadowTexels: 2731, textureBytes: 10, geometryBytes: 20, renderTargetBytes: 30, particles: 7, fillMegapixels: 0.84, objects: 512, autoUpdatedMatrices: 12, shadowPassesPerFrame: 0.5, renderMs: 2.5, frameMs: 16.7, unattributed: 0 });
    expect(metricsOf(frame, 2.5, 16.7, 0.5, []).shadowTexels).toBe(0);
    expect(SCENE_IDS).toEqual(['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg']);
    expect([WARM, MEASURED]).toEqual([10, 60]);
  });
});
