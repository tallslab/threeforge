import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KIT_ASSETS } from '../../scripts/bench-app-kits.mjs';

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

/** A GLB holding only its JSON chunk: the script reads which outside files a model points at, nothing else. */
function glb(json: object): Buffer {
  const text = JSON.stringify(json);
  const chunk = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
  const header = Buffer.alloc(20);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + chunk.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.write('JSON', 16);
  return Buffer.concat([header, chunk]);
}

const files = (dir: string) => join(dir, 'test/assets/files');
const glbPath = (kit: string, base: string) => `${kit}/Models/GLB format/${base}.glb`;
const texturePath = (kit: string, base: string) => `${kit}/PNG/${base}.png`;

/** Every kit the page needs, each model pointing at its kit's colour map, plus one model no scene asks for. */
function withKits(dir: string, leaveOut?: string): void {
  const write = (rel: string, data: string | Buffer): void => {
    mkdirSync(dirname(join(files(dir), rel)), { recursive: true });
    writeFileSync(join(files(dir), rel), data);
  };
  const index = Object.entries(KIT_ASSETS).map(([name, wanted]) => {
    const glbs = [...(wanted.glbs ?? []), 'unused'].filter((b) => b !== leaveOut).map((b) => glbPath(name, b));
    const textures = (wanted.textures ?? []).map((b) => texturePath(name, b));
    for (const rel of glbs)
      write(rel, glb({ images: [{ uri: 'Textures/colormap.png' }, { uri: 'data:image/png;base64,' }] }));
    for (const rel of textures) write(rel, 'x');
    if (glbs.length > 1) write(`${name}/Models/GLB format/Textures/colormap.png`, 'x');
    return { name, glbs, textures };
  });
  write('waternormals/waternormals.jpg', 'x');
  write('kits-index.json', JSON.stringify(index));
}

describe('bench-app-assets without the Kenney kits', () => {
  it('exits 1 and names the fetch command, so a real build never ships a page without its kits', () => {
    const dir = sandbox();
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('kits-index.json');
    expect(r.out).toContain('FORGE_KITS_ONLY=1 pnpm assets:kits');
  });

  it('degrades under FORGE_BENCH_APP_OPTIONAL=1: warns, empty kit index, exit 0', () => {
    const dir = sandbox();
    const r = run(dir, { FORGE_BENCH_APP_OPTIONAL: '1' });
    expect(r.out).toContain('FORGE_BENCH_APP_OPTIONAL');
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 'bench-app/public/kits-index.json'), 'utf8')).toBe('[]\n');
    expect(readFileSync(join(dir, 'bench-app/public/devices.json'), 'utf8')).toBe('[]\n');
    expect(existsSync(join(dir, 'bench-app/public/_decoders/draco'))).toBe(true);
    expect(existsSync(join(dir, 'bench-app/public/_decoders/basis'))).toBe(true);
  });

  it('copies what the scenes load, the files those models point at and the water map, flag or not', () => {
    for (const env of [{}, { FORGE_BENCH_APP_OPTIONAL: '1' }]) {
      const dir = sandbox();
      withKits(dir);
      const r = run(dir, env);
      expect(r.out, r.out).not.toContain('FORGE_BENCH_APP_OPTIONAL=1)');
      expect(r.status).toBe(0);
      const out = join(dir, 'bench-app/public');
      const index = JSON.parse(readFileSync(join(out, 'kits-index.json'), 'utf8')) as Array<{
        name: string;
        glbs: string[];
        textures: string[];
      }>;
      expect(index.map((kit) => kit.name)).toEqual(Object.keys(KIT_ASSETS));
      for (const kit of index) {
        const wanted = KIT_ASSETS[kit.name]!;
        expect(kit.glbs).toEqual((wanted.glbs ?? []).map((b) => glbPath(kit.name, b)));
        expect(kit.textures).toEqual((wanted.textures ?? []).map((b) => texturePath(kit.name, b)));
        for (const rel of [...kit.glbs, ...kit.textures]) expect(existsSync(join(out, rel)), rel).toBe(true);
      }
      expect(existsSync(join(out, 'kenney-mini-arena/Models/GLB format/Textures/colormap.png'))).toBe(true);
      expect(existsSync(join(out, glbPath('kenney-mini-arena', 'unused')))).toBe(false);
      expect(existsSync(join(out, 'waternormals/waternormals.jpg'))).toBe(true);
    }
  });

  it('exits 1 naming a model a scene loads that the kit no longer has', () => {
    const dir = sandbox();
    withKits(dir, 'weapon-spear');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('weapon-spear is not in the kenney-mini-arena kit');
  });
});
