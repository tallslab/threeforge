export interface DeviceMetrics {
  sceneSubmissions: number;
  gpuDraws: number;
  triangles: number;
  programs: number;
  overdrawOpaque: number;
  overdrawTransparent: number;
  skinnedVertices: number;
  shadowCasters: number;
  shadowTexels: number;
  textureBytes: number;
  geometryBytes: number;
  renderTargetBytes: number;
  renderMs: number;
  frameMs: number;
  unattributed: number;
}
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
export const METRIC_KEYS: readonly string[];
export const ENV_KEYS: readonly string[];
export function validateDeviceResult(value: unknown): { ok: true; result: DeviceResult } | { ok: false; errors: string[] };
export function expandWire(value: unknown): { value: unknown; error?: undefined } | { error: string; value?: undefined };
