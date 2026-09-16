import type { BenchMetrics } from '../test/app/benchMetrics.js';

/** A device result carries exactly a `pnpm bench` result's metrics. */
export type DeviceMetrics = BenchMetrics;
export interface DeviceEnv {
  three: string;
  backend: 'webgl2' | 'webgpu';
  multiDraw: boolean;
  tier: 'desktop' | 'phone-mid' | 'phone-low';
  gpu: string;
  dpr: number;
  viewport: [number, number];
  ua: string;
  platform: string;
  cores: number | null;
  deviceMemory: number | null;
  fillRateGPix: number | null;
}
export interface DeviceResult {
  schemaVersion: 1;
  kind: 'device';
  id: string;
  createdAt: string;
  env: DeviceEnv;
  scenes: Record<string, { naive: DeviceMetrics; optimized: DeviceMetrics }>;
}
export const SCENE_IDS: readonly string[];
export const METRIC_KEYS: ReadonlyArray<keyof BenchMetrics>;
export const ENV_KEYS: readonly string[];
export function validateDeviceResult(value: unknown): { ok: true; result: DeviceResult } | { ok: false; errors: string[] };
export function expandWire(value: unknown): { value: unknown; error?: undefined } | { error: string; value?: undefined };
