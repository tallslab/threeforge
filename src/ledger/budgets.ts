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
  touch?: boolean;
  dpr?: number;
}

/** Low-end mobile GPUs: Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR SGX, VideoCore. */
const LOW_END = /adreno[^0-9]*(?:[1-5]\d\d|6[0-3]\d)\b|mali-g[1-5]\d\b|mali-t|mali-4|sgx|videocore/i;

/** Mobile/tablet GPUs not already caught by LOW_END: higher-end Adreno/Mali, PowerVR, VideoCore, Xclipse, Qualcomm, Apple A-series. */
const MOBILE_GPU = /adreno|mali|powervr|videocore|xclipse|qualcomm|apple a\d/i;

/** Discrete/desktop GPUs and software rasterizers: decisive regardless of touch. */
const DESKTOP_GPU = /nvidia|geforce|radeon|\bamd\b|intel|iris|\barc\b|apple m\d|swiftshader/i;

/**
 * A coarse device tier: budgets and later modules key off it.
 *
 * GPU-first decision order, so a touch-capable desktop (a Windows laptop with a discrete GPU and a
 * touchscreen) is not mistaken for a phone:
 *   1. `LOW_END` matches -> `phone-low`.
 *   2. `MOBILE_GPU` matches -> `phone-mid` (a recognised mobile/tablet GPU, whatever `touch` says).
 *   3. `DESKTOP_GPU` matches -> `desktop`, whatever `touch` says.
 *   4. A bare "Apple" (iPad Safari reports only this) with `touch` -> `phone-mid`.
 *   5. Otherwise the GPU string is unrecognised: `touch` (as resolved by `tierInputFromNavigator`,
 *      which prefers `userAgentData.mobile` or the user agent string over raw touch-point presence)
 *      decides -> no touch is `desktop`; touch and `deviceMemory <= 2` is `phone-low`, else `phone-mid`.
 */
export function detectTier({ gpu = '', deviceMemory, touch = false }: TierInput): Tier {
  if (LOW_END.test(gpu)) return 'phone-low';
  if (MOBILE_GPU.test(gpu)) return 'phone-mid';
  if (DESKTOP_GPU.test(gpu)) return 'desktop';
  if (/apple/i.test(gpu) && touch) return 'phone-mid';
  if (!touch) return 'desktop';
  return deviceMemory !== undefined && deviceMemory <= 2 ? 'phone-low' : 'phone-mid';
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
 * `touch` prefers, in order: `userAgentData.mobile` (Chromium, most reliable — a touch-capable desktop
 * reports `false`), then a "Mobi" sniff of the user agent string (non-Chromium browsers), then the old
 * `maxTouchPoints > 0` rule as a last resort when neither is available.
 */
export function tierInputFromNavigator(gpu: string, nav: TierNavigator): TierInput {
  const touchPoints = nav.maxTouchPoints ?? 0;
  const uaMobile = nav.userAgentData?.mobile;
  const touch = uaMobile !== undefined ? uaMobile : nav.userAgent !== undefined ? MOBILE_UA.test(nav.userAgent) : touchPoints > 0;
  return {
    gpu,
    touch,
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    dpr: (globalThis as { devicePixelRatio?: number }).devicePixelRatio,
  };
}
