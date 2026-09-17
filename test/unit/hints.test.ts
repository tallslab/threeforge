import {
  BoxGeometry,
  type BufferGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  type Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type NormalMapTypes,
  ObjectSpaceNormalMap,
  PlaneGeometry,
  PointLight,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TangentSpaceNormalMap,
  type Texture,
} from 'three';
import { color, mix, positionLocal } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { hasNodeSlot } from '../../src/compiler/materialCode.js';
import { World, type WorldOptions } from '../../src/compiler/World.js';
// The package entry, not the module: `HintContext` (exported there) types `objects` and `items` as `MainPassObjects` and `HintItem[]`, so a consumer must be able to name both.
import type { HintItem, MainPassObjects } from '../../src/index.js';
import { BUDGETS, budgetsFor, detectTier, type TierInput, tierInputFromNavigator } from '../../src/ledger/budgets.js';
import type { DrawCallLedger } from '../../src/ledger/DrawCallLedger.js';
import { hintsFor } from '../../src/ledger/hints.js';
import type { SubmissionRecord, Tier } from '../../src/ledger/snapshot.js';
import { emptyFrame } from '../../src/ledger/snapshot.js';
import type { MaterialRegistry } from '../../src/registry/MaterialRegistry.js';
import { tag } from '../../src/tags.js';
import { batchedOf, type FakeRenderer } from './helpers/fakeRenderer.js';
import { attachedLedger } from './helpers/ledger.js';
import { box, casting, reasonsIn } from './helpers/ledgerFixtures.js';

const env = {
  three: '0.186.0',
  backend: 'webgl2' as const,
  multiDraw: true,
  tier: 'phone-low' as const,
  gpu: 'Adreno 610',
  dpr: 2,
  viewport: [390, 844] as [number, number],
};

