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
   * Whether the OS/browser itself reports this as a mobile device (`navigator.userAgentData.mobile`, or a user agent
   * sniff, see `tierInputFromNavigator`). `undefined` when neither signal is available, in which case `detectTier`
   * falls back to `touch` alone. Distinct from `touch`: a touch-capable desktop reports `touch: true, mobile: false`.
   */
  mobile?: boolean;
  /**
   * The operating system the browser reports, as it reports it (`navigator.userAgentData.platform`, else a parse of
   * `navigator.platform` or the user agent string, see `tierInputFromNavigator`): `Windows`, `Win32`, `macOS`,
   * `MacIntel`, `Linux x86_64`, `Chrome OS`, `Android`, `iOS` and so on. Matched case-insensitively by family.
   *
   * The only signal that separates a Windows-on-ARM laptop from an Android tablet under WebGPU, where the `gpu`
   * string is built from `adapter.info` and names no graphics API for `DESKTOP_DRIVER` to match. `undefined` when
   * the browser reports nothing usable, in which case `detectTier` falls back to the GPU family name.
   */
  platform?: string;
  dpr?: number;
}

/** Low-end mobile GPUs: Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR SGX, VideoCore. */
const LOW_END = /\badreno[^0-9]*(?:[1-5]\d\d|6[0-3]\d)\b|\bmali-g[1-5]\d\b|\bmali-t|\bmali-4|\bsgx\b|\bvideocore\b/i;

/**
 * Mobile/tablet GPUs not already caught by LOW_END: higher-end Adreno/Mali, PowerVR, Xclipse, Qualcomm, Apple
 * A-series (VideoCore is not repeated: every string LOW_END recognises matches there first). A weak signal, since
 * these families also ship in laptops (Snapdragon X): it decides after `DESKTOP_GPU` and `DESKTOP_DRIVER`, and a
 * desktop `platform` overrides it. It still outranks `mobile === false`, which Chrome reports for an Android tablet.
 */
const MOBILE_GPU = /\badreno\b|\bmali\b|\bpowervr\b|\bxclipse\b|\bqualcomm\b|\bapple a\d/i;

/** Discrete/desktop GPUs and software rasterizers: decisive regardless of touch. Bounded so e.g. "Intelligent Renderer" or "Malibu GPU" cannot false-match. */
const DESKTOP_GPU = /\bnvidia\b|\bgeforce\b|\bradeon\b|\bamd\b|\bintel\b|\biris\b|\barc\b|\bapple m\d|\bswiftshader\b/i;

/**
 * Renderer strings only a desktop/laptop driver stack produces: ANGLE's Direct3D backends and any string naming
 * Windows. Decisive against `MOBILE_GPU`: Windows-on-ARM laptops (Snapdragon X and 8cx) carry Adreno GPUs and report
 * both through ANGLE, e.g. `ANGLE (Qualcomm, Adreno (TM) X1-85 (0x00043050), D3D11)`, while Android's ANGLE strings
 * name OpenGL ES or Vulkan. A WebGL2 convention only: a WebGPU `gpu` string comes from `adapter.info` and never names
 * an API (the recorded WebGPU value here is `apple metal-3`), so on WebGPU `TierInput.platform` decides that case.
 */
const DESKTOP_DRIVER = /\bd3d(?:9|11|12)?\b|\bdirect3d\d*\b|\bwindows\b/i;

/**
 * Platforms that are phones or tablets, in every spelling a browser uses (`Android`, `iOS`, `iPhone`, `iPad`). Tested
 * before `DESKTOP_PLATFORM`, because Android reports `Linux armv8l` as `navigator.platform`.
 */
const MOBILE_PLATFORM = /\bandroid\b|\bios\b|\biphone\b|\bipad\b|\bipod\b/i;

/**
 * Platforms no phone or tablet runs: Windows (`Windows`, `Win32`, `Win64`; `WinCE` excluded by the digits), macOS
 * (`macOS`, `MacIntel`, `Mac OS X`, `Darwin`), Linux (`Linux`, `X11`) and ChromeOS (`Chrome OS`, `CrOS`).
 */
const DESKTOP_PLATFORM = /\bwin(?:dows|32|64)\b|\bmac(?:os|intel)?\b|\bdarwin\b|\blinux\b|\bx11\b|\bcros\b|\bchrome ?os\b/i;

