/**
 * CONTRIBUTING.md rule 4 as a check a machine can run: a commit that touches rendering carries the budget it measured.
 *
 * Usage: node scripts/commit-rules.mjs <base>..<head>     (CI passes the pull request's base and head SHAs)
 *        node scripts/commit-rules.mjs --push <before> <after>   (CI passes a push event's two SHAs; see `pushRange`)
 *
 * A commit whose files all lie outside `RENDERING_PATHS` is never asked for anything. One that touches a rendering
 * path must carry, on a line of the body (not the subject), either `Budget: <n>` — the `pnpm budget` reading — or
 * `Budget: n/a <reason>` for a change that cannot move the number (a comment, a type, a test-only edit inside a
 * rendering directory). Exits 1 listing every offending commit, its subject and the files that made it one.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * What counts as a rendering change. An entry ending in `/` matches everything under that directory, by whole path
 * segment (`src/cli/compiler.ts` and `src/compiler-notes.md` are not `src/compiler/`); any other entry matches that
 * one file exactly, which is how `src/tags.ts` is listed. Every top-level entry of `src/` must appear here or in
 * `EXCLUDED_PATHS`: `test/unit/commit-rules.test.ts` enumerates `src/` and fails on one that is in neither, so a new
 * directory cannot escape the rule by being forgotten.
 */
export const RENDERING_PATHS = [
  'src/compiler/', // classify, batch, bake, culling, instancing, World: what gets drawn and how often
  'src/ledger/', // the frame ledger and its hooks into the renderer; `pnpm budget` reads its count
  'src/registry/', // material dedup: fewer canonical materials, fewer batches
  'src/lighting/', // DayNight and ShadowBudget: shadow passes and their casters
  'src/skinning/', // baked animation textures and AnimatedInstances: skinned draws become instanced ones
  'src/overdraw/', // ParticleBudget and ResolutionScaler: what is drawn and at what size
  'src/scheduler/', // RenderScheduler: whether a frame renders at all
  'src/streaming/', // the chunk Streamer: which objects are in the scene
  'src/memory/', // ResourceTracker: disposes geometry, textures and materials the scene draws with
  'src/lod/', // meshoptimizer LODs: which geometry each draw uses
  'src/load/', // createLoader: decoders and the geometry and textures a loaded scene draws
  'src/character/', // assembleCharacter: merges skinned parts and gear onto one mesh and one atlas
  'src/tags.ts', // tag.static / tag.dynamic: decides what world.compile() batches
  'test/scenes/', // the deterministic scenes, the naive one being what `pnpm budget` measures
  'test/app/', // the harness page and bench scenes the budget and bench specs render
];

/**
 * The top-level entries of `src/` that are deliberately not rendering, each with the reason. A path here needs no
 * `Budget:` line; a reason that stops being true means the entry belongs in `RENDERING_PATHS`.
 */
export const EXCLUDED_PATHS = {
  'src/cli/':
    'the agent CLI and MCP server: node-side tooling that drives a page from outside and never runs inside a frame',
  'src/agent/':
    "the exposeToAgents hook: forwards to the app's own renderer, world and ledger and defines no scene content, material, tag or pass of its own",
  'src/overlay/':
    'a fixed-position DOM text panel that reads ledger.frame() on a timer: type-only imports, no three.js object, no render, no submission',
  'src/index.ts':
    'the package barrel: export statements only, so it can change what is reachable but not what a frame draws',
  'src/version.ts': 'the version string, mirrored from package.json',
};

/** The subset of `files` that lies under a rendering path (or is a listed rendering file), in the order given. */
export function touchesRendering(files) {
  return files.filter((file) =>
    RENDERING_PATHS.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path)),
  );
}

/** Any line of the body that looks like a budget declaration, however malformed, so a typo is named, not ignored. */
function declarationLines(message) {
  return message
    .split('\n')
    .slice(1)
    .filter((line) => /^[ \t]*budget[ \t]*:/i.test(line));
}

/**
 * The budget this commit message declares, or `null` when there is none or the one there is malformed. Accepts
 * `Budget: <n>` (trailing prose allowed) and `Budget: n/a <reason>`, on a body line, spelled exactly `Budget:`.
 */
export function budgetDeclaration(message) {
  for (const line of message.split('\n').slice(1)) {
    const match = /^Budget:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    const na = /^n\/a\b(.*)$/i.exec(value);
    if (na) {
      const reason = na[1].trim();
      if (reason) return { kind: 'n/a', reason, line: line.trimEnd() };
      continue;
    }
    const count = /^(\d+)\b/.exec(value);
    if (count) return { kind: 'count', value: Number(count[1]), line: line.trimEnd() };
  }
  return null;
}

/** The commits that owe a declaration and do not have one. */
function undeclared(commits) {
  return commits.filter((commit) => touchesRendering(commit.files).length > 0 && !budgetDeclaration(commit.message));
}

/**
 * Every commit that touches rendering without a usable declaration. `commits` are `{ sha, subject, message, files }`;
 * the result is `{ sha, subject, files, problem }` per offender.
 */