describe('tiers', () => {
  it('detects phone tiers from GPU strings and device hints', () => {
    expect(detectTier({ gpu: 'Apple M2' })).toBe('desktop');
    expect(detectTier({ gpu: 'Apple GPU', touch: true, deviceMemory: 4 })).toBe('phone-mid');
    expect(detectTier({ gpu: 'Adreno (TM) 610', touch: true })).toBe('phone-low');
    expect(detectTier({ gpu: 'Mali-G52', touch: true })).toBe('phone-low');
    expect(detectTier({ gpu: 'Adreno (TM) 740', touch: true, deviceMemory: 8 })).toBe('phone-mid');
    expect(detectTier({ touch: true, deviceMemory: 2 })).toBe('phone-low');
  });

  // GPU-first decision order: the low-end
  // regex, then "Apple" with touch, then the desktop-GPU list, then a Direct3D/Windows driver string, then
  // the mobile-GPU list, then step 6 (the `mobile` field, set by tierInputFromNavigator from
  // userAgentData.mobile or a UA sniff) when it is defined, and only then step 7, the old touch-only rule.
  // The mobile-GPU list is last of the GPU tests because those families also ship in Windows-on-ARM laptops,
  // but it still outranks `mobile === false`, because Chrome reports an Android tablet as not mobile: the
  // graphics API in the renderer string (steps 3-4) is what tells that laptop from that tablet.
  // Steps 2, 5, 6 and 7 apply the low-memory downgrade: deviceMemory <= 2 returns phone-low.
  const table: Array<[string, TierInput, Tier]> = [
    // 1. low-end regex (sgx added)
    ['PowerVR SGX 544 + touch -> phone-low (sgx)', { gpu: 'PowerVR SGX 544', touch: true }, 'phone-low'],
    [
      'powervr sgx lowercase + touch -> phone-low (case-insensitive)',
      { gpu: 'powervr sgx 540', touch: true },
      'phone-low',
    ],
    ['Adreno 610 + touch -> phone-low (unchanged)', { gpu: 'Adreno (TM) 610', touch: true }, 'phone-low'],
    ['Mali-G52 + touch -> phone-low (unchanged)', { gpu: 'Mali-G52', touch: true }, 'phone-low'],
    [
      'Mali-T880 + touch -> phone-low (old Midgard architecture, whole mali-t family)',
      { gpu: 'Mali-T880', touch: true },
      'phone-low',
    ],
    // 5. mobile GPU list: decides unless a desktop GPU or a desktop graphics API was named, downgraded to phone-low under 2GB
    ['Adreno 650 (above low-end range), no touch reported -> phone-mid', { gpu: 'Adreno (TM) 650' }, 'phone-mid'],
    [
      'Adreno 650 + <=2GB -> phone-low (low-memory downgrade)',
      { gpu: 'Adreno (TM) 650', deviceMemory: 2 },
      'phone-low',
    ],
    ['Mali-G78 (above low-end range) + touch -> phone-mid', { gpu: 'Mali-G78', touch: true }, 'phone-mid'],
    ['PowerVR Rogue (not SGX), no touch reported -> phone-mid', { gpu: 'PowerVR Rogue GE8320' }, 'phone-mid'],
    [
      'VideoCore + touch -> phone-low (still matches the low-end regex unconditionally, kept from before)',
      { gpu: 'VideoCore VI', touch: true },
      'phone-low',
    ],
    ['Samsung Xclipse 920 + touch -> phone-mid', { gpu: 'Samsung Xclipse 920', touch: true }, 'phone-mid'],
    ['bare Qualcomm, no touch reported -> phone-mid', { gpu: 'Qualcomm Adreno' }, 'phone-mid'],
    ['Apple A15 GPU, no touch reported -> phone-mid', { gpu: 'Apple A15 GPU' }, 'phone-mid'],
    ['apple a15 lowercase + touch -> phone-mid (case-insensitive)', { gpu: 'apple a15 gpu', touch: true }, 'phone-mid'],
    // 3. desktop GPU list: decisive whatever touch/mobile say (but an Apple name with touch decides first)
    [
      'RTX 3060 + touch -> desktop (the original bug: a touch laptop is not a phone)',
      { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', touch: true },
      'desktop',
    ],
    [
      'RTX 3060 + touch + mobile:true -> desktop (step 3 wins over step 6)',
      { gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', touch: true, mobile: true },
      'desktop',
    ],
    ['Radeon + touch -> desktop', { gpu: 'AMD Radeon RX 6800', touch: true }, 'desktop'],
    ['Intel Iris Xe + touch -> desktop', { gpu: 'Intel(R) Iris(R) Xe Graphics', touch: true }, 'desktop'],
    ['Intel Arc + touch -> desktop', { gpu: 'Intel(R) Arc(TM) A770', touch: true }, 'desktop'],
    ['Apple M1, no touch -> desktop (a MacBook)', { gpu: 'Apple M1' }, 'desktop'],
    ['apple m2 lowercase, no touch -> desktop (case-insensitive)', { gpu: 'apple m2' }, 'desktop'],
    ['SwiftShader (software) + touch -> desktop', { gpu: 'Google SwiftShader', touch: true }, 'desktop'],
    // regex word boundaries: an unrelated word containing a GPU token as a substring must not match
    [
      '"Intelligent Renderer" does not match /intel/ (word boundary) + touch -> phone-mid',
      { gpu: 'Intelligent Renderer', touch: true },
      'phone-mid',
    ],
    ['"Malibu GPU" does not match /mali/ (word boundary), no touch -> desktop', { gpu: 'Malibu GPU' }, 'desktop'],
    // 2. an "Apple" name (iPad Safari reports a bare "Apple"; a Mac on Safari with no GPU info also reports it) needs touch to mean phone-mid
    ['bare "Apple" + touch -> phone-mid (iPad Safari)', { gpu: 'Apple', touch: true }, 'phone-mid'],
    [
      'bare "Apple" + touch + <=2GB -> phone-low (low-memory downgrade)',
      { gpu: 'Apple', touch: true, deviceMemory: 2 },
      'phone-low',
    ],
    ['bare "Apple", no touch -> desktop (a Mac)', { gpu: 'Apple' }, 'desktop'],
    ['"Apple GPU", no touch -> desktop (an Intel or M-series Mac on Safari)', { gpu: 'Apple GPU' }, 'desktop'],
    // 6. the `mobile` field (set by tierInputFromNavigator) decides before step 7, for an unrecognised GPU
    ['unknown GPU, mobile:true -> phone-mid (step 6 decides)', { gpu: 'Unknown Renderer', mobile: true }, 'phone-mid'],
    [
      'unknown GPU, mobile:true, <=2GB -> phone-low (low-memory downgrade)',
      { gpu: 'Unknown Renderer', mobile: true, deviceMemory: 2 },
      'phone-low',
    ],
    [
      'unknown GPU, mobile:false + touch:true -> desktop (step 6 wins over step 7)',
      { gpu: 'Unknown Renderer', mobile: false, touch: true },
      'desktop',
    ],
    // 7. unrecognised/empty GPU, mobile undefined: the old touch-only rule
    [
      'unknown GPU + touch, plenty of memory, mobile undefined -> phone-mid',
      { gpu: 'Unknown Renderer', touch: true, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'unknown GPU + touch, <=2GB, mobile undefined -> phone-low',
      { gpu: 'Unknown Renderer', touch: true, deviceMemory: 2 },
      'phone-low',
    ],
    ['unknown GPU, no touch, mobile undefined -> desktop', { gpu: 'Unknown Renderer' }, 'desktop'],
    ['no GPU at all, no touch -> desktop', {}, 'desktop'],
    // A mobile GPU-family *name* is weaker evidence than the browser's own
    // "this is not a mobile device", than a recognised desktop GPU, and than a Direct3D/Windows driver
    // string. Windows-on-ARM laptops (Snapdragon X) carry Adreno GPUs and report both brands through ANGLE.
    [
      'Snapdragon X laptop (Adreno + Qualcomm) + touch + mobile:false -> desktop (the D3D11 in the string beats the mobile GPU name)',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)', touch: true, mobile: false, deviceMemory: 16 },
      'desktop',
    ],
    [
      'Snapdragon X laptop, no mobile signal at all -> desktop (a D3D11 driver string is never mobile)',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)', touch: true },
      'desktop',
    ],
    [
      'Snapdragon 8cx laptop (Adreno 690, Direct3D11 spelled out) -> desktop',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) 690 Direct3D11 vs_5_0 ps_5_0, D3D11)', touch: true },
      'desktop',
    ],
    [
      'Android phone (Adreno 740, OpenGL ES) + touch + mobile:true -> phone-mid (a real phone is unaffected)',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', touch: true, mobile: true, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'Android phone (bare Adreno 740) + touch, mobile undefined -> phone-mid (step 6 still reads the GPU name)',
      { gpu: 'Adreno (TM) 740', touch: true },
      'phone-mid',
    ],
    [
      'Adreno 610 + mobile:false -> phone-low (the low-end regex still decides first)',
      { gpu: 'Adreno (TM) 610', touch: true, mobile: false },
      'phone-low',
    ],
    [
      'M2 iPad Pro + touch -> phone-mid (an M-series with a touchscreen is an iPad, not a Mac)',
      { gpu: 'Apple M2', touch: true },
      'phone-mid',
    ],
    [
      'M2 iPad Pro + touch + mobile:false (iPadOS Safari sends a desktop UA) -> phone-mid',
      { gpu: 'Apple M2', touch: true, mobile: false },
      'phone-mid',
    ],
    [
      'M2 iPad Pro + touch + <=2GB -> phone-low (low-memory downgrade still applies)',
      { gpu: 'Apple M2', touch: true, deviceMemory: 2 },
      'phone-low',
    ],
    // The graphics API in the renderer string is what separates a Windows-on-ARM laptop from an Android tablet: both
    // carry a mobile GPU family and both report `userAgentData.mobile: false` (Chrome calls a tablet not-mobile), but
    // only the laptop's string names Direct3D. Without a desktop API named, the GPU family name decides.
    [
      'Chrome Android tablet (Mali, OpenGL ES) + touch + mobile:false -> phone-mid (a tablet is not a desktop)',
      { gpu: 'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)', touch: true, mobile: false, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'Chrome Android tablet (Adreno, Vulkan) + touch + mobile:false -> phone-mid',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) 740, Vulkan 1.3.0)', touch: true, mobile: false, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'bare Mali-G710 + mobile:false, no API named -> phone-mid (the GPU family decides when nothing contradicts it)',
      { gpu: 'Mali-G710', touch: true, mobile: false },
      'phone-mid',
    ],
    [
      'Snapdragon X (Adreno, Direct3D11) + mobile:false, no touch -> desktop (a desktop API is named)',
      { gpu: 'ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)', mobile: false, deviceMemory: 16 },
      'desktop',
    ],
    // Under WebGPU there is no renderer string: `gpu` is built from `adapter.info` (description, else device, else
    // vendor + architecture), which names a vendor and an architecture and never a graphics API — this repository's
    // own WebGPU value is `apple metal-3`. So the Direct3D token that rescues the laptop on WebGL2 is absent, and the
    // platform is what separates a Windows-on-ARM laptop from an Android tablet.
    [
      'Snapdragon X under WebGPU (qualcomm adreno-x1, platform Windows) + touch + mobile:false -> desktop',
      { gpu: 'qualcomm adreno-x1', platform: 'Windows', touch: true, mobile: false, deviceMemory: 16 },
      'desktop',
    ],
    [
      'Snapdragon X under WebGPU, no touch -> desktop',
      { gpu: 'qualcomm adreno-x1', platform: 'Windows', mobile: false, deviceMemory: 16 },
      'desktop',
    ],
    [
      'Snapdragon 8cx under WebGPU (platform Win32, as navigator.platform spells it) -> desktop',
      { gpu: 'qualcomm adreno-690', platform: 'Win32', touch: true, mobile: false },
      'desktop',
    ],
    [
      'a Linux workstation with a Mali dev board GPU (platform Linux) -> desktop',
      { gpu: 'arm mali-g710', platform: 'Linux x86_64', mobile: false },
      'desktop',
    ],
    [
      'a Chromebook (platform Chrome OS) with a Mali GPU -> desktop',
      { gpu: 'arm mali-g710', platform: 'Chrome OS', touch: true, mobile: false },
      'desktop',
    ],
    [
      'Android tablet under WebGPU (arm mali-g710, platform Android) + touch + mobile:false -> phone-mid',
      { gpu: 'arm mali-g710', platform: 'Android', touch: true, mobile: false, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'Android phone under WebGPU (qualcomm adreno-740, platform Android) + mobile:true -> phone-mid',
      { gpu: 'qualcomm adreno-740', platform: 'Android', touch: true, mobile: true, deviceMemory: 8 },
      'phone-mid',
    ],
    [
      'an iPad reporting a mobile GPU name with platform iOS -> phone-mid',
      { gpu: 'apple a17', platform: 'iOS', touch: true },
      'phone-mid',
    ],
    [
      'a mobile GPU with no platform at all -> phone-mid (the documented fallback, unchanged)',
      { gpu: 'qualcomm adreno-x1', mobile: false },
      'phone-mid',
    ],
    [
      'apple metal-3 (this repo under WebGPU) + platform macOS -> desktop',
      { gpu: 'apple metal-3', platform: 'macOS', mobile: false },
      'desktop',
    ],
  ];

  it.each(table)('%s', (_name, input, expected) => {
    expect(detectTier(input)).toBe(expected);
  });

  describe('tierInputFromNavigator', () => {
    it('guards every optional navigator field: no userAgentData, no deviceMemory, no maxTouchPoints', () => {
      const input = tierInputFromNavigator('Apple M2', {});
      expect(input).toMatchObject({
        gpu: 'Apple M2',
        touch: false,
        mobile: undefined,
        deviceMemory: undefined,
        cores: undefined,
      });
    });

    it('the original bug: a Windows laptop with an RTX 3060 and a touchscreen still returns desktop', () => {
      const nav = {
        maxTouchPoints: 10,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        userAgentData: { mobile: false },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      };
      const input = tierInputFromNavigator(
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        nav,
      );
      expect(input.touch).toBe(true); // touch is the real touch capability: the touchscreen is real
      expect(input.mobile).toBe(false); // userAgentData.mobile says this is not a phone
      expect(detectTier(input)).toBe('desktop'); // the GPU-first order wins regardless (step 3)

      // Same laptop on a non-Chromium browser (no userAgentData at all): the desktop UA string has no
      // "Mobi", so step 5's sniff already gets this right without needing the GPU-first order at all.
      const firefoxNav = {
        maxTouchPoints: 10,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
      };
      const firefoxInput = tierInputFromNavigator('NVIDIA GeForce RTX 3060/PCIe/SSE2', firefoxNav);
      expect(firefoxInput.touch).toBe(true);
      expect(firefoxInput.mobile).toBe(false); // the "Mobi" sniff on the UA string correctly says desktop
      expect(detectTier(firefoxInput)).toBe('desktop'); // and the GPU-first order would have won anyway
    });

    it('sets `mobile` from userAgentData.mobile over maxTouchPoints when the GPU is unrecognised (step 6)', () => {
      const desktopWithTouch = tierInputFromNavigator('Unknown Renderer', {
        maxTouchPoints: 10,
        userAgentData: { mobile: false },
      });
      expect(desktopWithTouch.touch).toBe(true); // real touch capability, untouched by userAgentData
      expect(desktopWithTouch.mobile).toBe(false);
      expect(detectTier(desktopWithTouch)).toBe('desktop');

      const phoneNoTouchPoints = tierInputFromNavigator('Unknown Renderer', {
        maxTouchPoints: 0,
        userAgentData: { mobile: true },
      });
      expect(phoneNoTouchPoints.touch).toBe(false);
      expect(phoneNoTouchPoints.mobile).toBe(true);
      expect(detectTier(phoneNoTouchPoints)).toBe('phone-mid');
    });

    it('falls back to a "Mobi" sniff of the user agent string for `mobile` when userAgentData is unavailable (non-Chromium, step 6)', () => {
      const mobileSafari = tierInputFromNavigator('Apple GPU', {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobi/15E148',
      });
      expect(mobileSafari.mobile).toBe(true);

      const desktopSafari = tierInputFromNavigator('Apple GPU', {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      });
      expect(desktopSafari.mobile).toBe(false);
    });

    it('leaves `mobile` undefined, and `touch` the old maxTouchPoints rule, when neither userAgentData nor the user agent string are available (step 7)', () => {
      const touchOnly = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 1 });
      expect(touchOnly.mobile).toBeUndefined();
      expect(touchOnly.touch).toBe(true);
      expect(detectTier(touchOnly)).toBe('phone-mid'); // step 7, mobile undefined

      const noTouch = tierInputFromNavigator('Unknown Renderer', { maxTouchPoints: 0 });
      expect(noTouch.mobile).toBeUndefined();
      expect(noTouch.touch).toBe(false);
      expect(detectTier(noTouch)).toBe('desktop');
    });

    it('a Windows-on-ARM laptop (Snapdragon X, Adreno through ANGLE) is a desktop, an iPad is not', () => {
      // Copilot+ PC: Chromium reports userAgentData.mobile === false, the renderer string names both
      // Qualcomm and Adreno, and the machine usually has a touchscreen. Before the reorder this returned
      // phone-mid, which raises over-budget-submissions (severity 'error') and fails `threeforge inspect`.
      const snapdragon = tierInputFromNavigator('ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)', {
        maxTouchPoints: 10,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        userAgentData: { mobile: false },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(snapdragon.mobile).toBe(false);
      expect(detectTier(snapdragon)).toBe('desktop');

      // iPadOS Safari sends a Macintosh user agent, so the "Mobi" sniff resolves mobile:false; touch plus
      // an Apple GPU name still means a tablet, not a desktop.
      const ipad = tierInputFromNavigator('Apple M2', {
        maxTouchPoints: 5,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      });
      expect(ipad.mobile).toBe(false);
      expect(detectTier(ipad)).toBe('phone-mid');
    });

    it('resolves `platform` from userAgentData, then the user agent, then navigator.platform', () => {
      // Chromium states it outright.
      expect(
        tierInputFromNavigator('qualcomm adreno-x1', {
          userAgentData: { mobile: false, platform: 'Windows' },
          platform: 'Win32',
        }).platform,
      ).toBe('Windows');
      // No userAgentData (Safari, Firefox): the user agent names the OS.
      expect(
        tierInputFromNavigator('apple metal-3', {
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          platform: 'MacIntel',
        }).platform,
      ).toBe('macOS');
      expect(
        tierInputFromNavigator('nvidia', {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
        }).platform,
      ).toBe('Windows');
      // Android reports `Linux armv8l` as navigator.platform, so the user agent has to win or a tablet reads as a
      // Linux desktop — which would put it back on desktop budgets.
      expect(
        tierInputFromNavigator('arm mali-g710', {
          userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36',
          platform: 'Linux armv8l',
        }).platform,
      ).toBe('Android');
      expect(
        detectTier(
          tierInputFromNavigator('arm mali-g710', {
            userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36',
            platform: 'Linux armv8l',
            maxTouchPoints: 5,
          }),
        ),
      ).toBe('phone-mid');
      // Nothing but the deprecated platform string.
      expect(tierInputFromNavigator('intel', { platform: 'Linux x86_64' }).platform).toBe('Linux x86_64');
      // Nothing at all.
      expect(tierInputFromNavigator('intel', {}).platform).toBeUndefined();
    });

    it('under WebGPU: a Snapdragon X laptop whose adapter string names no graphics API is still a desktop', () => {
      // What cli-app/main.ts, test/app/main.ts and bench-app/runner.ts build for `gpu` on WebGPU: adapter.info's
      // description, else device, else vendor + architecture. It never names Direct3D, so DESKTOP_DRIVER cannot help.
      const nav = {
        maxTouchPoints: 10,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        userAgentData: { mobile: false, platform: 'Windows' },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
      };
      const input = tierInputFromNavigator('qualcomm adreno-x1', nav);
      expect(input.platform).toBe('Windows');
      expect(input.mobile).toBe(false);
      expect(detectTier(input)).toBe('desktop');
      // The same machine on WebGL2, where the ANGLE string carries the token instead.
      expect(detectTier(tierInputFromNavigator('ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)', nav))).toBe(
        'desktop',
      );
      // And this repository's own WebGPU adapter string on a Mac.
      expect(
        detectTier(
          tierInputFromNavigator('apple metal-3', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            platform: 'MacIntel',
            hardwareConcurrency: 10,
          }),
        ),
      ).toBe('desktop');
    });

    it('passes deviceMemory and hardwareConcurrency through as cores/deviceMemory', () => {
      const input = tierInputFromNavigator('Adreno 610', {
        deviceMemory: 3,
        hardwareConcurrency: 8,
        maxTouchPoints: 5,
      });
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
  it('reports every rule that trips on a phone-low frame', () => {
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
    f.skinning = {
      submissions: 200,
      vertices: 100_000,
      bones: 8000,
      skeletons: 200,
      maxBones: 60,
      morphTargets: 0,
      vatInstances: 0,
      vatVertices: 0,
    };
    f.lighting = {
      lights: { directional: 1, point: 1, spot: 0, hemisphere: 0, ambient: 0, other: 0 },
      shadowLights: 2,
      shadowPasses: 7,
      shadowCasters: 10,
      shadowTexels: 6 * 1024 * 1024,
      shadowSubmissions: 70,
    };
    f.memory = {
      textures: { count: 10, bytes: 200 * 1024 * 1024 },
      geometries: { count: 1, bytes: 60 * 1024 * 1024 },
      renderTargets: { count: 0, bytes: 0 },
      unreferenced: { geometries: 5, textures: 3 },
      chunks: { total: 0, resident: 0 },
      measured: null,
      estimated: true,
    };
    const hints = hintsFor(f, budgetsFor('phone-low'), {
      staticAutoUpdated: ['tree-1'],
      pointShadowLights: ['lamp'],
      transmissive: ['glass'],
    });
    expect(hints.map((h) => h.code).sort()).toEqual(
      [
        'over-budget-submissions',
        'over-budget-triangles',
        'point-light-shadow',
        'programs',
        'shadow-texels',
        'skinned-vertices',
        'bones-over-budget',
        'skinned-crowd',
        'static-auto-update',
        'texture-bytes',
        'geometry-bytes',
        'unreferenced-resources',
        'transmission',
        'transparent-overdraw',
        'unique-materials',
        'unsupported-material',
        'untagged',
      ].sort(),
    );
    expect(hints.find((h) => h.code === 'untagged')).toEqual({
      category: 'drawCalls',
      severity: 'warn',
      code: 'untagged',
      message: '7 untagged meshes: tag.static() or tag.dynamic() them',
      objects: ['crate', 'barrel'],
    });
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
    expect(hints.find((h) => h.code === 'untagged')?.message).toBe(
      '1 untagged meshes: tag.static() or tag.dynamic() them',
    );
    expect(hints.find((h) => h.code === 'unique-materials')?.message).toBe(
      '21 meshes each with a material used once: share materials through the registry',
    );
    expect(hints.map((h) => h.code)).not.toContain('static-unbatched');
    expect(hints.map((h) => h.code)).not.toContain('sprites-unbatched');
    // A reason drawn only outside the main pass names no main-pass object: no hint.
    expect(
      hintsFor(f, budgetsFor('desktop'), { objects: { ...objects, untagged: 0 } }).map((h) => h.code),
    ).not.toContain('untagged');
  });

  it('counts unsupported-material by the distinct objects the ledger passes, and by submissions without them', () => {
    const f = emptyFrame(env);
    // One ShaderMaterial mesh drawn in the main pass and in a reflection: two submissions, one mesh.
    f.byReason = { 'unsupported-material': { submissions: 2, gpuDraws: 2, top: ['fx-panel', 'fx-panel'] } };
    const message = (ctx: Parameters<typeof hintsFor>[2]) =>
      hintsFor(f, budgetsFor('desktop'), ctx).find((h) => h.code === 'unsupported-material')?.message;
    expect(message({ unsupportedObjects: 1 })).toBe(
      '1 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer',
    );
    expect(message({})).toBe('2 ShaderMaterial/RawShaderMaterial meshes do not render on WebGPURenderer');
  });

  it('reports static-unbatched above 20 statics that draw alone although their material is shared, apart from unique-materials', () => {
    const f = emptyFrame(env);
    f.byReason = {
      'static-unbatched': { submissions: 21, gpuDraws: 21, top: ['rock-1', 'rock-2'] },
      'unique-material': { submissions: 20, gpuDraws: 20, top: ['statue'] },
    };
    expect(hintsFor(f, budgetsFor('desktop'))).toEqual([
      {
        category: 'drawCalls',
        severity: 'info',
        code: 'static-unbatched',
        message:
          '21 static meshes draw one by one although other draws share their material: batch them with World (the draw that shares it may be one nothing can batch with: skinned, dynamic or already batched)',
        objects: ['rock-1', 'rock-2'],
      },
    ]);
    f.byReason['static-unbatched']!.submissions = 20;
    f.byReason['unique-material']!.submissions = 21;
    expect(hintsFor(f, budgetsFor('desktop')).map((h) => h.code)).toEqual(['unique-materials']);
  });

  it('uses singular wording for exactly one point light or transmissive mesh', () => {
    const f = emptyFrame(env);
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: ['lamp'], transmissive: ['glass'] });
    expect(hints.find((h) => h.code === 'point-light-shadow')).toEqual({
      category: 'lighting',
      severity: 'warn',
      code: 'point-light-shadow',
      message: '1 point light renders 6 shadow faces per frame: use a spot light or freeze its map',
      objects: ['lamp'],
    });
    expect(hints.find((h) => h.code === 'transmission')).toEqual({
      category: 'overdraw',
      severity: 'info',
      code: 'transmission',
      message: '1 mesh uses transmission: it renders in two passes and copies the frame buffer',
      objects: ['glass'],
    });
  });

  it('collapses multiple point lights or transmissive meshes into ONE hint per code, not one per object (both scale with the scene)', () => {
    const f = emptyFrame(env);
    const lights = ['lamp-1', 'lamp-2', 'lamp-3'];
    const meshes = ['glass-1', 'glass-2'];
    const hints = hintsFor(f, budgetsFor('desktop'), { pointShadowLights: lights, transmissive: meshes });
    const shadowHints = hints.filter((h) => h.code === 'point-light-shadow');
    expect(shadowHints).toHaveLength(1);
    expect(shadowHints[0]!.message).toBe(
      '3 point lights render 6 shadow faces per frame: use spot lights or freeze their maps',
    );
    expect(shadowHints[0]!.objects).toEqual(lights);
    const transmissionHints = hints.filter((h) => h.code === 'transmission');
    expect(transmissionHints).toHaveLength(1);
    expect(transmissionHints[0]!.message).toBe(
      '2 meshes use transmission: they render in two passes and copy the frame buffer',
    );
    expect(transmissionHints[0]!.objects).toEqual(meshes);
  });

  it("caps the collapsed hint's objects at 5 names even with many more lights, while the message states the true count", () => {
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
    expect(hints.find((h) => h.code === 'particles-over-budget')).toMatchObject({
      category: 'overdraw',
      severity: 'warn',
    });
    f.overdraw.particles = 0;
    f.byReason.sprite = { submissions: 8, gpuDraws: 8, top: ['rain-0'] };
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'sprites-unbatched')).toMatchObject({
      category: 'overdraw',
      severity: 'info',
      objects: ['rain-0'],
    });
    f.byReason.sprite.submissions = 7;
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'sprites-unbatched')).toBe(false);
    expect(budgetsFor('phone-mid').particles).toBe(15_000);
  });

  it('warns on geometry over budget and on unreferenced GPU resources', () => {
    const f = emptyFrame(env);
    f.memory.geometries.bytes = 50 * 1024 * 1024;
    expect(hintsFor(f, budgetsFor('phone-low')).find((h) => h.code === 'geometry-bytes')).toMatchObject({
      category: 'memory',
      severity: 'warn',
    });
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'geometry-bytes')).toBe(false);
    f.memory.geometries.bytes = 0;
    f.memory.unreferenced = { geometries: 4, textures: 4 };
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'unreferenced-resources')).toMatchObject({
      category: 'memory',
      severity: 'warn',
    });
    f.memory.unreferenced = { geometries: 4, textures: 3 };
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'unreferenced-resources')).toBe(false);
    expect(budgetsFor('phone-mid').geometryBytes).toBe(96 * 1024 * 1024);
  });

  it('warns on objects over budget and points at detaching hidden originals', () => {
    const f = emptyFrame(env);
    f.js.objects = 3000;
    expect(hintsFor(f, budgetsFor('phone-low')).find((h) => h.code === 'js-objects')).toMatchObject({
      category: 'js',
      severity: 'warn',
    });
    f.js.objects = 0;
    f.js.hiddenOriginals = 1000;
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'detach-originals')).toMatchObject({
      category: 'js',
      severity: 'info',
    });
    f.js.hiddenOriginals = 999;
    expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'detach-originals')).toBe(false);
    expect(budgetsFor('phone-mid').objects).toBe(5_000);
  });

  it('warns on bones over budget and points crowds at animation textures', () => {
    const f = emptyFrame(env);
    f.skinning.bones = 6000;
    expect(hintsFor(f, budgetsFor('phone-mid')).find((h) => h.code === 'bones-over-budget')).toMatchObject({
      category: 'skinning',
      severity: 'warn',
    });
    f.skinning.bones = 0;
    f.skinning.submissions = 50;
    expect(hintsFor(f, budgetsFor('desktop')).find((h) => h.code === 'skinned-crowd')).toMatchObject({
      category: 'skinning',
      severity: 'info',
    });
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
      expect(hints.find((h) => h.code === 'transparent-batch-order')).toMatchObject({
        category: 'overdraw',
        severity: 'info',
        objects: ['forge:batch:aa11:0', 'forge:batch:bb22:0'],
      });
    });

    it('fires when a threeforge transparent batch shares the main pass with an unbatched transparent mesh', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      const hints = hintsFor(f, budgetsFor('desktop'), { items });
      expect(hints.find((h) => h.code === 'transparent-batch-order')).toMatchObject({
        category: 'overdraw',
        severity: 'info',
      });
    });

    it('does not fire when the transparent batch is the only transparent submission in the main pass', () => {
      const f = emptyFrame(env);
      const items: HintItem[] = [{ name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched', transparent: true }];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(
        false,
      );
    });

    it('does not fire when nothing else in the main pass is transparent', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'crate', pass: 'main', reason: 'unique-material' as const, transparent: false },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(
        false,
      );
    });

    it('ignores a transparent submission outside the main pass (e.g. a shadow pass)', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: true },
        { name: 'shadow-thing', pass: 'shadow:Sun', reason: 'batched' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(
        false,
      );
    });

    it('does not fire without a threeforge transparent batch, even with several transparent meshes', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
        { name: 'glass-b', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(
        false,
      );
    });

    it('does not fire for an opaque threeforge batch even alongside other transparent submissions', () => {
      const f = emptyFrame(env);
      const items = [
        { name: 'forge:batch:aa11:0', pass: 'main', reason: 'batched' as const, transparent: false },
        { name: 'glass-a', pass: 'main', reason: 'transparent' as const, transparent: true },
      ];
      expect(hintsFor(f, budgetsFor('desktop'), { items }).some((h) => h.code === 'transparent-batch-order')).toBe(
        false,
      );
    });

    it('does not fire without items in the context', () => {
      const f = emptyFrame(env);
      expect(hintsFor(f, budgetsFor('desktop'), {}).some((h) => h.code === 'transparent-batch-order')).toBe(false);
      expect(hintsFor(f, budgetsFor('desktop')).some((h) => h.code === 'transparent-batch-order')).toBe(false);
    });

    it('caps the objects list at 5 names even with more threeforge transparent batches sharing the main pass', () => {
      const f = emptyFrame(env);
      const items = Array.from({ length: 8 }, (_, i) => ({
        name: `forge:batch:aa${i}:0`,
        pass: 'main',
        reason: 'batched' as const,
        transparent: true,
      }));
      const hint = hintsFor(f, budgetsFor('desktop'), { items }).find((h) => h.code === 'transparent-batch-order');
      expect(hint?.objects).toHaveLength(5);
      expect(hint?.objects).toEqual(items.slice(0, 5).map((i) => i.name));
    });
  });

  // The ledger gathers `localSpaceDraws` on its rescan (the batch-local-space describe at the end of this file covers
  // which draws it names); these pin the wording, the counts and the caps.
  describe('batch-local-space', () => {
    const tail =
      "a node in a material slot, custom material code, alphaHash or an object-space normal map, which threeforge cannot rule out reading mesh-local space, now the scene's: shading can change — tag them dynamic";

    it('names one compiled draw and its material in the singular', () => {
      const hints = hintsFor(emptyFrame(env), budgetsFor('desktop'), {
        localSpaceDraws: [{ object: 'forge:batch:aa11:0', material: 'gradient' }],
      });
      expect(hints.find((h) => h.code === 'batch-local-space')).toEqual({
        category: 'drawCalls',
        severity: 'warn',
        code: 'batch-local-space',
        message: `1 threeforge batched, instanced or baked draw uses ${tail} (materials: gradient)`,
        objects: ['forge:batch:aa11:0'],
      });
    });

    it('counts every draw, lists each material once and at most three, and caps objects at 5 names', () => {
      const materials = ['grass', 'grass', 'leaves', 'glass', 'water', 'water', 'fog'];
      const localSpaceDraws = materials.map((material, i) => ({ object: `forge:batch:aa${i}:0`, material }));
      const hint = hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws }).find(
        (h) => h.code === 'batch-local-space',
      );
      expect(hint?.message).toBe(
        `7 threeforge batched, instanced or baked draws use ${tail} (materials: grass, leaves, glass +2 more)`,
      );
      expect(hint?.objects).toEqual(localSpaceDraws.slice(0, 5).map((d) => d.object));
    });

    it('keeps a long material name within the message cap', () => {
      const hint = hintsFor(emptyFrame(env), budgetsFor('desktop'), {
        localSpaceDraws: [{ object: 'O'.repeat(500), material: 'M'.repeat(10_000) }],
      }).find((h) => h.code === 'batch-local-space');
      expect(hint?.message.length).toBeLessThanOrEqual(300);
      expect(
        hint?.message.startsWith(`1 threeforge batched, instanced or baked draw uses ${tail} (materials: MMM`),
      ).toBe(true);
      expect(hint?.objects[0]?.length).toBeLessThanOrEqual(120);
    });

    it('does not fire without such draws', () => {
      expect(
        hintsFor(emptyFrame(env), budgetsFor('desktop'), { localSpaceDraws: [] }).some(
          (h) => h.code === 'batch-local-space',
        ),
      ).toBe(false);
      expect(hintsFor(emptyFrame(env), budgetsFor('desktop')).some((h) => h.code === 'batch-local-space')).toBe(false);
    });
  });
});

