import type { Tier } from './snapshot.js';

export type { Tier };

/** Per-tier ceilings the hints compare a frame against. Lower is better for every metric. */
export interface Budgets {
  sceneSubmissions: number;
  triangles: number;
  /** Transparent fragments rasterised per pixel. */
  transparentOverdraw: number;
  skinnedVertices: number;
  shadowTexels: number;
  textureBytes: number;
  frameMs: number;
  /** Particles drawn per frame (points vertices, sprites, sprite-batch instances). */
  particles: number;
  /** Objects three walks every frame (matrix update and render-list build). */
  objects: number;
  /** Skeleton bones updated on the CPU per frame (every skinned mesh's skeleton). */
  bones: number;
  /** Estimated geometry bytes resident on the GPU. */
  geometryBytes: number;
}

const MB = 1024 * 1024;

export const BUDGETS: Record<Tier, Budgets> = {
  desktop: { sceneSubmissions: 400, triangles: 5_000_000, transparentOverdraw: 3, skinnedVertices: 400_000, shadowTexels: 4 * MB, textureBytes: 512 * MB, frameMs: 16.6, particles: 60_000, objects: 20_000, bones: 20_000, geometryBytes: 256 * MB },
  'phone-mid': { sceneSubmissions: 150, triangles: 1_500_000, transparentOverdraw: 2, skinnedVertices: 150_000, shadowTexels: 1 * MB, textureBytes: 192 * MB, frameMs: 16.6, particles: 15_000, objects: 5_000, bones: 5_000, geometryBytes: 96 * MB },
  'phone-low': { sceneSubmissions: 80, triangles: 500_000, transparentOverdraw: 1.5, skinnedVertices: 60_000, shadowTexels: 262_144, textureBytes: 96 * MB, frameMs: 33, particles: 5_000, objects: 2_000, bones: 2_000, geometryBytes: 48 * MB },
};

export function budgetsFor(tier: Tier, overrides: Partial<Budgets> = {}): Budgets {
  return { ...BUDGETS[tier], ...overrides };
}

export interface TierInput {
  /** Adapter description (WebGPU `adapter.info`) or the WebGL unmasked renderer string. */
  gpu?: string;
  deviceMemory?: number;
  cores?: number;
  /** Real touch capability (`navigator.maxTouchPoints > 0`). Not a mobile/phone signal by itself — see `mobile`. */
  touch?: boolean;
  /**
   * Whether the OS/browser itself reports this as a mobile device (`navigator.userAgentData.mobile`, or a
   * user agent sniff — see `tierInputFromNavigator`). `undefined` when neither signal is available, in
   * which case `detectTier` falls back to `touch` alone (step 6). Distinct from `touch`: a touch-capable
   * desktop reports `touch: true, mobile: false`.
   */
  mobile?: boolean;
  dpr?: number;
}

/** Low-end mobile GPUs: Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR SGX, VideoCore. */
const LOW_END = /\badreno[^0-9]*(?:[1-5]\d\d|6[0-3]\d)\b|\bmali-g[1-5]\d\b|\bmali-t|\bmali-4|\bsgx\b|\bvideocore\b/i;

/**
 * Mobile/tablet GPUs not already caught by LOW_END: higher-end Adreno/Mali, PowerVR, Xclipse, Qualcomm,
 * Apple A-series. VideoCore is deliberately not repeated here: every VideoCore string LOW_END recognises
 * already matches unconditionally there, so a VideoCore branch here could never fire.
 *
 * This is a weak signal — these families also ship in laptops (Snapdragon X) — so it decides after
 * `DESKTOP_GPU` and `DESKTOP_DRIVER`. It still outranks an explicit `mobile === false`, because Chrome reports
 * an Android tablet as not mobile: with no desktop graphics API named beside the GPU, the family name is the
 * better guess.
 */
const MOBILE_GPU = /\badreno\b|\bmali\b|\bpowervr\b|\bxclipse\b|\bqualcomm\b|\bapple a\d/i;

/** Discrete/desktop GPUs and software rasterizers: decisive regardless of touch. Bounded so e.g. "Intelligent Renderer" or "Malibu GPU" cannot false-match. */
const DESKTOP_GPU = /\bnvidia\b|\bgeforce\b|\bradeon\b|\bamd\b|\bintel\b|\biris\b|\barc\b|\bapple m\d|\bswiftshader\b/i;

/**
 * Renderer strings only a desktop/laptop driver stack produces: ANGLE's Direct3D backends and any string
 * naming Windows. Decisive against `MOBILE_GPU`, because Windows-on-ARM laptops (Snapdragon X and 8cx)
 * carry Adreno GPUs and report both brands through ANGLE, e.g.
 * `ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)`. Android's ANGLE strings name OpenGL ES or
 * Vulkan instead, so they never match here — which is the whole of what separates that laptop from an Android
 * tablet, since Chrome calls both of them not mobile. A Windows-on-ARM browser that reported a bare
 * `Qualcomm Adreno X1-85` with no API named would read `phone-mid`; every Windows browser goes through ANGLE,
 * so the string carries `D3D11`.
 */