export function checkCommits(commits) {
  const violations = [];
  for (const commit of undeclared(commits)) {
    const files = touchesRendering(commit.files);
    const malformed = declarationLines(commit.message).map((line) => line.trim());
    const problem = malformed.length
      ? `a \`Budget:\` line that does not parse: ${malformed.map((line) => JSON.stringify(line)).join(', ')}. Use \`Budget: <n>\` (the \`pnpm budget\` reading) or \`Budget: n/a <reason>\`, spelled exactly, unindented, in the body.`
      : 'no `Budget:` line in the body. Run `pnpm budget` and add `Budget: <n>`, or `Budget: n/a <reason>` when the change cannot move the number.';
    violations.push({ sha: commit.sha, subject: commit.subject, files, problem });
  }
  return violations;
}

/** Reads `range` out of the repository in `cwd` as `{ sha, subject, message, files }`, merges excluded. */
export function readCommits(range, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const shas = git('rev-list', '--no-merges', range, '--').split('\n').filter(Boolean);
  return shas.map((sha) => {
    const message = git('show', '-s', '--format=%B', sha, '--');
    const files = git('show', '--pretty=format:', '--name-only', sha, '--').split('\n').filter(Boolean);
    return { sha, subject: message.split('\n')[0] ?? '', message, files };
  });
}

/** What a push event sends as `before` when it created the ref (a branch's first push, and every tag push). */
export const ZERO_SHA = '0'.repeat(40);

/**
 * The range of commits a push adds, and the reason for it, or `{ range: null }` when there is no range to judge.
 *
 * `github.event.before..after` is only the right range when the push fast-forwarded. Two other cases reach CI, and
 * both used to be reported as "this push created the ref", which for a force push is untrue and left the rule looking
 * inapplicable rather than unenforced:
 * - the push created the ref (`before` is forty zeros): a branch's first push, and every tag push;
 * - `before` is not an ancestor of `after`: a force push or a rewritten history. After the old commits are dropped it
 *   may not be in the clone at all, which `has` reports separately so the message can say which it was.
 *
 * Both fall back to `merge-base(defaultRef, after)..after` — the commits this push adds on top of the shared history —
 * and only a missing merge-base, or one that is the pushed commit itself (seeding the default branch), has no range.
 *
 * `git` is the three queries this needs (`gitQueries`), injected so both paths are unit-testable without a remote.
 */
export function pushRange({ before, after, defaultRef = 'origin/main' }, git) {
  const created = before === ZERO_SHA;
  const missing = !created && !git.has(before);
  const forced = !created && !missing && !git.isAncestor(before, after);
  if (!created && !missing && !forced) return { range: `${before}..${after}`, reason: null };
  const why = created
    ? `this push created the ref (before=${before})`
    : missing
      ? `${before} is not in this clone: a force push whose replaced commits were dropped, so it is not an ancestor of ${after}`
      : `${before} is not an ancestor of ${after}: a force push or a rewritten history`;
  const base = git.mergeBase(defaultRef, after);
  if (!base || base === after) {
    return {
      range: null,
      reason: `commit-rules: skipped. ${why}, and ${defaultRef} gives no earlier base to compare ${after} against, so there is no range of added commits to judge.`,
    };
  }
  return {
    range: `${base}..${after}`,
    reason: `commit-rules: ${why}. Judging ${base}..${after} instead: the commits this push adds on top of the merge-base with ${defaultRef}.`,
  };
}

/** `pushRange`'s three queries against a real repository. Each answers rather than throwing, as `git` exit codes do. */
export function gitQueries(cwd = process.cwd()) {
  const ok = (...args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return {
    has: (sha) => ok('cat-file', '-e', `${sha}^{commit}`) !== null,
    isAncestor: (a, b) => ok('merge-base', '--is-ancestor', a, b) !== null,
    mergeBase: (a, b) => ok('merge-base', a, b) ?? '',
  };
}

export function main(argv, cwd = process.cwd(), git = null) {
  let range = argv[0];
  if (range === '--push') {
    const [, before, after] = argv;
    if (!before || !after) {
      console.error('usage: node scripts/commit-rules.mjs --push <before> <after>');
      return 2;
    }
    const resolved = pushRange({ before, after }, git ?? gitQueries(cwd));
    if (resolved.reason) console.log(resolved.reason);
    if (resolved.range === null) return 0;
    range = resolved.range;
  }
  if (!range) {
    console.error('usage: node scripts/commit-rules.mjs <base>..<head>   |   --push <before> <after>');
    return 2;
  }
  const commits = readCommits(range, cwd);
  const violations = checkCommits(commits);
  if (violations.length === 0) {
    console.log(`commit rules: ${commits.length} commits in ${range}, every rendering change declares a budget`);
    return 0;
  }
  console.error(
    `commit rules: ${violations.length} of ${commits.length} commits in ${range} touch rendering without a budget:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.sha.slice(0, 7)} ${v.subject}`);
    console.error(`    rendering files: ${v.files.join(', ')}`);
    console.error(`    ${v.problem}\n`);
  }
  console.error(
    'CONTRIBUTING.md rule 4: run `pnpm budget` after every change that touches rendering and put the result in the commit message.',
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