describe('DrawCallLedger shared materials: unique-material and static-unbatched', () => {
  const named = <T extends Mesh>(mesh: T, name: string): T => {
    mesh.name = name;
    return mesh;
  };
  const indexOf = (ledger: DrawCallLedger, name: string) =>
    ledger.frame({ items: true }).items!.find((i) => i.name === name)!.material;

  it('calls two statics sharing one built-in material static-unbatched, without a World; a material instance drawn once stays unique-material', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const shared = new MeshStandardMaterial({ color: 0x336699 });
    // Equal by value, but its own instance and never registered: nothing else draws it.
    const own = new MeshStandardMaterial({ color: 0x336699 });
    scene.add(
      named(tag.static(new Mesh(box, shared)), 'a'),
      named(tag.static(new Mesh(new PlaneGeometry(1, 1), shared)), 'b'),
      named(tag.static(new Mesh(box, own)), 'alone'),
    );
    renderer.render(scene, camera);
    const frame = ledger.frame();
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
    expect(frame.byReason['static-unbatched']).toEqual({ submissions: 2, gpuDraws: 2, top: ['a', 'b'] });
    expect(frame.byReason['unique-material']).toEqual({ submissions: 1, gpuDraws: 1, top: ['alone'] });
    expect(indexOf(ledger, 'a')).toBe(indexOf(ledger, 'b'));
    expect(indexOf(ledger, 'alone')).not.toBe(indexOf(ledger, 'a'));
  });

  it('counts uses per registry canonical: identical registered built-ins share one, materials differing only in an instance onBeforeRender do not', () => {
    const { renderer, registry, ledger, scene, camera } = attachedLedger();
    const first = new MeshStandardMaterial({ color: 0x884422 });
    const second = new MeshStandardMaterial({ color: 0x884422 });
    registry.register(first);
    registry.register(second);
    expect(registry.canonicalOf(second)).toBe(first);
    const hooked = [0, 1].map(() => {
      const material = new MeshStandardMaterial({ color: 0x224488 });
      material.onBeforeRender = () => {};
      registry.register(material);
      return material;
    });
    expect(registry.canonicalOf(hooked[1]!)).toBe(hooked[1]);
    // The meshes keep their own instances: no World swapped the canonicals in.
    scene.add(
      named(tag.static(new Mesh(box, first)), 'merged-1'),
      named(tag.static(new Mesh(box, second)), 'merged-2'),
      named(tag.static(new Mesh(box, hooked[0]!)), 'hooked-1'),
      named(tag.static(new Mesh(box, hooked[1]!)), 'hooked-2'),
    );
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({
      'merged-1': 'static-unbatched',
      'merged-2': 'static-unbatched',
      'hooked-1': 'unique-material',
      'hooked-2': 'unique-material',
    });
    expect(indexOf(ledger, 'merged-1')).toBe(indexOf(ledger, 'merged-2'));
    expect(indexOf(ledger, 'hooked-1')).not.toBe(indexOf(ledger, 'hooked-2'));
  });

  it('counts uses per object: a static the main pass draws twice (the back-side pass of a double-sided transmissive material) is not shared with itself', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    scene.add(
      named(tag.static(new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }))), 'glass'),
    );
    renderer.render(scene, camera);
    const glass = ledger.frame({ items: true }).items!.filter((i) => i.pass === 'main' && i.name === 'glass');
    expect(glass).toHaveLength(2);
    expect(glass.map((i) => i.reason)).toEqual(['unique-material', 'unique-material']);
    expect(glass[0]!.material).toBe(glass[1]!.material);
  });

  it('counts main-pass uses only, and relabels a shared static in every pass it draws in', () => {
    const sun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: sun });
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const caster = named(tag.static(new Mesh(box, stone)), 'caster');
    caster.castShadow = true;
    // Drawn in the main pass and, through its hook, the only user of `paint` in the main pass: a second scene draws it too.
    const paint = new MeshStandardMaterial({ color: 0x3355ff });
    const portal = named(tag.static(new Mesh(box, paint)), 'portal');
    const room = new Scene();
    room.name = 'room';
    room.add(named(tag.static(new Mesh(box, paint)), 'far-wall'));
    let inside = false;
    portal.onBeforeRender = ((r: unknown) => {
      if (inside) return;
      inside = true;
      (r as FakeRenderer).render(room, camera);
      inside = false;
    }) as Mesh['onBeforeRender'];
    scene.add(sun, caster, named(tag.static(new Mesh(box, stone)), 'plinth'), portal);
    renderer.render(scene, camera);
    expect(reasonsIn(ledger)).toEqual({
      caster: 'static-unbatched',
      plinth: 'static-unbatched',
      portal: 'unique-material',
    });
    expect(reasonsIn(ledger, 'shadow:sun')).toEqual({ caster: 'static-unbatched' });
    expect(reasonsIn(ledger, 'scene:room')).toEqual({ 'far-wall': 'unique-material' });
  });

  it("counts no use for renderer-internal work: a static sharing the output quad's material stays unique-material", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const shared = new MeshStandardMaterial({ color: 0x66aa44 });
    // three's output quad is the renderer's own object, drawn in the main pass and filed as renderer-internal.
    renderer.outputQuad.material = shared;
    scene.add(named(tag.static(new Mesh(box, shared)), 'alone'));
    renderer.render(scene, camera);

    const items = ledger.frame({ items: true }).items!;
    const quad = items.find((i) => i.name === 'Output Color Transform')!;
    const alone = items.find((i) => i.name === 'alone')!;
    expect(quad.reason).toBe('renderer-internal');
    // The quad's submission is still indexed (every record carries a material index, and it is the same canonical)
    // but it counts as no user, so the scene's static is still the only object drawing that material.
    expect(quad.material).toBe(alone.material);
    expect(reasonsIn(ledger)).toEqual({ alone: 'unique-material' });
  });

  it('counts no use from a measureOverdraw() a hook of the frame starts: its count renders are not submissions', async () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const stone = new MeshStandardMaterial({ color: 0x777777 });
    const a = named(tag.static(new Mesh(box, stone)), 'a');
    const b = named(tag.static(new Mesh(box, stone)), 'b');
    scene.add(a, b, named(tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x224466 }))), 'alone'));
    renderer.render(scene, camera);
    const plain = ledger.frame({ items: true });

    let pending: Promise<unknown> | null = null;
    let started = false;
    a.onBeforeRender = () => {
      // Measure once: the count render draws `a` again and calls this hook with it.
      if (started) return;
      started = true;
      pending = ledger.measureOverdraw(scene, camera);
    };
    renderer.render(scene, camera);
    const hooked = ledger.frame({ items: true });
    a.onBeforeRender = () => {};
    expect(pending).not.toBeNull();
    await pending;

    // The count renders drew every object again with the count material; none of it was filed, so the frame's
    // material indices and reasons are exactly those of the frame before it.
    const keyed = (frame: typeof plain) => frame.items!.map((i) => [i.name, i.material, i.reason]);
    expect(keyed(hooked)).toEqual(keyed(plain));
    expect(reasonsIn(ledger)).toEqual({ a: 'static-unbatched', b: 'static-unbatched', alone: 'unique-material' });
  });

  it('indexes materials per frame in first-draw order and decides shared per frame; items held from an earlier frame keep their values', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const red = new MeshStandardMaterial({ color: 0xff0000 });
    const blue = new MeshStandardMaterial({ color: 0x0000ff });
    const lead = named(tag.static(new Mesh(box, red)), 'lead');
    const twin = named(tag.static(new Mesh(box, blue)), 'twin');
    const other = named(tag.static(new Mesh(box, blue)), 'other');
    scene.add(lead, twin, other);
    renderer.render(scene, camera);
    const scene1 = (items: SubmissionRecord[]) =>
      items.filter((i) => i.reason !== 'renderer-internal').map((i) => [i.name, i.material, i.reason]);
    const first = ledger.frame({ items: true }).items!;
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
    lead.visible = false;
    other.visible = false;
    renderer.render(scene, camera);
    expect(scene1(ledger.frame({ items: true }).items!)).toEqual([['twin', 0, 'unique-material']]);
    expect(scene1(first)).toEqual([
      ['lead', 0, 'unique-material'],
      ['twin', 1, 'static-unbatched'],
      ['other', 1, 'static-unbatched'],
    ]);
  });
});

