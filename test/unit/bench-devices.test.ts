import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readResults, renderDevices, writeDevices } from '../../scripts/bench-devices.mjs';
import { extractJson, ingest } from '../../scripts/bench-ingest.mjs';
import { computeResultId } from '../../scripts/bench-id.mjs';
import { validateDeviceResult } from '../../scripts/bench-schema.mjs';

const metrics = (n: number) => ({ sceneSubmissions: n, gpuDraws: n, triangles: 100, programs: 3, overdrawOpaque: 1, overdrawTransparent: 0.1, skinnedVertices: 0, shadowCasters: 0, shadowTexels: 0, textureBytes: 1, geometryBytes: 2, renderTargetBytes: 3, particles: 100, fillMegapixels: 0.5, objects: 500, autoUpdatedMatrices: 20, shadowPassesPerFrame: 1, renderMs: 1.5, frameMs: 16.7, unattributed: 0 });
const scenes = Object.fromEntries(['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'].map((id) => [id, { naive: metrics(300), optimized: metrics(30) }]));
const env = { three: '186', backend: 'webgpu' as const, multiDraw: false, tier: 'phone-mid' as const, gpu: 'Apple A16', dpr: 3, viewport: [390, 844] as [number, number], ua: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', cores: 6, deviceMemory: null, fillRateGPix: 4.2 };
const createdAt = '2026-09-14T10:00:00.000Z';
const result = { schemaVersion: 1 as const, kind: 'device' as const, id: computeResultId(env, createdAt.slice(0, 10)), createdAt, env, scenes };

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

  it('rejects a createdAt that smuggles markup (must be strict ISO, not just Date.parse-able)', () => {
    const r = JSON.parse(JSON.stringify(result));
    r.createdAt = "<img src='2026-09-14";
    const v = validateDeviceResult(r);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.errors).toEqual([expect.stringContaining('createdAt')]);
  });

  it('rejects an id whose date or hash does not match createdAt/env, independent of other damage', () => {
    const bad = (mutate: (r: Record<string, any>) => void): string[] => {
      const r = JSON.parse(JSON.stringify(result));
      mutate(r);
      const v = validateDeviceResult(r);
      return v.ok ? [] : v.errors;
    };
    // Right shape, wrong date/hash.
    expect(bad((r) => (r.id = `${r.createdAt.slice(0, 10)}-00000000`))).toEqual([expect.stringContaining('id')]);
    // env changed without recomputing id: the id no longer matches its own env.
    expect(bad((r) => (r.env.gpu = 'Different GPU'))).toEqual([expect.stringContaining('id')]);
  });

  it('rejects env.gpu containing a newline, a pipe or a backtick (printable ASCII only)', () => {
    const bad = (mutate: (r: Record<string, any>) => void): string[] => {
      const r = JSON.parse(JSON.stringify(result));
      mutate(r);
      const v = validateDeviceResult(r);
      return v.ok ? [] : v.errors;
    };
    expect(bad((r) => (r.env.gpu = 'Bad\nGPU'))).toEqual([expect.stringContaining('gpu')]);
    expect(bad((r) => (r.env.gpu = 'Bad|GPU'))).toEqual([expect.stringContaining('gpu')]);
    expect(bad((r) => (r.env.gpu = 'Bad`GPU'))).toEqual([expect.stringContaining('gpu')]);
  });

  it('accepts realistic GPU renderer strings and browser UAs (parentheses, semicolons, commas, slashes)', () => {
    const r = JSON.parse(JSON.stringify(result));
    r.env.gpu = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
    r.env.ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    r.id = computeResultId(r.env, r.createdAt.slice(0, 10));
    expect(validateDeviceResult(r)).toEqual({ ok: true, result: r });
  });

  it('rejects a wire scenes block that uses __proto__ as a scene id, with a missing-scene error and no prototype pollution', () => {
    const keys = Object.keys(metrics(1));
    const withoutZen = Object.fromEntries(
      Object.entries(scenes)
        .filter(([id]) => id !== 'zen')
        .map(([id, b]) => [id, { naive: keys.map((k) => (b.naive as Record<string, number>)[k]), optimized: keys.map((k) => (b.optimized as Record<string, number>)[k]) }]),
    );
    const payload = { ...result, metricKeys: keys, scenes: withoutZen };
    // Shaped so that pre-fix code (bracket-assigning a scene id onto a fresh `{}`) hijacks the *actual* prototype
    // of the built scenes object to `{ zen: <expanded metrics> }`: `'zen' in scenes` then reports true via
    // inheritance (the missing-scene check is fooled) even though those metrics were never themselves validated
    // (a plain `Object.entries` loop only walks own properties, so `zen` silently skips every numeric check).
    // Building with `Object.create(null)` instead makes the assignment an ordinary property, so `__proto__` shows
    // up as an unknown key and `zen` is correctly reported missing.
    const protoBlock = JSON.stringify({ zen: keys.map(() => 1) });
    // Built the way a real issue body would arrive: JSON.parse of text containing a literal "__proto__" key.
    // JSON.parse defines it as an ordinary own property (it does not touch the object's actual prototype) — the
    // vulnerability is downstream code that re-assigns such a key onto a *fresh* `{}` via bracket notation.
    const poisoned = JSON.stringify(payload).replace('"scenes":{', `"scenes":{"__proto__":${protoBlock},`);
    const wire = JSON.parse(poisoned);
    expect(Object.prototype.hasOwnProperty.call(wire.scenes, '__proto__')).toBe(true);

    const v = validateDeviceResult(wire);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.errors.some((e) => e.includes('zen') && e.includes('missing'))).toBe(true);
    // The real Object.prototype must never have been touched.
    expect((Object.prototype as Record<string, unknown>).zen).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
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
      expect(out.path).toBe(join(dir, `${result.id}.json`));
      expect(JSON.parse(readFileSync(out.path, 'utf8')).env.gpu).toBe('Apple A16');
      expect(() => ingest('```json\n{"schemaVersion":1}\n```', dir)).toThrow(/kind|scenes/);
      // A second submission for the same device+day must never overwrite the first.
      expect(() => ingest(body, dir)).toThrow(/exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extractJson scans linearly (no catastrophic backtracking) and caps the body size', () => {
    const start = performance.now();
    expect(extractJson('```json' + ' \n'.repeat(2000))).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
    expect(() => extractJson('x'.repeat(65537))).toThrow(/65536/);
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

  it('escapes | and newlines in device/platform strings so a malicious value cannot break the table', () => {
    const evil = { ...result, env: { ...env, gpu: 'Bad | GPU\nInjected row', platform: 'Plat|form' } };
    const md = renderDevices([evil]);
    // A raw newline in a cell would start a new, unescaped Markdown line; a raw `|` would look like a cell
    // boundary to a Markdown table renderer. Neither may happen: still exactly one data row, and every `|` that
    // came from a result value (not a column separator) is backslash-escaped.
    const dataRows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| device'));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).toContain('Bad \\| GPU Injected row');
    expect(dataRows[0]).toContain('Plat\\|form');
  });
});

describe('readResults', () => {
  it('throws on an invalid file and names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-devices-'));
    try {
      writeFileSync(join(dir, 'good.json'), JSON.stringify(result));
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...result, schemaVersion: 2 }));
      expect(() => readResults(dir)).toThrow(/bad\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
