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
}

const MB = 1024 * 1024;

export const BUDGETS: Record<Tier, Budgets> = {
  desktop: { sceneSubmissions: 400, triangles: 5_000_000, transparentOverdraw: 3, skinnedVertices: 400_000, shadowTexels: 4 * MB, textureBytes: 512 * MB, frameMs: 16.6, particles: 60_000 },
  'phone-mid': { sceneSubmissions: 150, triangles: 1_500_000, transparentOverdraw: 2, skinnedVertices: 150_000, shadowTexels: 1 * MB, textureBytes: 192 * MB, frameMs: 16.6, particles: 15_000 },
  'phone-low': { sceneSubmissions: 80, triangles: 500_000, transparentOverdraw: 1.5, skinnedVertices: 60_000, shadowTexels: 262_144, textureBytes: 96 * MB, frameMs: 33, particles: 5_000 },
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

/** Low-end mobile GPUs: Adreno 1xx–5xx and 60x–63x, Mali-G1x–G5x, Mali-T/4xx, PowerVR, VideoCore. */
const LOW_END = /adreno[^0-9]*(?:[1-5]\d\d|6[0-3]\d)\b|mali-g[1-5]\d\b|mali-t|mali-4|powervr|videocore/i;

/** A coarse device tier: budgets and later modules key off it. No touch means desktop. */
export function detectTier({ gpu = '', deviceMemory, touch = false }: TierInput): Tier {
  if (!touch) return 'desktop';
  if (LOW_END.test(gpu)) return 'phone-low';
  if (deviceMemory !== undefined && deviceMemory <= 2) return 'phone-low';
  return 'phone-mid';
}
