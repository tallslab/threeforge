import type { DeviceResult } from './bench-schema.mjs';
export function sortResults(results: DeviceResult[]): DeviceResult[];
export function renderDevices(results: DeviceResult[]): string;
export function readResults(dir: string): DeviceResult[];
export function writeDevices(dir: string, docsPath: string): number;