const DESKTOP_DRIVER = /\bd3d(?:9|11|12)?\b|\bdirect3d\d*\b|\bwindows\b/i;

/**
 * A coarse device tier: budgets and later modules key off it.
 *
 * GPU-first decision order, so a touch-capable desktop (a Windows laptop with a discrete GPU and a
 * touchscreen) is not mistaken for a phone. All seven steps live here (Ruling R56 —
 * `tierInputFromNavigator` only resolves `mobile`/`touch`, it does not itself decide a tier), so
 * `detectTier` never disagrees with what the helper feeds it. A mobile GPU *family name* is the weakest
 * of the signals, so it decides only after the three that contradict it directly:
 *   1. `LOW_END` matches -> `phone-low`. These families ship in no laptop, so nothing outranks them.
 *   2. Any "Apple" name with `touch` -> `phone-mid`, or `phone-low` under `deviceMemory <= 2` (Ruling
 *      R57). Before step 3, because an M-series with a touchscreen is an iPad, not a Mac.
 *   3. `DESKTOP_GPU` matches -> `desktop`, whatever `touch`/`mobile` say.
 *   4. `DESKTOP_DRIVER` matches (an ANGLE Direct3D or Windows renderer string) -> `desktop`. A
 *      Windows-on-ARM laptop reports a mobile GPU family (Adreno, Qualcomm) and is not mobile.
 *   5. `MOBILE_GPU` matches -> `phone-mid`, or `phone-low` when `deviceMemory <= 2` (Ruling R57). Before the
 *      `mobile` step, because Chrome reports an Android **tablet** as `userAgentData.mobile: false`: taking
 *      that as "desktop" gave a Mali tablet desktop budgets. What tells the tablet from the Windows-on-ARM
 *      laptop is the graphics API in the renderer string, which steps 3-4 have already had their say on, so a
 *      mobile GPU family reaching this step has no desktop API named beside it.
 *   6. `mobile`, when defined (set by `tierInputFromNavigator` from `userAgentData.mobile` or a user agent
 *      sniff): `true` -> `phone-mid` (or `phone-low` under `deviceMemory <= 2`, Ruling R57); `false` ->
 *      `desktop`. For a GPU string none of steps 1-5 recognised, the browser's own answer is the best signal.
 *   7. Otherwise the old touch-only rule: no `touch` -> `desktop`; `touch` and `deviceMemory <= 2` ->
 *      `phone-low`; `touch` otherwise -> `phone-mid`.
 */
export function detectTier({ gpu = '', deviceMemory, touch = false, mobile }: TierInput): Tier {
  const lowMemory = deviceMemory !== undefined && deviceMemory <= 2;
  const phone = (): Tier => (lowMemory ? 'phone-low' : 'phone-mid');
  if (LOW_END.test(gpu)) return 'phone-low';
  if (/apple/i.test(gpu) && touch) return phone();
  if (DESKTOP_GPU.test(gpu)) return 'desktop';
  if (DESKTOP_DRIVER.test(gpu)) return 'desktop';
  if (MOBILE_GPU.test(gpu)) return phone();
  if (mobile !== undefined) return mobile ? phone() : 'desktop';
  if (!touch) return 'desktop';
  return phone();
}

/** The subset of `navigator` tier detection reads. Passed explicitly (not read off a global) so it is unit-testable with fake navigators. */
export interface TierNavigator {
  maxTouchPoints?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
  /** Chromium-only (User-Agent Client Hints); absent everywhere else. */
  userAgentData?: { mobile?: boolean };
}

/** MDN's recommended sniff for a mobile user agent string. */
const MOBILE_UA = /mobi/i;

/**
 * Builds a `TierInput` from a GPU name and `navigator`, so `test/app/main.ts`, `cli-app/main.ts` and
 * `bench-app/runner.ts` all assemble tier detection input the same way.
 *
 * `touch` is the real touch capability (`maxTouchPoints > 0`) and nothing else. `mobile` (step 5 of
 * `detectTier`) is resolved separately, in order: `userAgentData.mobile` (Chromium, most reliable — a
 * touch-capable desktop reports `false`), then a "Mobi" sniff of the user agent string (non-Chromium
 * browsers), else left `undefined` when neither is available (so `detectTier` falls back to `touch` alone).
 */
export function tierInputFromNavigator(gpu: string, nav: TierNavigator): TierInput {
  const touchPoints = nav.maxTouchPoints ?? 0;
  const uaMobile = nav.userAgentData?.mobile;
  const mobile = uaMobile !== undefined ? uaMobile : nav.userAgent !== undefined ? MOBILE_UA.test(nav.userAgent) : undefined;
  return {
    gpu,
    touch: touchPoints > 0,
    mobile,
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    dpr: (globalThis as { devicePixelRatio?: number }).devicePixelRatio,
  };
}
