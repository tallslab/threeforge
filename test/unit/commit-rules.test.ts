import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXCLUDED_PATHS, EXEMPT_COMMITS, RENDERING_PATHS, budgetDeclaration, checkCommits, main, touchesRendering } from '../../scripts/commit-rules.mjs';

const script = resolve('scripts/commit-rules.mjs');
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository, so the git plumbing CI depends on is exercised rather than assumed. */
function repo(): { dir: string; git: (...args: string[]) => string; commit: (message: string, files: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-commit-rules-'));
  made.push(dir);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  return {
    dir,
    git,
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

/**
 * `main()` in-process with an allow-list of this test's own choosing. The exemption is deliberately *not* reachable
 * from the environment or the command line — a guard whose bypass is one env var away is not a guard — so injecting
 * the list here is the only way to exercise the reporting path on a throwaway repository's SHAs.
 */
function mainIn(dir: string, range: string, exempt?: Record<string, { date: string; reason: string }>): { status: number; out: string } {
  const lines: string[] = [];
  const write = (...parts: unknown[]): void => void lines.push(parts.join(' '));
  const out = vi.spyOn(console, 'log').mockImplementation(write);
  const err = vi.spyOn(console, 'error').mockImplementation(write);
  try {
    return { status: main([range], dir, exempt), out: lines.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
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
  });

  it('matches a listed file exactly: src/tags.ts decides what batches, and a bare file has no directory to prefix', () => {
    expect(touchesRendering(['src/tags.ts'])).toEqual(['src/tags.ts']);
    expect(touchesRendering(['src/tags.tsx', 'src/tags.ts.orig', 'src/tags.ts/x'])).toEqual([]);
    expect(touchesRendering(['src/character/assembleCharacter.ts'])).toEqual(['src/character/assembleCharacter.ts']);
  });

  it('leaves the excluded entries out, the DOM overlay among them', () => {
    expect(touchesRendering(['src/overlay/index.ts', 'src/agent/expose.ts', 'src/cli/index.ts', 'src/index.ts', 'src/version.ts'])).toEqual([]);
  });
});

/**
 * The boundary has to be complete, not just plausible. A new `src/<thing>` that is in neither list would escape the
 * rule silently — the way `src/tags.ts` and `src/character/` did — so this enumerates `src/` and fails on it.
 */
describe('every top-level entry of src/ is classified', () => {
  const classified = (): string[] => [...RENDERING_PATHS, ...Object.keys(EXCLUDED_PATHS ?? {})];
  const top = readdirSync('src').map((name) => (statSync(join('src', name)).isDirectory() ? `src/${name}/` : `src/${name}`));

  it('as rendering or as excluded, never neither', () => {
    expect(top.filter((entry) => !classified().includes(entry))).toEqual([]);
  });

  it('never as both', () => {
    expect(RENDERING_PATHS.filter((p) => p in (EXCLUDED_PATHS ?? {}))).toEqual([]);
  });

  it('with a reason for every exclusion', () => {
    expect(EXCLUDED_PATHS).toBeTypeOf('object');
    expect(Object.entries(EXCLUDED_PATHS).filter(([, reason]) => reason.trim().length < 20)).toEqual([]);
  });

  it('naming only src/ entries that exist, so a rename cannot leave a stale classification behind', () => {
    const srcEntries = classified().filter((p) => p.startsWith('src/'));
    expect(srcEntries.filter((p) => !existsSync(p))).toEqual([]);
    expect(srcEntries.filter((p) => p.slice(4).replace(/\/$/, '').includes('/'))).toEqual([]);
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

/**
 * Independent review H2. Six commits on `fix/audit-0.9.0` touch rendering with no `Budget:` line — three predate the
 * rule, three were written after it. They were exempted in prose (`docs/release.md`) while the CI job was configured
 * so it could never judge a push at all, which made rule 4 unenforceable on the very flow the release prescribes. The
 * exemption now lives here, dated and by full SHA, so it is reviewable and so the job can run on push.
 */
describe('EXEMPT_COMMITS', () => {
  const shas = () => Object.keys(EXEMPT_COMMITS ?? {});

  it('is exactly the six commits, by full 40-character SHA', () => {
    expect(shas()).toHaveLength(6);
    expect(shas().filter((sha) => !/^[0-9a-f]{40}$/.test(sha))).toEqual([]);
    expect(new Set(shas()).size).toBe(6);
    expect(shas().map((sha) => sha.slice(0, 7)).sort()).toEqual(['2e9b125', '451ab9f', '4b61bd6', 'a485e57', 'b037656', 'efb7464']);
  });

  it('carries a date and a reason for each, so the exemption can be reviewed rather than trusted', () => {
    for (const [sha, entry] of Object.entries(EXEMPT_COMMITS)) {
      expect(entry.date, sha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.reason.trim().length, sha).toBeGreaterThan(20);
    }
  });

  it('lets an exempt commit pass, and still fails a commit that is not on the list', () => {
    const exempt = shas()[0]!;
    const rendering = { subject: 'ledger: x', files: ['src/ledger/hints.ts'], message: 'ledger: x\n\nno budget line\n' };
    expect(checkCommits([{ ...rendering, sha: exempt }])).toEqual([]);
    // The same commit under any other SHA, and a near-miss abbreviation of an exempt one, are still violations.
    expect(checkCommits([{ ...rendering, sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }])).toHaveLength(1);
    expect(checkCommits([{ ...rendering, sha: exempt.slice(0, 7) }])).toHaveLength(1);
  });

  it('exempts nothing that does not touch rendering, and nothing that already declares a budget', () => {
    // Belt and braces: an exempt SHA must not be a way to skip the file scan or the declaration parse for other work.
    const exempt = shas()[0]!;
    expect(checkCommits([{ sha: exempt, subject: 'docs: y', files: ['docs/x.md'], message: 'docs: y\n' }])).toEqual([]);
    expect(checkCommits([{ sha: exempt, subject: 'ledger: x', files: ['src/ledger/hints.ts'], message: 'ledger: x\n\nBudget: 28\n' }])).toEqual([]);
  });
});

describe('the exempt commits reported by the run', () => {
  it('are named in the summary, so an exemption is visible in the log rather than silent', () => {
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    r.commit('ledger: x\n\nno budget line', ['src/ledger/hints.ts']);
    const head = r.git('rev-parse', 'HEAD').trim();
    expect(run(r.dir, `${base}..HEAD`).status).toBe(1);
    // The same repository and the same commit, with that SHA on the list: it passes and the summary says so.
    const exempted = mainIn(r.dir, `${base}..HEAD`, { [head]: { date: '2026-09-16', reason: 'a reason long enough to be reviewable' } });
    expect(exempted.status, exempted.out).toBe(0);
    expect(exempted.out).toContain('1 exempt');
    expect(exempted.out).toContain(head.slice(0, 7));
    expect(exempted.out).toContain('a reason long enough to be reviewable');
  });

  it('does not exempt by default: the shipped list decides, and this commit is not on it', () => {
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    r.commit('ledger: x\n\nno budget line', ['src/ledger/hints.ts']);
    expect(mainIn(r.dir, `${base}..HEAD`).status).toBe(1);
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

  it('exits 0 on an empty range', () => {
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    const empty = run(r.dir, `${base}..HEAD`);
    expect(empty.out).toContain('0 commits');
    expect(empty.status).toBe(0);
  });

  it('leaves merge commits out, even a merge that itself edits a rendering file with no Budget line', () => {
    // A pull request that merges main back in carries merge commits whose content was budgeted where it was
    // written; asking them for a Budget line would fail every such branch. The cost, pinned here so it is a known
    // limit rather than a surprise: an "evil merge" that changes rendering code while merging is not checked.
    const r = repo();
    const base = r.commit('chore: init', ['README.md']);
    r.git('checkout', '-q', '-b', 'feature');
    r.commit('compiler: batch\n\nwhy\nBudget: 28', ['src/compiler/batch.ts']);
    r.git('checkout', '-q', 'main');
    r.commit('docs: notes', ['docs/notes.md']);
    r.git('merge', '-q', '--no-ff', '--no-commit', 'feature');
    mkdirSync(join(r.dir, 'src/compiler'), { recursive: true });
    writeFileSync(join(r.dir, 'src/compiler/culling.ts'), 'edited during the merge\n');
    r.git('add', '--', 'src/compiler/culling.ts');
    r.git('commit', '-q', '-m', "Merge branch 'feature'");
    // The setup is what the title says: HEAD is a merge, and its own diff lists a rendering file.
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    expect(r.git('show', '--pretty=format:', '--name-only', 'HEAD')).toContain('src/compiler/culling.ts');
    const merged = run(r.dir, `${base}..HEAD`);
    expect(merged.out).toContain('2 commits'); // the budgeted feature commit and the docs commit; the merge is not counted
    expect(merged.status).toBe(0);
  });
});
