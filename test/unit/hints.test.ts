import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetsFor, detectTier } from '../../src/ledger/budgets.js';
import { hintsFor } from '../../src/ledger/hints.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';

const env = { three: '0.186.0', backend: 'webgl2' as const, multiDraw: true, tier: 'phone-low' as const, gpu: 'Adreno 610', dpr: 2, viewport: [390, 844] as [number, number] };

describe('tiers', () => {
  it('detects phone tiers from GPU strings and device hints', () => {
    expect(detectTier({ gpu: 'Apple M2' })).toBe('desktop');
    expect(detectTier({ gpu: 'Apple GPU', touch: true, deviceMemory: 4 })).toBe('phone-mid');
    expect(detectTier({ gpu: 'Adreno (TM) 610', touch: true })).toBe('phone-low');
    expect(detectTier({ gpu: 'Mali-G52', touch: true })).toBe('phone-low');
    expect(detectTier({ gpu: 'Adreno (TM) 740', touch: true, deviceMemory: 8 })).toBe('phone-mid');
    expect(detectTier({ touch: true, deviceMemory: 2 })).toBe('phone-low');
  });

  it('budgets have the spec values and accept overrides', () => {
    expect(BUDGETS['phone-low'].sceneSubmissions).toBe(80);
    expect(budgetsFor('desktop', { sceneSubmissions: 1000 }).sceneSubmissions).toBe(1000);
    expect(budgetsFor('desktop').triangles).toBe(5_000_000);
  });
});

describe('hintsFor', () => {
  it('reports every SP1 rule that trips on a phone-low frame', () => {
    const f = emptyFrame(env);
    f.totals.sceneSubmissions = 300;
    f.totals.programs = 41;
    f.totals.triangles = 600_000;
    f.byReason = {
      untagged: { submissions: 7, gpuDraws: 7, top: ['crate', 'barrel'] },
      'unique-material': { submissions: 25, gpuDraws: 25, top: ['a'] },
      'unsupported-material': { submissions: 1, gpuDraws: 1, top: ['shader'] },
    };
    f.overdraw = { opaque: 1.2, transparent: 2.5, transparentSubmissions: 30, particles: 0, pixels: 0, measured: true };
    f.skinning = { submissions: 200, vertices: 100_000, bones: 8000, skeletons: 200, maxBones: 60, morphTargets: 0, vatInstances: 0, vatVertices: 0 };
    f.lighting = { lights: { directional: 1, point: 1, spot: 0, hemisphere: 0, ambient: 0, other: 0 }, shadowLights: 2, shadowPasses: 7, shadowCasters: 10, shadowTexels: 6 * 1024 * 1024, shadowSubmissions: 70 };
    f.memory = { textures: { count: 10, bytes: 200 * 1024 * 1024 }, geometries: { count: 1, bytes: 60 * 1024 * 1024 }, renderTargets: { count: 0, bytes: 0 }, unreferenced: { geometries: 5, textures: 3 }, chunks: { total: 0, resident: 0 }, estimated: true };
    const hints = hintsFor(f, budgetsFor('phone-low'), { staticAutoUpdated: ['tree-1'], pointShadowLights: ['lamp'], transmissive: ['glass'] });
    expect(hints.map((h) => h.code).sort()).toEqual(
      ['over-budget-submissions', 'over-budget-triangles', 'point-light-shadow', 'programs', 'shadow-texels', 'skinned-vertices', 'bones-over-budget', 'skinned-crowd', 'static-auto-update', 'texture-bytes', 'geometry-bytes', 'unreferenced-resources', 'transmission', 'transparent-overdraw', 'unique-materials', 'unsupported-material', 'untagged'].sort(),
    );
    expect(hints.find((h) => h.code === 'untagged')).toEqual({ category: 'drawCalls', severity: 'warn', code: 'untagged', message: '7 untagged meshes: tag.static() or tag.dynamic() them', objects: ['crate', 'barrel'] });
  });

  it('is empty for a frame inside every budget', () => {
    expect(hintsFor(emptyFrame(env), budgetsFor('desktop'))).toEqual([]);
  });

  it('warns on particles over budget and mentions unbatched sprites', () => {
    const f = emptyFrame(env);
    f.overdraw.particles = 6000;
    const hints = hintsFor(f, budgetsFor('phone-low'));
    expect(hints.find((h) => h.code === 'particles-over-budget')).toMatchObject({ category: 'overdraw', severity: 'warn' });
    f.overdraw.particles = 0;
    f.byReason.sprite = { submissions: 8, gpuDraws: 8, top: ['rain-0'] };
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'sprites-unbatched')).toMatchObject({ category: 'overdraw', severity: 'info', objects: ['rain-0'] });
    f.byReason.sprite.submissions = 7;
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'sprites-unbatched')).toBe(false);
    expect(budgetsFor('phone-mid').particles).toBe(15_000);
  });

  it('warns on geometry over budget and on unreferenced GPU resources', () => {
    const f = emptyFrame(env);
    f.memory.geometries.bytes = 50 * 1024 * 1024;
    expect(hintsFor(f, budgetsFor('phone-low')).find((h) => h.code === 'geometry-bytes')).toMatchObject({ category: 'memory', severity: 'warn' });
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'geometry-bytes')).toBe(false);
    f.memory.geometries.bytes = 0;
    f.memory.unreferenced = { geometries: 4, textures: 4 };
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'unreferenced-resources')).toMatchObject({ category: 'memory', severity: 'warn' });
    f.memory.unreferenced = { geometries: 4, textures: 3 };
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'unreferenced-resources')).toBe(false);
    expect(budgetsFor('phone-mid').geometryBytes).toBe(96 * 1024 * 1024);
  });

  it('warns on objects over budget and points at detaching hidden originals', () => {
    const f = emptyFrame(env);
    f.js.objects = 3000;
    expect(hintsFor(f, budgetsFor('phone-low')).find((h) => h.code === 'js-objects')).toMatchObject({ category: 'js', severity: 'warn' });
    f.js.objects = 0;
    f.js.hiddenOriginals = 1000;
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'detach-originals')).toMatchObject({ category: 'js', severity: 'info' });
    f.js.hiddenOriginals = 999;
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'detach-originals')).toBe(false);
    expect(budgetsFor('phone-mid').objects).toBe(5_000);
  });

  it('warns on bones over budget and points crowds at animation textures', () => {
    const f = emptyFrame(env);
    f.skinning.bones = 6000;
    expect(hintsFor(f, budgetsFor('phone-mid')).find((h) => h.code === 'bones-over-budget')).toMatchObject({ category: 'skinning', severity: 'warn' });
    f.skinning.bones = 0;
    f.skinning.submissions = 50;
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'skinned-crowd')).toMatchObject({ category: 'skinning', severity: 'info' });
    f.skinning.submissions = 49;
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'skinned-crowd')).toBe(false);
    expect(budgetsFor('phone-low').bones).toBe(2_000);
  });
});
