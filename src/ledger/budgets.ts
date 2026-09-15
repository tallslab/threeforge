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
 */
const MOBILE_GPU = /\badreno\b|\bmali\b|\bpowervr\b|\bxclipse\b|\bqualcomm\b|\bapple a\d/i;

/** Discrete/desktop GPUs and software rasterizers: decisive regardless of touch. Bounded so e.g. "Intelligent Renderer" or "Malibu GPU" cannot false-match. */
const DESKTOP_GPU = /\bnvidia\b|\bgeforce\b|\bradeon\b|\bamd\b|\bintel\b|\biris\b|\barc\b|\bapple m\d|\bswiftshader\b/i;

/**
 * A coarse device tier: budgets and later modules key off it.
 *
 * GPU-first decision order, so a touch-capable desktop (a Windows laptop with a discrete GPU and a
 * touchscreen) is not mistaken for a phone. All six steps live here (Ruling R56 — `tierInputFromNavigator`
 * only resolves `mobile`/`touch`, it does not itself decide a tier), so `detectTier` never disagrees with
 * what the helper feeds it:
 *   1. `LOW_END` matches -> `phone-low`.
 *   2. `MOBILE_GPU` matches -> `phone-mid` (whatever `touch`/`mobile` say), or `phone-low` when
 *      `deviceMemory <= 2` (Ruling R57).
 *   3. `DESKTOP_GPU` matches -> `desktop`, whatever `touch`/`mobile` say.
 *   4. A bare "Apple" (iPad Safari reports only this) with `touch` -> `phone-mid`, or `phone-low` under
 *      `deviceMemory <= 2` (Ruling R57).
 *   5. `mobile`, when defined (set by `tierInputFromNavigator` from `userAgentData.mobile` or a user agent
 *      sniff): `true` -> `phone-mid` (or `phone-low` under `deviceMemory <= 2`, Ruling R57); `false` ->
 *      `desktop`. Decides before step 6, for a GPU string steps 1-4 did not recognise.
 *   6. Otherwise (`mobile` is `undefined`) the old touch-only rule: no `touch` -> `desktop`; `touch` and
 *      `deviceMemory <= 2` -> `phone-low`; `touch` otherwise -> `phone-mid`.
 */
export function detectTier({ gpu = '', deviceMemory, touch = false, mobile }: TierInput): Tier {
  const lowMemory = deviceMemory !== undefined && deviceMemory <= 2;
  if (LOW_END.test(gpu)) return 'phone-low';
  if (MOBILE_GPU.test(gpu)) return lowMemory ? 'phone-low' : 'phone-mid';
  if (DESKTOP_GPU.test(gpu)) return 'desktop';
  if (/apple/i.test(gpu) && touch) return lowMemory ? 'phone-low' : 'phone-mid';
  if (mobile !== undefined) return mobile ? (lowMemory ? 'phone-low' : 'phone-mid') : 'desktop';
  if (!touch) return 'desktop';
  return lowMemory ? 'phone-low' : 'phone-mid';
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