/** Whether the reported platform is one no phone or tablet runs. Unknown or mobile platforms answer false. */
function isDesktopPlatform(platform: string | undefined): boolean {
  if (platform === undefined || platform === '') return false;
  return !MOBILE_PLATFORM.test(platform) && DESKTOP_PLATFORM.test(platform);
}

/**
 * A coarse device tier: budgets and later modules key off it. Signals decide in order of trust: a low-end mobile GPU
 * family (ships in no laptop), an Apple GPU with touch (an iPad, not a Mac), a desktop GPU or desktop driver string,
 * a mobile GPU family, the browser's own `mobile` answer, then touch alone. A mobile GPU family is weak (Adreno ships
 * in Windows-on-ARM laptops), so a desktop `platform` overrides it; on WebGPU the adapter string names no graphics
 * API, and `platform` is all that tells such a laptop from an Android tablet, which Chrome reports as not `mobile`.
 * Every rule lives here: `tierInputFromNavigator` only gathers the inputs.
 */
export function detectTier({ gpu = '', deviceMemory, touch = false, mobile, platform }: TierInput): Tier {
  const lowMemory = deviceMemory !== undefined && deviceMemory <= 2;
  const phone = (): Tier => (lowMemory ? 'phone-low' : 'phone-mid');
  if (LOW_END.test(gpu)) return 'phone-low';
  if (/apple/i.test(gpu) && touch) return phone();
  if (DESKTOP_GPU.test(gpu)) return 'desktop';
  if (DESKTOP_DRIVER.test(gpu)) return 'desktop';
  if (MOBILE_GPU.test(gpu)) return isDesktopPlatform(platform) ? 'desktop' : phone();
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
  /** Deprecated but still reported everywhere: `Win32`, `MacIntel`, `Linux x86_64`, `Linux armv8l` (Android), `iPhone`. */
  platform?: string;
  /** Chromium-only (User-Agent Client Hints); absent everywhere else. */
  userAgentData?: { mobile?: boolean; platform?: string };
}

/** MDN's recommended sniff for a mobile user agent string. */
const MOBILE_UA = /mobi/i;

/** Platform families as a user agent string names them, most specific first: Android's UA also says `Linux`. */
const UA_PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bandroid\b/i, 'Android'],
  [/\b(?:iphone|ipad|ipod)\b/i, 'iOS'],
  [/\bcros\b/i, 'Chrome OS'],
  [/\bwindows\b|\bwin(?:32|64)\b/i, 'Windows'],
  [/\bmac(?:intosh|intel| os x)\b/i, 'macOS'],
  [/\bx11\b|\blinux\b/i, 'Linux'],
];

/**
 * The OS the browser reports, in priority order: `userAgentData.platform` (Chromium, the only one stated rather than
 * inferred), then the user agent string, then `navigator.platform`. The user agent comes before `navigator.platform`
 * because Android reports `Linux armv8l` there while its user agent says `Android`, and reading the platform string
 * first would call an Android tablet a Linux desktop. `undefined` when nothing is reported.
 */
function platformOf(nav: TierNavigator): string | undefined {
  const stated = nav.userAgentData?.platform;
  if (stated !== undefined && stated !== '') return stated;
  const ua = nav.userAgent;
  if (ua !== undefined) for (const [pattern, name] of UA_PLATFORMS) if (pattern.test(ua)) return name;
  return nav.platform !== undefined && nav.platform !== '' ? nav.platform : undefined;
}

/**
 * Builds a `TierInput` from a GPU name and `navigator`, so `test/app/main.ts`, `cli-app/main.ts` and
 * `bench-app/runner.ts` assemble tier detection input the same way. `touch` is real touch capability
 * (`maxTouchPoints > 0`). `mobile` is `userAgentData.mobile` (Chromium; a touch-capable desktop reports `false`), else
 * a "Mobi" sniff of the user agent, else `undefined` so `detectTier` falls back to touch. `platform` is `platformOf`.
 */
export function tierInputFromNavigator(gpu: string, nav: TierNavigator): TierInput {
  const touchPoints = nav.maxTouchPoints ?? 0;
  const uaMobile = nav.userAgentData?.mobile;
  const mobile = uaMobile !== undefined ? uaMobile : nav.userAgent !== undefined ? MOBILE_UA.test(nav.userAgent) : undefined;
  return {
    gpu,
    touch: touchPoints > 0,
    mobile,
    platform: platformOf(nav),
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    dpr: (globalThis as { devicePixelRatio?: number }).devicePixelRatio,
  };
}
