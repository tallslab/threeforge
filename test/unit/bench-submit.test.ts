import { describe, expect, it } from 'vitest';
import { compact, issueBody, issueTitle, issueUrl, normalizeEnvString, resultId, toWire, URL_LIMIT } from '../../bench-app/submit.js';
import { deviceRows, liveRows } from '../../bench-app/table.js';
import { extractJson } from '../../scripts/bench-ingest.mjs';
import { validateDeviceResult } from '../../scripts/bench-schema.mjs';
import type { SceneId } from '../../test/app/benchMetrics.js';

const metrics = (n: number) => ({ sceneSubmissions: n, gpuDraws: n, triangles: 100, programs: 3, overdrawOpaque: 1.23456, overdrawTransparent: 0.1, skinnedVertices: 0, shadowCasters: 0, shadowTexels: 0, textureBytes: 1, geometryBytes: 2, renderTargetBytes: 3, particles: 100, fillMegapixels: 0.5, objects: 500, autoUpdatedMatrices: 20, shadowPassesPerFrame: 1, renderMs: 1.23456, frameMs: 16.66666, unattributed: 0 });
const ids: SceneId[] = ['village', 'forest', 'crowd', 'bossfight', 'lake', 'daynight', 'zen', 'rpg'];
const env = { three: '186', backend: 'webgpu' as const, multiDraw: false, tier: 'phone-mid' as const, gpu: 'Apple A16 GPU', dpr: 3, viewport: [390, 844] as [number, number], ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone', cores: 6, deviceMemory: null, fillRateGPix: 4.25 };
const scenes = Object.fromEntries(ids.map((id) => [id, { naive: metrics(300), optimized: metrics(30) }])) as Record<SceneId, { naive: ReturnType<typeof metrics>; optimized: ReturnType<typeof metrics> }>;
const result = { schemaVersion: 1 as const, kind: 'device' as const, id: resultId(env, new Date('2026-09-14T10:00:00Z')), createdAt: '2026-09-14T10:00:00.000Z', env, scenes };

describe('submit', () => {
  it('builds a valid, compact issue that the ingest script accepts', () => {
    expect(result.id).toMatch(/^2026-09-14-[a-z0-9]{8}$/);
    expect(resultId(env, new Date('2026-09-15T00:00:00Z'))).not.toBe(result.id);
    expect(resultId({ ...env, gpu: 'other' }, new Date('2026-09-14T10:00:00Z'))).not.toBe(result.id);
    expect(issueTitle(result)).toBe('bench: Apple A16 GPU · webgpu · phone-mid');
    const body = issueBody(result);
    const parsed = JSON.parse(extractJson(body)!);
    expect(Array.isArray(parsed.scenes.zen.naive)).toBe(true);
    expect(parsed.metricKeys).toHaveLength(20);
    const v = validateDeviceResult(parsed);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('unreachable');
    expect(v.result.scenes.zen!.naive.renderMs).toBe(1.2);
    expect(v.result.scenes.zen!.naive.overdrawOpaque).toBe(1.23);
    expect(v.result.scenes.zen!.naive.sceneSubmissions).toBe(300);
    expect(toWire(result).scenes.zen!.optimized[0]).toBe(30);
    expect(compact(result).env.fillRateGPix).toBe(4.25);
    const url = issueUrl('owner/repo', result)!;
    expect(url.startsWith('https://github.com/owner/repo/issues/new?')).toBe(true);
    expect(url.length).toBeLessThan(URL_LIMIT);
    expect(new URL(url).searchParams.get('labels')).toBe('bench-result');
    expect(new URL(url).searchParams.get('title')).toBe('bench: Apple A16 GPU · webgpu · phone-mid');
    expect(issueUrl('', result)).toBeNull();
    expect(issueUrl('not a repo', result)).toBeNull();
    const huge = { ...result, env: { ...env, ua: 'x'.repeat(200), gpu: 'y'.repeat(200), platform: 'z'.repeat(200) } };
    const long = issueUrl('owner/repo', huge);
    expect(long === null || long.length < URL_LIMIT).toBe(true);
  });
});

describe('table', () => {
  it('renders live rows with pending cells and device rows', () => {
    const live = liveRows({ village: { naive: metrics(303), optimized: metrics(28) }, forest: { naive: metrics(5706) } });
    expect(live).toContain('<td>village</td>');
    expect(live).toContain('303 → 28');
    expect(live).toContain('5706 → …');
    expect(live.match(/<tr>/g)).toHaveLength(8);
    const rows = deviceRows([result]);
    expect(rows).toContain('Apple A16 GPU');
    expect(rows).toContain('phone-mid');
    expect(rows.match(/<tr>/g)).toHaveLength(1);
    expect(deviceRows([{ ...result, env: { ...env, gpu: '<script>' } }])).toContain('&lt;script&gt;');
  });

  it('escapes createdAt and apostrophes so neither can break out of the row HTML', () => {
    const evilDate = { ...result, createdAt: '<img src=x>' };
    expect(deviceRows([evilDate])).not.toContain('<img');
    const evilGpu = { ...result, env: { ...env, gpu: "O'Brien GPU" } };
    expect(deviceRows([evilGpu])).toContain('&#39;');
  });
});

describe('normalizeEnvString', () => {
  it('maps ®/™/©, strips accents to their ASCII base, and replaces anything still outside the schema charset', () => {
    expect(normalizeEnvString('NVIDIA®')).toBe('NVIDIA(R)');
    expect(normalizeEnvString('RTX™')).toBe('RTX(TM)');
    expect(normalizeEnvString('© 2026')).toBe('(C) 2026');
    expect(normalizeEnvString('café')).toBe('cafe');
    expect(normalizeEnvString('a|b')).toBe('a?b');
    expect(normalizeEnvString('a`b')).toBe('a?b');
    expect(normalizeEnvString('a\nb')).toBe('a b');
  });

  it('normalizes env before hashing the id and validating: a real ®/™-bearing GPU string and a non-ASCII UA still validate, and the id matches', () => {
    const rawGpu = 'NVIDIA® GeForce RTX™ 4080';
    const rawUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CaféBrowser/1.0';
    const normalizedEnv = { ...env, gpu: normalizeEnvString(rawGpu), ua: normalizeEnvString(rawUa), three: normalizeEnvString(env.three), platform: normalizeEnvString(env.platform) };
    expect(normalizedEnv.gpu).toBe('NVIDIA(R) GeForce RTX(TM) 4080');
    expect(normalizedEnv.ua).not.toMatch(/[^\x00-\x7f]/);
    const now = new Date('2026-09-14T10:00:00Z');
    const id = resultId(normalizedEnv, now);
    const built = { schemaVersion: 1 as const, kind: 'device' as const, id, createdAt: now.toISOString(), env: normalizedEnv, scenes };
    const v = validateDeviceResult(built);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('unreachable');
    expect(v.result.id).toBe(id);
  });
});
