import type { DeviceResult } from './bench-schema.mjs';
export function extractJson(body: string): string | null;
export function ingest(body: string, dir: string): { path: string; result: DeviceResult };
