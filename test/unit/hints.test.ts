import { describe, expect, it } from 'vitest';
import { BUDGETS, budgetsFor, detectTier, tierInputFromNavigator, type TierInput } from '../../src/ledger/budgets.js';
import { hintsFor } from '../../src/ledger/hints.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';
import type { Tier } from '../../src/ledger/snapshot.js';
// The package entry, not the module: `HintContext` (exported there) types `objects` and `items` as `MainPassObjects` and `HintItem[]`, so a consumer must be able to name both.
import type { HintItem, MainPassObjects } from '../../src/index.js';

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

  // GPU-first decision order (audit Task 36, fix round 1 / Ruling R56): the low-end regex, then the
  // mobile-GPU list, then the desktop-GPU list decide the tier regardless of touch; then a bare "Apple"
  // with touch; then step 5 (the `mobile` field, set by tierInputFromNavigator from userAgentData.mobile
  // or a UA sniff) when it is defined; only then does step 6, the old touch-only rule, apply. Steps 2, 4
  // and 5 apply the R57 low-memory downgrade: deviceMemory <= 2 returns phone-low instead of phone-mid.
  const table: Array<[string, TierInput, Tier]> = [
    // 1. low-end regex (sgx added)
    ['PowerVR SGX 544 + touch -> phone-low (sgx)', { gpu: 'PowerVR SGX 544', touch: true }, 'phone-low'],
    ['powervr sgx lowercase + touch -> phone-low (case-insensitive)', { gpu: 'powervr sgx 540', touch: true }, 'phone-low'],
    ['Adreno 610 + touch -> phone-low (unchanged)', { gpu: 'Adreno (TM) 610', touch: true }, 'phone-low'],
    ['Mali-G52 + touch -> phone-low (unchanged)', { gpu: 'Mali-G52', touch: true }, 'phone-low'],
    ['Mali-T880 + touch -> phone-low (old Midgard architecture, whole mali-t family)', { gpu: 'Mali-T880', touch: true }, 'phone-low'],
    // 2. mobile GPU list: decisive regardless of touch, downgraded to phone-low under 2GB (R57)
    ['Adreno 650 (above low-end range), no touch reported -> phone-mid', { gpu: 'Adreno (TM) 650' }, 'phone-mid'],
    ['Adreno 650 + <=2GB -> phone-low (R57 low-memory downgrade)', { gpu: 'Adreno (TM) 650', deviceMemory: 2 }, 'phone-low'],
    ['Mali-G78 (above low-end range) + touch -> phone-mid', { gpu: 'Mali-G78', touch: true }, 'phone-mid'],
    ['PowerVR Rogue (not SGX), no touch reported -> phone-mid', { gpu: 'PowerVR Rogue GE8320' }, 'phone-mid'],
    ['VideoCore + touch -> phone-low (still matches the low-end regex unconditionally, kept from before)', { gpu: 'VideoCore VI', touch: true }, 'phone-low'],
    ['Samsung Xclipse 920 + touch -> phone-mid', { gpu: 'Samsung Xclipse 920', touch: true }, 'phone-mid'],
    ['bare Qualcomm, no touch reported -> phone-mid', { gpu: 'Qualcomm Adreno' }, 'phone-mid'],
    ['Apple A15 GPU, no touch reported -> phone-mid', { gpu: 'Apple A15 GPU' }, 'phone-mid'],
    ['apple a15 lowercase + touch -> phone-mid (case-insensitive)', { gpu: 'apple a15 gpu', touch: true }, 'phone-mid'],
    // 3. desktop GPU list: decisive whatever touch/mobile say
    ['RTX 3060 + touch -> desktop (the audited bug: a touch laptop is not a phone)', { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', touch: true }, 'desktop'],
    ['RTX 3060 + touch + mobile:true -> desktop (step 3 wins over step 5)', { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', touch: true, mobile: true }, 'desktop'],
    ['Radeon + touch -> desktop', { gpu: 'AMD Radeon RX 6800', touch: true }, 'desktop'],
    ['Intel Iris Xe + touch -> desktop', { gpu: 'Intel(R) Iris(R) Xe Graphics', touch: true }, 'desktop'],
    ['Intel Arc + touch -> desktop', { gpu: 'Intel(R) Arc(TM) A770', touch: true }, 'desktop'],
    ['Apple M1 + touch -> desktop (Apple M-series, whatever touch says)', { gpu: 'Apple M1', touch: true }, 'desktop'],
    ['apple m2 lowercase, no touch -> desktop (case-insensitive)', { gpu: 'apple m2' }, 'desktop'],
    ['SwiftShader (software) + touch -> desktop', { gpu: 'Google SwiftShader', touch: true }, 'desktop'],
    // regex word boundaries: an unrelated word containing a GPU token as a substring must not match
    ['"Intelligent Renderer" does not match /intel/ (word boundary) + touch -> phone-mid', { gpu: 'Intelligent Renderer', touch: true }, 'phone-mid'],
    ['"Malibu GPU" does not match /mali/ (word boundary), no touch -> desktop', { gpu: 'Malibu GPU' }, 'desktop'],
    // 4. bare "Apple" (iPad Safari reports only this; a Mac on Safari with no GPU info also reports it) needs touch to mean phone-mid
    ['bare "Apple" + touch -> phone-mid (iPad Safari)', { gpu: 'Apple', touch: true }, 'phone-mid'],
    ['bare "Apple" + touch + <=2GB -> phone-low (R57 low-memory downgrade)', { gpu: 'Apple', touch: true, deviceMemory: 2 }, 'phone-low'],
    ['bare "Apple", no touch -> desktop (a Mac)', { gpu: 'Apple' }, 'desktop'],
    ['"Apple GPU", no touch -> desktop (an Intel or M-series Mac on Safari)', { gpu: 'Apple GPU' }, 'desktop'],
    // 5. the `mobile` field (set by tierInputFromNavigator) decides before step 6, for an unrecognised GPU
    ['unknown GPU, mobile:true -> phone-mid (step 5 decides)', { gpu: 'Unknown Renderer', mobile: true }, 'phone-mid'],
    ['unknown GPU, mobile:true, <=2GB -> phone-low (R57 low-memory downgrade)', { gpu: 'Unknown Renderer', mobile: true, deviceMemory: 2 }, 'phone-low'],
    ['unknown GPU, mobile:false + touch:true -> desktop (step 5 wins over step 6)', { gpu: 'Unknown Renderer', mobile: false, touch: true }, 'desktop'],
    // 6. unrecognised/empty GPU, mobile undefined: the old touch-only rule
    ['unknown GPU + touch, plenty of memory, mobile undefined -> phone-mid', { gpu: 'Unknown Renderer', touch: true, deviceMemory: 8 }, 'phone-mid'],
    ['unknown GPU + touch, <=2GB, mobile undefined -> phone-low', { gpu: 'Unknown Renderer', touch: true, deviceMemory: 2 }, 'phone-low'],
    ['unknown GPU, no touch, mobile undefined -> desktop', { gpu: 'Unknown Renderer' }, 'desktop'],
    ['no GPU at all, no touch -> desktop', {}, 'desktop'],
  ];

  it.each(table)('%s', (_name, input, expected) => {
    expect(detectTier(input)).toBe(expected);
  });

  describe('tierInputFromNavigator', () => {
    it('guards every optional navigator field: no userAgentData, no deviceMemory, no maxTouchPoints', () => {
      const input = tierInputFromNavigator('Apple M2', {});
      expect(input).toMatchObject({ gpu: 'Apple M2', touch: false, mobile: undefined, deviceMemory: undefined, cores: undefined });
    });

    it('the audited bug: a Windows laptop with an RTX 3060 and a touchscreen still returns desktop', () => {
      const nav = { maxTouchPoints: 10, hardwareConcurrency: 12, deviceMemory: 16, userAgentData: { mobile: false }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
      const input = tierInputFromNavigator('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', nav);
      expect(input.touch).toBe(true); // touch is the real touch capability: the touchscreen is real
      expect(input.mobile).toBe(false); // userAgentData.mobile says this is not a phone
      expect(detectTier(input)).toBe('desktop'); // the GPU-first order wins regardless (step 3)

      // Same laptop on a non-Chromium browser (no userAgentData at all): the desktop UA string has no
      // "Mobi", so step 5's sniff already gets this right without needing the GPU-first order at all.
      const firefoxNav = { maxTouchPoints: 10, hardwareConcurrency: 12, deviceMemory: 16, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0' };
      const firefoxInput = tierInputFromNavigator('NVIDIA GeForce RTX 3060/PCIe/SSE2', firefoxNav);
      expect(firefoxInput.touch).toBe(true);
      expect(firefoxInput.mobile).toBe(false); // the "Mobi" sniff on the UA string correctly says desktop
      expect(detectTier(firefoxInput)).toBe('desktop'); // and the GPU-first order would have won anyway
    });

    it('sets `mobile` from userAgentData.mobile over maxTouchPoints when the GPU is unrecognised (step 5)', () => {
      const desktopWithTouch = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 10, userAgentData: { mobile: false } });
      expect(desktopWithTouch.touch).toBe(true); // real touch capability, untouched by userAgentData
      expect(desktopWithTouch.mobile).toBe(false);
      expect(detectTier(desktopWithTouch)).toBe('desktop');

      const phoneNoTouchPoints = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 0, userAgentData: { mobile: true } });
      expect(phoneNoTouchPoints.touch).toBe(false);
      expect(phoneNoTouchPoints.mobile).toBe(true);
      expect(detectTier(phoneNoTouchPoints)).toBe('phone-mid');
    });

    it('falls back to a "Mobi" sniff of the user agent string for `mobile` when userAgentData is unavailable (non-Chromium, step 5)', () => {
      const mobileSafari = tierInputFromNavigator('Apple GPU', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobi/15E148' });
      expect(mobileSafari.mobile).toBe(true);

      const desktopSafari = tierInputFromNavigator('Apple GPU', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
      expect(desktopSafari.mobile).toBe(false);
    });

    it('leaves `mobile` undefined, and `touch` the old maxTouchPoints rule, when neither userAgentData nor the user agent string are available (step 6)', () => {
      const touchOnly = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 1 });
      expect(touchOnly.mobile).toBeUndefined();
      expect(touchOnly.touch).toBe(true);
      expect(detectTier(touchOnly)).toBe('phone-mid'); // step 6, mobile undefined

      const noTouch = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 0 });
      expect(noTouch.mobile).toBeUndefined();
      expect(noTouch.touch).toBe(false);
      expect(detectTier(noTouch)).toBe('desktop');
    });

    it('passes deviceMemory and hardwareConcurrency through as cores/deviceMemory', () => {
      const input = tierInputFromNavigator('Adreno 610', { deviceMemory: 3, hardwareConcurrency: 8, maxTouchPoints: 5 });
      expect(input.deviceMemory).toBe(3);
      expect(input.cores).toBe(8);
    });
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
    f.memory = { textures: { count: 10, bytes: 200 * 1024 * 1024 }, geometries: { count: 1, bytes: 60 * 1024 * 1024 }, renderTargets: { count: 0, bytes: 0 }, unreferenced: { geometries: 5, textures: 3 }, chunks: { total: 0, resident: 0 }, measured: null, estimated: true };
    const hints = hintsFor(f, budgetsFor('phone-low'), { staticAutoUpdated: ['tree-1'], pointShadowLights: ['lamp'], transmissive: ['glass'] });
    expect(hints.map((h) => h.code).sort()).toEqual(
      ['over-budget-submissions', 'over-budget-triangles', 'point-light-shadow', 'programs', 'shadow-texels', 'skinned-vertices', 'bones-over-budget', 'skinned-crowd', 'static-auto-update', 'texture-bytes', 'geometry-bytes', 'unreferenced-resources', 'transmission', 'transparent-overdraw', 'unique-materials', 'unsupported-material', 'untagged'].sort(),
    );
    expect(hints.find((h) => h.code === 'untagged')).toEqual({ category: 'drawCalls', severity: 'warn', code: 'untagged', message: '7 untagged meshes: tag.static() or tag.dynamic() them', objects: ['crate', 'barrel'] });
  });

  it('counts and thresholds the draw-call hints by the main-pass objects the ledger passes, not by submissions', () => {
    const f = emptyFrame(env);
    // One untagged caster under a point light, 21 unique statics casting under a sun: submissions count them per pass.
    f.byReason = {
      untagged: { submissions: 7, gpuDraws: 7, top: ['crate'] },
      'unique-material': { submissions: 42, gpuDraws: 42, top: ['statue-0'] },
      'static-unbatched': { submissions: 30, gpuDraws: 30, top: ['rock-1'] },
      sprite: { submissions: 8, gpuDraws: 8, top: ['spark'] },
    };
    const objects: MainPassObjects = { untagged: 1, 'unique-material': 21, 'static-unbatched': 15, sprite: 7 };
    const hints = hintsFor(f, budgetsFor('desktop'), { objects });
    expect(hints.find((h) => h.code === 'untagged')?.message).toBe('1 untagged meshes: tag.static() or tag.dynamic() them');
    expect(hints.find((h) => h.code === 'unique-materials')?.message).toBe('21 meshes each with a material used once: share materials through the registry');
    expect(hints.map((h) => h.code)).not.toContain('static-unbatched');
    expect(hints.map((h) => h.code)).not.toContain('sprites-unbatched');
    // A reason drawn only outside the main pass names no main-pass object: no hint.
    expect(hintsFor(f, budgetsFor('desktop'), { objects: { ...objects, untagged: 0 } }).map((h) => h.code)).not.toContain('untagged');
  });

  it('counts unsupported-material by the distinct objects the ledger passes, and by submissions without them', () => {
    const f = emptyFrame(env);
    // One ShaderMaterial mesh drawn in the main pass and in a reflection: two submissions, one mesh.
    f.byReason = { 'unsupported-material': { submissions: 2, gpuDraws: 2, top: ['fx-panel', 'fx-panel'] } };
    const message = (ctx: Parameters<typeof hintsFor>[2]) => hintsFor(f, budgetsFor('desktop'), ctx).find((h) => h.code === 'unsupported-material')?.message;
    expect(message({ unsupportedObjects: 1 })).toBe('1 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
    expect(message({})).toBe('2 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
  });

  it('reports static-unbatched above 20 statics that draw alone although their material is shared, apart from unique-materials', () => {
    const f = emptyFrame(env);
    f.byReason = {
      'static-unbatched': { submissions: 21, gpuDraws: 21, top: ['rock-1', 'rock-2'] },
      'unique-material': { submissions: 20, gpuDraws: 20, top: ['statue'] },
    };
    expect(hintsFor(f, budgetsFor('desktop'))).toEqual([
      { category: 'drawCalls', severity: 'info', code: 'static-unbatched', message: '21 static meshes draw one by one although other draws share their material: batch them with World (the draw that shares it may be one nothing can batch with: skinned, dynamic or already batched)', objects: ['rock-1', 'rock-2'] },
    ]);
    f.byReason['static-unbatched']!.submissions = 20;
    f.byReason['unique-material']!.submissions = 21;
    expect(hintsFor(f, budgetsFor('desktop')).map((h) => h.code)).toEqual(['unique-materials']);
  });

  it('uses singular wording for exactly one point light or transmissive mesh', () => {
    const f = emptyFrame(env);
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: ['lamp'], transmissive: ['glass'] });
    expect(hints.find((h) => h.code === 'point-light-shadow')).toEqual({ category: 'lighting', severity: 'warn', code: 'point-light-shadow', message: '1 point light renders 6 shadow faces per frame: use a spot light or freeze its map', objects: ['lamp'] });
    expect(hints.find((h) => h.code === 'transmission')).toEqual({ category: 'overdraw', severity: 'info', code: 'transmission', message: '1 mesh uses transmission: it renders in two passes and copies the frame buffer', objects: ['glass'] });
  });

  it('collapses multiple point lights or transmissive meshes into ONE hint per code, not one per object (both scale with the scene)', () => {
    const f = emptyFrame(env);
    const lights = ['lamp-1', 'lamp-2', 'lamp-3'];
    const meshes = ['glass-1', 'glass-2'];
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: lights, transmissive: meshes });
    const shadowHints = hints.filter((h) => h.code === 'point-light-shadow');
    expect(shadowHints).toHaveLength(1);
    expect(shadowHints[0]!.message).toBe('3 point lights render 6 shadow faces per frame: use spot lights or freeze their maps');
    expect(shadowHints[0]!.objects).toEqual(lights);
    const transmissionHints = hints.filter((h) => h.code === 'transmission');
    expect(transmissionHints).toHaveLength(1);
    expect(transmissionHints[0]!.message).toBe('2 meshes use transmission: they render in two passes and copy the frame buffer');
    expect(transmissionHints[0]!.objects).toEqual(meshes);
  });

  it('caps the collapsed hint\'s objects at 5 names even with many more lights, while the message states the true count', () => {
    const f = emptyFrame(env);
    const lights = Array.from({ length: 20 }, (_, i) => `lamp-${i}`);
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: lights });
    const shadowHints = hints.filter((h) => h.code === 'point-light-shadow');
    expect(shadowHints).toHaveLength(1);
    expect(shadowHints[0]!.message).toContain('20 point lights');
    expect(shadowHints[0]!.objects).toHaveLength(5);
    expect(shadowHints[0]!.objects).toEqual(lights.slice(0, 5));
  });

  it('emits no point-light-shadow/transmission hint when the context lists are empty', () => {
    const f = emptyFrame(env);
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: [], transmissive: [] });
    expect(hints.some((h) => h.code === 'point-light-shadow')).toBe(false);
    expect(hints.some((h) => h.code === 'transmission')).toBe(false);
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

  describe('transparent-batch-order', () => {
    it('fires when two threeforge transparent batches share the main pass (each is an "other" for the other)', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'forge:batch:bb22:0', pass: 'main', reason: 'batched' as const, transparent: true },
      ];
      const hints = hintsFor(f, budgetsFor('desktop'), { items });
      expect(hints.find((h) => h.code === 'transparent-batch-order')).toMatchObject({ category: 'overdraw', severity: 'info', objects: ['forge:batch:aa11:0', 'forge:batch:bb22:0'] });
    });

    it('fires when a threeforge transparent batch shares the main pass with an unbatched transparent mesh', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      const hints = hintsFor(f, budgetsFor('desktop'), { items });
      expect(hints.find((h) => h.code === 'transparent-batch-order')).toMatchObject({ category: 'overdraw', severity: 'info' });
    });

    it('does not fire when the transparent batch is the only transparent submission in the main pass', () => {
      const f = emptyFrame(env);
      const items: HintItem[] = [{ name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched', transparent: true }];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('does not fire when nothing else in the main pass is transparent', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'crate', pass: 'main', reason: 'unique-material' as const, transparent: false },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('ignores a transparent submission outside the main pass (e.g. a shadow pass)', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'shadow-thing', pass: 'shadow:Sun', reason: 'batched' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('does not fire without a threeforge transparent batch, even with several transparent meshes', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
        { name: 'glass-b', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('does not fire for an opaque threeforge batch even alongside other transparent submissions', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: false },
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('does not fire without items in the context', () => {
      const f = emptyFrame(env);
      expect(hintsFor(f, budgetsFor('desktop'), {}).some((h) => h.code === 'transparent-batch-order')).toBe(false);
      expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('caps the objects list at 5 names even with more threeforge transparent batches sharing the main pass', () => {
      const f = emptyFrame(env);
      const items = Array.from({ length: 8 }, (_, i) => ({ name: `forge:batch:aa${i}:0`, pass: 'main', reason: 'batched' as const, transparent: true }));
      const hint = hintsFor(f, budgetsFor('desktop'), { items }).find((h) => h.code === 'transparent-batch-order');
      expect(hint?.objects).toHaveLength(5);
      expect(hint?.objects).toEqual(items.slice(0, 5).map((i) => i.name));
    });
  });

  // The ledger gathers `localSpaceDraws` on its rescan (draw-call-ledger.test.ts covers which draws it names); these
  // pin the wording, the counts and the caps.
  describe('batch-local-space', () => {
    const tail = "a node in a material slot, alphaHash or an object-space normal map, which read mesh-local space, now the scene's: shading can change — tag those meshes dynamic to keep them individual";

    it('names one compiled draw and its material in the singular', () => {
      const hints = hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws: [{ object: 'forge:batch:aa11:0', material: 'gradient' }] });
      expect(hints.find((h) => h.code === 'batch-local-space')).toEqual({
        category: 'drawCalls',
        severity: 'info',
        code: 'batch-local-space',
        message: `1 threeforge batched, instanced or baked draw uses ${tail} (materials: gradient)`,
        objects: ['forge:batch:aa11:0'],
      });
    });

    it('counts every draw, lists each material once and at most three, and caps objects at 5 names', () => {
      const materials = ['grass', 'grass', 'leaves', 'glass', 'water', 'water', 'fog'];
      const localSpaceDraws = materials.map((material, i) => ({ object: `forge:batch:aa${i}:0`, material }));
      const hint = hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws }).find((h) => h.code === 'batch-local-space');
      expect(hint?.message).toBe(`7 threeforge batched, instanced or baked draws use ${tail} (materials: grass, leaves, glass +2 more)`);
      expect(hint?.objects).toEqual(localSpaceDraws.slice(0, 5).map((d) => d.object));
    });

    it('keeps a long material name within the message cap', () => {
      const hint = hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws: [{ object: 'O'.repeat(500), material: 'M'.repeat(10_000) }] }).find((h) => h.code === 'batch-local-space');
      expect(hint?.message.length).toBeLessThanOrEqual(300);
      expect(hint?.message.startsWith(`1 threeforge batched, instanced or baked draw uses ${tail} (materials: MMM`)).toBe(true);
      expect(hint?.objects[0]!.length).toBeLessThanOrEqual(120);
    });

    it('does not fire without such draws', () => {
      expect(hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws: [] }).some((h) => h.code === 'batch-local-space')).toBe(false);
      expect(hintsFor(emptyFrame(env), budgetsFor('desktop')).some((h) => h.code === 'batch-local-space')).toBe(false);
    });
  });
});
