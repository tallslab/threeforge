import { describe, expect, it } from 'vitest';
import { formatOverlay } from '../../src/overlay/index.js';
import { emptyFrame, emptySections, type FrameSnapshot } from '../../src/ledger/snapshot.js';

const frame: FrameSnapshot = {
  schemaVersion: 3,
  env: { three: '186', backend: 'webgl2', multiDraw: true, tier: 'desktop', gpu: 'test', dpr: 1, viewport: [800, 600] },
  ...emptySections(),
  totals: { submissions: 29, sceneSubmissions: 28, gpuDraws: 29, reportedDrawCalls: 29, unattributed: 0, programSwitches: 8, programs: 18, triangles: 1234, instances: 512, instancesDrawn: 400, drawCommands: 413 },
  passes: [{ id: 'main', submissions: 29, gpuDraws: 29 }],
  byReason: {
    batched: { submissions: 15, gpuDraws: 15, top: ['forge:batch:aa:0'] },
    dynamic: { submissions: 10, gpuDraws: 10, top: ['prop-1'] },
    'renderer-internal': { submissions: 1, gpuDraws: 1, top: ['Output Color Transform'] },
    skinned: { submissions: 2, gpuDraws: 2, top: ['skinned-0'] },
    'unique-material': { submissions: 1, gpuDraws: 1, top: ['ground'] },
  },
  programs: {},
};

describe('formatOverlay', () => {
  it('leads with backend, scene submissions against the budget and a pass mark', () => {
    const lines = formatOverlay(frame, 30);
    expect(lines[0]).toContain('webgl2');
    expect(lines[0]).toContain('28 / 30');
    expect(lines[0]).toContain('PASS');
    expect(formatOverlay(frame, 20)[0]).toContain('FAIL');
  });

  it('shows the cost line and reasons sorted by count, excluding renderer-internal work', () => {
    const lines = formatOverlay(frame, 30);
    expect(lines[1]).toContain('29 gpu draws');
    expect(lines[7]).toContain('unattributed 0');
    expect(lines[7]).toContain('switches 8');
    const reasons = lines.slice(8).map((l) => l.trim().split(/\s+/)[0]);
    expect(reasons).toEqual(['batched', 'dynamic', 'skinned', 'unique-material']);
    expect(lines.join('\n')).not.toContain('renderer-internal');
  });

  it('omits the budget when none is given', () => {
    const lines = formatOverlay(frame);
    expect(lines[0]).toContain('28 submissions');
    expect(lines[0]).not.toContain('/');
  });
});

describe('formatOverlay v3', () => {
  it('formats the six cost rows and hints from a v3 snapshot', () => {
    const f = emptyFrame({ three: '0.186.0', backend: 'webgpu', multiDraw: false, tier: 'phone-mid', gpu: 'Apple GPU', dpr: 2, viewport: [390, 844] });
    f.totals.sceneSubmissions = 27;
    f.totals.gpuDraws = 500;
    f.totals.triangles = 120_000;
    f.overdraw = { opaque: 1.31, transparent: 0.42, transparentSubmissions: 4, particles: 300, pixels: 480_000, measured: true };
    f.skinning = { submissions: 2, vertices: 6400, bones: 44, skeletons: 1, maxBones: 44, morphTargets: 0, vatInstances: 0, vatVertices: 0 };
    f.lighting = { lights: { directional: 1, point: 0, spot: 0, hemisphere: 1, ambient: 0, other: 0 }, shadowLights: 1, shadowPasses: 1, shadowCasters: 20, shadowTexels: 1_048_576, shadowSubmissions: 20 };
    f.js = { renderMs: 2.4, ledgerMs: 0.3, frameMs: 16.7, objects: 512, autoUpdatedMatrices: 12, hiddenOriginals: 0, skipped: 0 };
    f.memory = { textures: { count: 8, bytes: 20 * 1024 * 1024 }, geometries: { count: 30, bytes: 3 * 1024 * 1024 }, renderTargets: { count: 2, bytes: 5 * 1024 * 1024 }, unreferenced: { geometries: 0, textures: 0 }, chunks: { total: 0, resident: 0 }, estimated: true };
    f.hints = [{ category: 'lighting', severity: 'warn', code: 'shadow-texels', message: 'too many shadow texels', objects: [] }, { category: 'js', severity: 'info', code: 'static-auto-update', message: '3 static objects auto-update', objects: ['a'] }];
    const lines = formatOverlay(f, 30);
    expect(lines[0]).toBe('threeforge webgpu phone-mid  27 / 30 submissions  PASS');
    expect(lines).toContain('draw calls   27 submissions · 500 gpu draws · 120k tris');
    expect(lines).toContain('overdraw     1.31 opaque · 0.42 transparent fragments/px · 4 transparent · 300 particles');
    expect(lines).toContain('skinning     2 meshes · 6.4k verts · 44 bones · 1 skeletons · 0 vat instances');
    expect(lines).toContain('lighting     2 lights · 1 shadow · 20 casters · 1.0M texels');
    expect(lines).toContain('js           2.4 ms render · 0.3 ms ledger · 16.7 ms frame · 512 objects · 12 auto-matrices · 0 hidden · 0 skipped');
    expect(lines).toContain('memory       ~28 MB (tex 20 · geo 3 · rt 5)');
    expect(lines).toContain('! shadow-texels: too many shadow texels');
    expect(lines).toContain('· static-auto-update: 3 static objects auto-update');
    f.memory.chunks = { total: 64, resident: 12 };
    expect(formatOverlay(f, 30)).toContain('memory       ~28 MB (tex 20 · geo 3 · rt 5) · chunks 12/64');
  });

  it('marks overdraw as unmeasured until a measurement ran', () => {
    const f = emptyFrame({ three: '0.186.0', backend: 'webgl2', multiDraw: true, tier: 'desktop', gpu: 'x', dpr: 1, viewport: [800, 600] });
    expect(formatOverlay(f)).toContain('overdraw     not measured · 0 transparent · 0 particles');
  });
});
