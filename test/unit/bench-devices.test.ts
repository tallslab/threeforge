import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDevices, writeDevices } from '../../scripts/bench-devices.mjs';
import { extractJson, ingest } from '../../scripts/bench-ingest.mjs';
import { validateDeviceResult } from '../../scripts/bench-schema.mjs';

const metrics = (n: number) => ({ sceneSubmissions: n, gpuDraws: n, triangles: 100, programs: 3, overdrawOpaque: 1, overdrawTransparent: 0.1, skinnedVertices: 0, shadowCasters: 0, shadowTexels: 0, textureBytes: 1, geometryBytes: 2, renderTargetBytes: 3, particles: 100, fillMegapixels: 0.5, objects: 500, autoUpdatedMatrices: 20, shadowPassesPerFrame: 1, renderMs: 1.5, frameMs: 16.7, unattributed: 0 });
const scenes = Object.fromEntries(['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'].map((id) => [id, { naive: metrics(300), optimized: metrics(30) }]));
const env = { three: '186', backend: 'webgpu' as const, multiDraw: false, tier: 'phone-mid' as const, gpu: 'Apple A16', dpr: 3, viewport: [390, 844] as [number, number], ua: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', cores: 6, deviceMemory: null, fillRateGPix: 4.2 };
const result = { schemaVersion: 1 as const, kind: 'device' as const, id: '2026-09-14-abcd1234', createdAt: '2026-09-14T10:00:00.000Z', env, scenes };

describe('validateDeviceResult', () => {
  it('accepts a complete result and rejects each kind of damage', () => {
    expect(validateDeviceResult(result)).toEqual({ ok: true, result });
    const bad = (mutate: (r: Record<string, any>) => void): string[] => {
      const r = JSON.parse(JSON.stringify(result));
      mutate(r);
      const v = validateDeviceResult(r);
      return v.ok ? [] : v.errors;
    };
    expect(bad((r) => delete r.scenes.zen)).toEqual([expect.stringContaining('zen')]);
    expect(bad((r) => (r.scenes.moon = r.scenes.zen))).toEqual([expect.stringContaining('moon')]);
    expect(bad((r) => (r.scenes.zen.naive.triangles = -1))).toEqual([expect.stringContaining('triangles')]);
    expect(bad((r) => (r.scenes.zen.naive.unattributed = 1))).toEqual([expect.stringContaining('unattributed')]);
    expect(bad((r) => (r.env.gpu = 'x'.repeat(201)))).toEqual([expect.stringContaining('gpu')]);
    expect(bad((r) => (r.env.extra = 1))).toEqual([expect.stringContaining('extra')]);
    expect(bad((r) => (r.id = '../etc'))).toEqual([expect.stringContaining('id')]);
    expect(validateDeviceResult('nope').ok).toBe(false);
  });

  it('expands the wire form (metric arrays in metricKeys order) before validating', () => {
    const keys = Object.keys(metrics(1));
    const wire = { ...result, metricKeys: keys, scenes: Object.fromEntries(Object.entries(scenes).map(([id, b]) => [id, { naive: keys.map((k) => (b.naive as Record<string, number>)[k]), optimized: keys.map((k) => (b.optimized as Record<string, number>)[k]) }])) };
    expect(validateDeviceResult(wire)).toEqual({ ok: true, result });
    expect(validateDeviceResult({ ...wire, metricKeys: keys.slice(1) }).ok).toBe(false);
    expect(validateDeviceResult({ ...wire, scenes: { ...wire.scenes, zen: { naive: [1, 2], optimized: wire.scenes.zen!.optimized } } }).ok).toBe(false);
  });
});

describe('ingest', () => {
  it('extracts the JSON fence from an issue body and writes the file by id', () => {
    const body = `Device bench result.\n\n<details>\n\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\n</details>\nthanks`;
    expect(JSON.parse(extractJson(body)!)).toEqual(result);
    expect(extractJson('no fence here')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'forge-devices-'));
    try {
      const out = ingest(body, dir);
      expect(out.path).toBe(join(dir, '2026-09-14-abcd1234.json'));
      expect(JSON.parse(readFileSync(out.path, 'utf8')).env.gpu).toBe('Apple A16');
      expect(() => ingest('```json\n{"schemaVersion":1}\n```', dir)).toThrow(/kind|scenes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderDevices', () => {
  it('renders one row per result, low tier first, newest first within a device', () => {
    const desktop = { ...result, id: '2026-09-13-desk0001', createdAt: '2026-09-13T10:00:00.000Z', env: { ...env, tier: 'desktop' as const, gpu: 'apple metal-3', backend: 'webgpu' as const } };
    const md = renderDevices([desktop, result]);
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| device'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Apple A16');
    expect(rows[0]).toContain('300 → 30');
    expect(rows[1]).toContain('apple metal-3');
    const dir = mkdtempSync(join(tmpdir(), 'forge-devices-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(result));
      const docs = join(dir, 'devices.md');
      writeDevices(dir, docs);
      expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))).toHaveLength(1);
      expect(readFileSync(docs, 'utf8')).toContain('Apple A16');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
