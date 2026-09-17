import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/bench-app-assets.mjs` fills the device bench page's public dir. Playwright runs it as the port-5180
 * `webServer` command, and a `webServer` that exits non-zero fails the *whole* Playwright run, not one spec — so on
 * a runner without the Kenney kits this script used to take the entire e2e suite down with it.
 * `FORGE_BENCH_APP_OPTIONAL=1` is the opt-in that lets it degrade instead; `pnpm build:bench-app` (the Pages
 * deploy) and `pnpm bench:app` never set it, so a real build still fails loudly.
 */
const script = resolve('scripts/bench-app-assets.mjs');
const nodeModules = resolve('node_modules');
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-bench-app-assets-'));
  made.push(dir);
  symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(cwd: string, env: NodeJS.ProcessEnv = {}): { status: number; out: string } {
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

/** The kit layout the script expects, with placeholder bytes: it only copies these files, never parses them. */
function withKits(dir: string): void {
  const glbs = ['male-a', 'male-b', 'male-c', 'male-d', 'female-a', 'female-b', 'female-c', 'female-d'].map((n) => `kenney-mini-characters/Models/GLB format/character-${n}.glb`);
  for (const rel of [...glbs, 'waternormals/waternormals.jpg']) {
    mkdirSync(dirname(join(dir, 'test/assets/files', rel)), { recursive: true });
    writeFileSync(join(dir, 'test/assets/files', rel), 'x');
  }
  writeFileSync(join(dir, 'test/assets/files/kits-index.json'), JSON.stringify([{ name: 'kenney-mini-characters', glbs, textures: [] }]));
}

describe('bench-app-assets without the Kenney kits', () => {
  it('exits 1 and names the fetch command, so a real build never ships a page with no characters', () => {
    const dir = sandbox();
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('kits-index.json');
    expect(r.out).toContain('FORGE_KITS_ONLY=1 pnpm assets:kits');
  });

  it('degrades under FORGE_BENCH_APP_OPTIONAL=1: warns, writes an empty kit index, still writes decoders, exits 0', () => {
    const dir = sandbox();
    const r = run(dir, { FORGE_BENCH_APP_OPTIONAL: '1' });
    expect(r.out).toContain('FORGE_BENCH_APP_OPTIONAL');
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'bench-app/public/kits-index.json'), 'utf8')).toBe('[]\n');
    expect(readFileSync(join(dir, 'bench-app/public/devices.json'), 'utf8')).toBe('[]\n');
    expect(existsSync(join(dir, 'bench-app/public/_decoders/draco'))).toBe(true);
    expect(existsSync(join(dir, 'bench-app/public/_decoders/basis'))).toBe(true);
  });

  it('does not degrade when the kits are there, flag or no flag: the eight characters and the water map are copied', () => {
    for (const env of [{}, { FORGE_BENCH_APP_OPTIONAL: '1' }]) {
      const dir = sandbox();
      withKits(dir);
      const r = run(dir, env);
      expect(r.out, r.out).not.toContain('FORGE_BENCH_APP_OPTIONAL=1)');
      expect(r.status).toBe(0);
      const index = JSON.parse(readFileSync(join(dir, 'bench-app/public/kits-index.json'), 'utf8')) as Array<{ glbs: string[] }>;
      expect(index[0]?.glbs).toHaveLength(8);
      expect(existsSync(join(dir, 'bench-app/public/waternormals/waternormals.jpg'))).toBe(true);
      expect(existsSync(join(dir, 'bench-app/public/kenney-mini-characters/Models/GLB format/character-male-a.glb'))).toBe(true);
    }
  });
});