describe('DrawCallLedger hints count objects, not submissions', () => {
  /** The object count the hint with `code` opens its message with; undefined without the hint. The wording is pinned above. */
  const countOf = (ledger: DrawCallLedger, code: string): number | undefined => {
    const hint = ledger.frame().hints.find((h) => h.code === code);
    return hint && Number(/^\d+/.exec(hint.message)?.[0]);
  };

  it('counts 11 shadow-casting statics under a sun as 11 meshes: no unique-materials hint below its threshold of more than 20', () => {
    const sun = casting(new DirectionalLight(), 'sun');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: sun });
    scene.add(sun);
    for (let i = 0; i < 11; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x101010 * (i + 1) })));
      mesh.name = `statue-${i}`;
      mesh.castShadow = true;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unique-material']?.submissions, 'main and shadow pass').toBe(22);
    expect(countOf(ledger, 'unique-materials')).toBeUndefined();
    for (let i = 11; i < 21; i++) {
      const mesh = tag.static(new Mesh(box, new MeshStandardMaterial({ color: 0x0f0f0f * (i + 1) })));
      mesh.name = `statue-${i}`;
      scene.add(mesh);
    }
    renderer.render(scene, camera);
    expect(countOf(ledger, 'unique-materials')).toBe(21);
  });

  it('counts one untagged caster under a point light as one untagged mesh, not seven', () => {
    const lamp = casting(new PointLight(0xffffff, 1), 'lamp');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: lamp });
    const crate = new Mesh(box, new MeshStandardMaterial());
    crate.name = 'crate';
    crate.castShadow = true;
    scene.add(lamp, crate);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason.untagged?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(countOf(ledger, 'untagged')).toBe(1);
  });

  it("counts a double-sided transmissive mesh once although the main pass draws it twice (three's back-side pass)", () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const glass = new Mesh(box, new MeshPhysicalMaterial({ transmission: 1, side: DoubleSide }));
    glass.name = 'glass';
    scene.add(glass);
    renderer.render(scene, camera);
    expect(ledger.frame({ items: true }).items!.filter((i) => i.name === 'glass' && i.pass === 'main')).toHaveLength(2);
    expect(countOf(ledger, 'untagged')).toBe(1);
  });

  it('counts unsupported-material by distinct objects over every pass: one caster under a point light is one mesh, and one drawn only into its shadow map still counts', () => {
    const lamp = casting(new PointLight(0xffffff, 1), 'lamp');
    const { renderer, ledger, scene, camera } = attachedLedger({ shadowLight: lamp });
    const panel = tag.static(new Mesh(box, new ShaderMaterial()));
    panel.name = 'panel';
    panel.castShadow = true;
    scene.add(lamp, panel);
    renderer.render(scene, camera);
    expect(ledger.frame().byReason['unsupported-material']?.submissions, 'the main pass and six cube faces').toBe(7);
    expect(countOf(ledger, 'unsupported-material')).toBe(1);
    // On a layer the main camera does not see, so only the six shadow faces draw it. Its material renders nowhere on
    // WebGPU either, so it is still a mesh this error hint names, although no main-pass record carries it.
    const offCamera = tag.static(new Mesh(box, new ShaderMaterial()));
    offCamera.name = 'off-camera';
    offCamera.castShadow = true;
    offCamera.layers.set(1);
    lamp.shadow.camera.layers.enable(1);
    scene.add(offCamera);
    renderer.render(scene, camera);
    const drawn = ledger.frame({ items: true }).items!.filter((i) => i.name === 'off-camera');
    expect(drawn.map((i) => i.pass)).toEqual(Array(6).fill('shadow:lamp'));
    expect(ledger.frame().byReason['unsupported-material']?.submissions).toBe(13);
    expect(countOf(ledger, 'unsupported-material')).toBe(2);
    ledger.rescan();
    expect(countOf(ledger, 'unsupported-material')).toBe(2);
  });

  it('counts sprites drawn one by one as objects for sprites-unbatched, and keeps the counts on a rescan between frames', () => {
    const { renderer, ledger, scene, camera } = attachedLedger();
    const material = new SpriteMaterial();
    for (let i = 0; i < 8; i++) scene.add(new Sprite(material));
    renderer.render(scene, camera);
    expect(countOf(ledger, 'sprites-unbatched')).toBe(8);
    ledger.rescan();
    expect(countOf(ledger, 'sprites-unbatched')).toBe(8);
  });
});

