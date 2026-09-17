import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadFailures, strictExitCode } from '../../scripts/fetch-strict.mjs';

/**
 * `fetch-assets.mjs` and `fetch-kits.mjs` record a failed download as `{ name, error }` and exit 0, which keeps a
 * developer on a flaky connection working. In CI that turned a network failure into something else entirely: a
 * corpus run with fewer assets, or a bench scene reporting `kenney-mini-characters kit not found` two steps later,
 * which reads as a threeforge defect. FORGE_FETCH_STRICT=1 makes the fetch step itself fail, naming what failed.
 */
describe('downloadFailures', () => {
  it('names every entry that records an error, in index order, and nothing else', () => {
    const index = [
      { name: 'Fox', entry: 'Fox/Fox.glb' },
      { name: 'Buggy', error: '404 https://x/Buggy.glb' },
      { name: 'kenney-car-kit', kind: 'kit', error: '503' },
    ];
    expect(downloadFailures(index)).toEqual(['Buggy: 404 https://x/Buggy.glb', 'kenney-car-kit: 503']);
  });

  it('is empty for a clean index and tolerates malformed rows', () => {
    expect(downloadFailures([{ name: 'Fox' }])).toEqual([]);
    expect(downloadFailures([null, 7, { error: 'no name' }, { name: 'A', error: '' }] as unknown[])).toEqual([
      '(unnamed): no name',
      'A: (no message)',
    ]);
  });
});

describe('strictExitCode', () => {
  const failed = [{ name: 'Buggy', error: '404' }];

  it('stays 0 without FORGE_FETCH_STRICT, whatever failed', () => {
    // Local pnpm assets keeps working offline.
    const lines: string[] = [];
    expect(strictExitCode(failed, {}, (l) => lines.push(l))).toBe(0);
    expect(strictExitCode(failed, { FORGE_FETCH_STRICT: '0' }, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });

  it('is 1 under FORGE_FETCH_STRICT=1 when anything failed, and says what', () => {
    const lines: string[] = [];
    expect(strictExitCode(failed, { FORGE_FETCH_STRICT: '1' }, (l) => lines.push(l))).toBe(1);
    expect(lines.join('\n')).toContain('Buggy: 404');
    expect(lines.join('\n')).toContain('FORGE_FETCH_STRICT=1');
  });

  it('is 0 under FORGE_FETCH_STRICT=1 when nothing failed', () => {
    expect(strictExitCode([{ name: 'Fox' }], { FORGE_FETCH_STRICT: '1' }, () => {})).toBe(0);
  });
});

describe('fetch-assets.mjs, run for real against a port nothing listens on', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A port that was free a moment ago: nothing answers, so the fetch fails locally and fast, with no network. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }

  async function sandbox(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'forge-fetch-strict-'));
    made.push(dir);
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    mkdirSync(join(dir, 'test/assets'), { recursive: true });
    const url = `http://127.0.0.1:${await closedPort()}/Nope/Nope.glb`;
    writeFileSync(
      join(dir, 'test/assets/manifest.json'),
      JSON.stringify({ assets: [{ name: 'Nope', url, source: 'test', tags: [] }] }),
    );
    return dir;
  }

  function run(cwd: string, env: NodeJS.ProcessEnv): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [resolve('scripts/fetch-assets.mjs')], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('exits 0 by default and records the failure in the index', async () => {
    const dir = await sandbox();
    const r = run(dir, { FORGE_FETCH_STRICT: '' });
    expect(r.status, r.out).toBe(0);
    const index = JSON.parse(readFileSync(join(dir, 'test/assets/files/index.json'), 'utf8')) as Array<{
      name: string;
      entry: string;
      error?: string;
    }>;
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ name: 'Nope', entry: 'Nope/Nope.glb' });
    expect(index[0]?.error).toBeTruthy();
  });

  it('exits 1 under FORGE_FETCH_STRICT=1, naming the asset, and still writes the index', async () => {
    const dir = await sandbox();
    const r = run(dir, { FORGE_FETCH_STRICT: '1' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/download failed[\s\S]*Nope: /);
    expect(JSON.parse(readFileSync(join(dir, 'test/assets/files/index.json'), 'utf8'))).toHaveLength(1);
  });
});
