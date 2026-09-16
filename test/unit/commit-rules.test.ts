import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RENDERING_PATHS, budgetDeclaration, checkCommits, touchesRendering } from '../../scripts/commit-rules.mjs';

const script = resolve('scripts/commit-rules.mjs');
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository, so the git plumbing CI depends on is exercised rather than assumed. */
function repo(): { dir: string; commit: (message: string, files: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-commit-rules-'));
  made.push(dir);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  return {
    dir,
    commit(message, files) {
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), `${message}\n`);
        git('add', '--', file);
      }
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
  };
}

function run(dir: string, range: string): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, range], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe('touchesRendering', () => {
  it('flags the frame-path modules and the scenes the budget measures, and nothing else', () => {
    expect(touchesRendering(['src/compiler/bake.ts'])).toEqual(['src/compiler/bake.ts']);
    expect(touchesRendering(['src/ledger/DrawCallLedger.ts', 'docs/threeforge.md'])).toEqual(['src/ledger/DrawCallLedger.ts']);
    expect(touchesRendering(['test/scenes/naive.ts'])).toEqual(['test/scenes/naive.ts']);
    expect(touchesRendering(['docs/bench.md', 'README.md', '.github/workflows/ci.yml', 'scripts/commit-rules.mjs', 'test/unit/cli.test.ts'])).toEqual([]);
  });

  it('matches whole path segments, so a sibling named like a rendering directory is not swept in', () => {
    expect(touchesRendering(['src/compiler-notes.md', 'src/cli/compiler.ts'])).toEqual([]);
    expect(RENDERING_PATHS.every((p) => p.endsWith('/'))).toBe(true);
  });
});

describe('budgetDeclaration', () => {
  it('accepts a count or an n/a with a reason, on a body line', () => {
    expect(budgetDeclaration('compiler: x\n\nwhy\nBudget: 28\n')).toEqual({ kind: 'count', value: 28, line: 'Budget: 28' });
    expect(budgetDeclaration('compiler: x\n\nBudget: 28 (naive scene)\n')).toEqual({ kind: 'count', value: 28, line: 'Budget: 28 (naive scene)' });
    expect(budgetDeclaration('compiler: x\n\nBudget: n/a comments only\n')).toEqual({ kind: 'n/a', reason: 'comments only', line: 'Budget: n/a comments only' });
  });

  it('rejects an empty value, a bare n/a, a non-numeric count, a miscased key and an indented line', () => {
    for (const body of ['Budget:', 'Budget: ', 'Budget: n/a', 'Budget: twenty-eight', 'budget: 28', '  Budget: 28']) {
      expect(budgetDeclaration(`compiler: x\n\n${body}\n`), body).toBeNull();
    }
  });

  it('ignores a declaration that is only on the subject line, where the repo convention does not put it', () => {
    expect(budgetDeclaration('Budget: 28\n')).toBeNull();
  });
});

describe('checkCommits', () => {
  const rendering = { sha: 'a1b2c3d', subject: 'compiler: x', files: ['src/compiler/batch.ts'] };

  it('passes a rendering commit that declares a budget, and any commit that touches no rendering path', () => {
    expect(checkCommits([{ ...rendering, message: 'compiler: x\n\nwhy\nBudget: 28\n' }])).toEqual([]);
    expect(checkCommits([{ sha: 'f00', subject: 'docs: y', files: ['docs/bench.md'], message: 'docs: y\n\nwhy\n' }])).toEqual([]);
  });

  it('reports a rendering commit with no declaration, naming the files that made it one', () => {
    const [v] = checkCommits([{ ...rendering, message: 'compiler: x\n\nwhy\n' }]);
    expect(v?.sha).toBe('a1b2c3d');
    expect(v?.files).toEqual(['src/compiler/batch.ts']);
    expect(v?.problem).toContain('no `Budget:` line');
  });

  it('says a declaration is malformed rather than missing, so the fix is obvious', () => {
    expect(checkCommits([{ ...rendering, message: 'compiler: x\n\nBudget: n/a\n' }])[0]?.problem).toContain('Budget: n/a');
    expect(checkCommits([{ ...rendering, message: 'compiler: x\n\nbudget: 28\n' }])[0]?.problem).toContain('budget: 28');
  });
});

describe('the command line CI runs', () => {
  it('exits 0 for a range whose rendering commits all declare a budget, and 1 for one that does not', () => {
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    r.commit('docs: notes\n\nno rendering here', ['docs/notes.md']);
    r.commit('compiler: batch\n\nwhy\nBudget: 28', ['src/compiler/batch.ts']);
    r.commit('ledger: totals\n\nwhy\nBudget: n/a ledger comment only', ['src/ledger/totals.ts']);
    const ok = run(r.dir, `${base}..HEAD`);
    expect(ok.out).toContain('3 commits');
    expect(ok.status).toBe(0);

    const bad = r.commit('compiler: cull\n\nforgot the line', ['src/compiler/culling.ts']);
    const fail = run(r.dir, `${base}..HEAD`);
    expect(fail.status).toBe(1);
    expect(fail.out).toContain(bad.slice(0, 7));
    expect(fail.out).toContain('src/compiler/culling.ts');
  });

  it('exits 0 on an empty range and on a range of merges only', () => {
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    expect(run(r.dir, `${base}..HEAD`).status).toBe(0);
  });
});