/**
 * `batch-local-space`: three r186 gives a batched or instanced draw `positionLocal` multiplied by its instance matrix
 * (Batch.js:148, Instance.js:206-207), and a baked mesh's positions are written in scene space, so a node reading
 * `positionLocal` and `alphaHash` (which hashes it, NodeMaterial.js:893) may draw differently than the individual
 * meshes. The ledger names World's compiled draws whose material has a node in a slot (`hasNodeSlot`) or `alphaHash`,
 * and nothing else.
 */
describe('DrawCallLedger batch-local-space hint', () => {
  const CODE = 'batch-local-space';
  const hint = (ledger: DrawCallLedger) => ledger.frame().hints.find((h) => h.code === CODE);
  const gradient = (): Material =>
    Object.assign(new MeshStandardNodeMaterial(), {
      name: 'gradient',
      colorNode: mix(color(0x2040ff), color(0xff8020), positionLocal.y.add(0.5)),
    });
  const hashed = (): Material => new MeshStandardMaterial({ name: 'hashed', alphaHash: true, opacity: 0.5 });
  const engraved = (
    normalMapType: NormalMapTypes = ObjectSpaceNormalMap,
    normalMap: Texture | null = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1),
  ): Material => new MeshStandardMaterial({ name: 'engraved', normalMap, normalMapType });

  /**
   * `count` transformed boxes sharing `material` (or the material `material(registry)` returns, given the ledger's
   * registry, which World uses too), tagged static (or dynamic), compiled by World, then one frame rendered.
   */
  function compiled(
    source: Material | ((registry: MaterialRegistry) => Material),
    options: { count?: number; dynamic?: boolean; world?: WorldOptions; geometry?: BufferGeometry } = {},
  ) {
    const { renderer, registry, ledger, scene, camera } = attachedLedger();
    const material = typeof source === 'function' ? source(registry) : source;
    for (let i = 0; i < (options.count ?? 4); i++) {
      const mesh = new Mesh(options.geometry ?? box, material);
      mesh.name = `box-${i}`;
      mesh.position.set(i * 1.5 - 2, 0, 0);
      mesh.rotation.set(0.3, i * 0.2, 0.4);
      mesh.scale.set(1, 1.6, 0.8);
      scene.add(options.dynamic ? tag.dynamic(mesh) : tag.static(mesh));
    }
    scene.updateMatrixWorld(true);
    const world = new World(scene, { registry, ledger, ...options.world });
    const report = world.compile();
    renderer.render(scene, camera);
    return { renderer, ledger, scene, camera, world, report };
  }

  it('fires for a batch whose material has a node in a slot, naming the batch and the material', () => {
    const { ledger, report } = compiled(gradient());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toMatchObject({
      category: 'drawCalls',
      severity: 'warn',
      code: CODE,
      objects: [report.groups[0]!.name],
    });
    expect(hint(ledger)?.message.endsWith('(materials: gradient)')).toBe(true);
    expect(report.groups[0]!.name.startsWith('forge:batch:')).toBe(true);
  });

  it('fires for a batch whose material has alphaHash', () => {
    const { ledger, report } = compiled(hashed());
    expect(report.after).toEqual(expect.objectContaining({ batches: 1, instanced: 0, baked: 0 }));
    expect(hint(ledger)).toMatchObject({ severity: 'warn', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: hashed)')).toBe(true);
  });

  it('fires for a batch whose material has an object-space normal map, not for a tangent-space one or the map type without a map', () => {
    const { ledger, report } = compiled(engraved());
    expect(report.after.batches).toBe(1);
    expect(hint(ledger)).toMatchObject({ severity: 'warn', objects: [report.groups[0]!.name] });
    expect(hint(ledger)?.message.endsWith('(materials: engraved)')).toBe(true);
    for (const [label, material] of [
      ['a tangent-space normal map', engraved(TangentSpaceNormalMap)],
      ['ObjectSpaceNormalMap without a normalMap', engraved(ObjectSpaceNormalMap, null)],
    ] as Array<[string, Material]>) {
      const silent = compiled(material);
      expect(silent.report.after.batches, label).toBe(1);
      expect(hint(silent.ledger), label).toBeUndefined();
    }
  });

  it('fires for instanced groups and a baked group of such materials, one name per group', () => {
    // A level attached by hand (what prepareLods stores): the group draws as two InstancedMeshes sharing its material.
    const leveled = new BoxGeometry(1, 1, 1);
    leveled.userData.forgeLods = [new BoxGeometry(1, 1, 1)];
    const node = compiled(gradient(), { geometry: leveled, world: { instanceThreshold: 4, lod: { distances: [30] } } });
    expect(node.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 2, baked: 0 }));
    expect(node.world.instancedMeshes.map((m) => m.material)).toEqual([
      node.world.instancedMeshes[0]!.material,
      node.world.instancedMeshes[0]!.material,
    ]);
    expect(hint(node.ledger)?.objects).toEqual([node.report.groups[0]!.name]);
    expect(hint(node.ledger)?.message.startsWith('1 threeforge batched, instanced or baked draw uses')).toBe(true);
    expect(node.report.groups[0]!.name.startsWith('forge:instanced:')).toBe(true);
    const hash = compiled(hashed(), { world: { instanceThreshold: 4 } });
    expect(hash.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 1, baked: 0 }));
    expect(hint(hash.ledger)?.objects).toEqual([hash.report.groups[0]!.name]);
    // The bake writes every module in scene space, so its positions are what batching would hand positionLocal. A node
    // material never bakes (bakeProvesReads); alphaHash does.
    const baked = compiled(hashed(), { world: { bake: true } });
    expect(baked.report.after).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 1 }));
    expect(hint(baked.ledger)?.objects).toEqual([baked.report.groups[0]!.name]);
    // An object-space normal map bakes too, and three transforms its normals by the baked mesh's (the scene's) matrix.
    for (const world of [{ instanceThreshold: 4 }, { bake: true }] as WorldOptions[]) {
      const normals = compiled(engraved(), { world });
      expect(normals.report.after.batches + normals.report.after.instanced + normals.report.after.baked).toBe(1);
      expect(normals.report.after.batches, JSON.stringify(world)).toBe(0);
      expect(hint(normals.ledger)?.objects, JSON.stringify(world)).toEqual([normals.report.groups[0]!.name]);
    }
  });

  it('fires for a batch whose material is a subclass or carries an own function, even with no node slot set', () => {
    // A subclass can read `positionLocal` from an overridden `setup*` without ever assigning a `*Node` property, so
    // `hasNodeSlot` alone misses it: the same class `bakeProvesReads` (`bakeGate.ts`) refuses and `spriteRule` names
    // `sprite-custom-material`. Here `setupPosition` displaces along `positionLocal`, which batching replaces with the
    // scene-space position.
    class Ripple extends MeshStandardNodeMaterial {
      override setupPosition(
        ...args: Parameters<MeshStandardNodeMaterial['setupPosition']>
      ): ReturnType<MeshStandardNodeMaterial['setupPosition']> {
        void args;
        return positionLocal.add(positionLocal.y.mul(0.1)) as ReturnType<MeshStandardNodeMaterial['setupPosition']>;
      }
    }
    const subclass = Object.assign(new Ripple(), { name: 'ripple' }) as unknown as Material;
    expect(hasNodeSlot(subclass)).toBe(false); // no *Node own property
    const sub = compiled(subclass);
    expect(sub.report.after.batches).toBe(1);
    expect(hint(sub.ledger)?.objects).toEqual([sub.report.groups[0]!.name]);
    expect(hint(sub.ledger)?.message.endsWith('(materials: ripple)')).toBe(true);

    // An own function on a built-in instance is the same risk without a subclass: `setup` can read positionLocal.
    const own = new MeshStandardNodeMaterial();
    own.name = 'hooked';
    (own as unknown as { setup: () => unknown }).setup = () => positionLocal;
    expect(hasNodeSlot(own as unknown as Material)).toBe(false);
    const hooked = compiled(own as unknown as Material);
    expect(hooked.report.after.batches).toBe(1);
    expect(hint(hooked.ledger)?.objects).toEqual([hooked.report.groups[0]!.name]);
  });

  it('stays silent for batches of a plain registered standard material and of a node material with every slot empty', () => {
    const plain = (registry: MaterialRegistry): Material =>
      registry.register(new MeshStandardMaterial({ color: 0x808080 }));
    for (const [label, material] of [
      ['registered MeshStandardMaterial', plain],
      ['MeshStandardNodeMaterial without nodes', new MeshStandardNodeMaterial()],
    ] as Array<[string, Material | typeof plain]>) {
      const { ledger, report } = compiled(material);
      expect(report.after.batches, label).toBe(1);
      expect(hint(ledger), label).toBeUndefined();
      ledger.rescan();
      expect(hint(ledger), label).toBeUndefined();
    }
  });

  it('stays silent for dynamic meshes carrying such materials, which World leaves individual (it names them once batch-sync batches them)', () => {
    for (const [label, material] of [
      ['node slot', gradient()],
      ['alphaHash', hashed()],
      ['object-space normal map', engraved()],
    ] as Array<[string, Material]>) {
      const separate = compiled(material, { dynamic: true });
      expect(separate.report.after, label).toEqual(expect.objectContaining({ batches: 0, instanced: 0, baked: 0 }));
      expect(separate.ledger.frame().byReason.dynamic?.submissions, label).toBe(4);
      expect(hint(separate.ledger), label).toBeUndefined();
      const synced = compiled(material, { dynamic: true, world: { dynamics: 'batch-sync' } });
      expect(synced.report.after.batches, label).toBe(1);
      expect(hint(synced.ledger)?.objects, label).toEqual([synced.report.groups[0]!.name]);
    }
  });

  it('names only what three renders and what World compiled: no hint for a hidden batch, after decompile(), or for an app-built BatchedMesh', () => {
    const { ledger, world, scene, renderer, camera } = compiled(gradient());
    expect(hint(ledger)).toBeDefined();
    world.batchedMeshes[0]!.visible = false;
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    world.batchedMeshes[0]!.visible = true;
    ledger.rescan();
    expect(hint(ledger)).toBeDefined();
    world.decompile();
    renderer.render(scene, camera);
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
    // An app's own BatchedMesh is not threeforge's to explain.
    scene.add(tag.static(batchedOf(2, gradient(), box)));
    ledger.rescan();
    expect(hint(ledger)).toBeUndefined();
  });
});
