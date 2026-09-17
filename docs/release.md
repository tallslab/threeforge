# Releasing threeforge

## Commit rules

Every commit that touches a rendering path (`RENDERING_PATHS` in `scripts/commit-rules.mjs`) carries a
`Budget: <n>` or `Budget: n/a <reason>` line in its body, the `sceneSubmissions` number from `pnpm budget`
(CONTRIBUTING.md rule 4). CI's `commit-rules` job checks this on every pull request and every push, over the commits
the pull request or push adds; merge commits are not checked. Run it locally the same way:
`node scripts/commit-rules.mjs main..HEAD`. The only way past the rule is `EXEMPT_COMMITS` in the same script, a
dated allow-list of full SHAs with a reason each, and every run prints what it excused.

## Cutting a release

1. Bump `version` in `package.json` and `src/version.ts` (a unit test keeps them equal), regenerate the agent docs
   with `pnpm build:lib && node scripts/agents-md.mjs`, update `CHANGELOG.md`.
2. `pnpm typecheck && pnpm test && pnpm build && pnpm e2e --grep-invert "assets\.spec\.ts" && pnpm bench` on a
   machine with a GPU (a native WebGPU adapter: this is the only run that checks WebGPU pixels in the e2e specs),
   with the kits and the corpus downloaded. `assets.spec.ts` is left out on purpose: it rewrites the tracked
   `docs/assets-report*` files, and run here, with step 1's edits uncommitted, it would stamp every row with the
   previous commit and `-dirty`.
3. If `pnpm bench` fails its gate and the movement is intended, promote the new numbers with `pnpm bench:baseline`
   and say why they moved in the commit message (CONTRIBUTING.md rule 8). Baselines change no other way.
4. Refresh the corpus report as a deliberate step of its own, when the release should cite a report measured on its
   own code:
   1. Commit step 1's edits first. `git status --short` must print nothing, or every row is stamped `-dirty`.
   2. Pick one run id and pin it: `FORGE_RUN_ID=corpus-<yyyymmdd>`.
   3. Run `FORGE_RUN_ID=… pnpm exec playwright test test/e2e/assets.spec.ts --project=webgl2`, then the same with
      `--project=webgpu`, with no `FORGE_ASSETS` filter: the Markdown is rewritten only after a run that measured
      every asset in the index.
   4. Check that each Markdown header names that commit and run id, that every row of both JSON files carries them,
      and whether any asset failed. A failing asset is reported in the release notes, not hidden.
   5. Commit exactly `docs/assets-report.json`, `docs/assets-report.md`, `docs/assets-report-webgpu.json` and
      `docs/assets-report-webgpu.md`, naming the commit, the run id and the pass count per backend, before tagging.
5. `npm pack --dry-run` must list `dist/cli/index.js`, `dist/cli-app/index.html`, `AGENTS.md`, `llms.txt`.
6. Commit, tag `vX.Y.Z`, push the tag. The `publish` job in `.github/workflows/ci.yml` runs `npm publish --provenance
   --access public`; it needs the `NPM_TOKEN` repository secret (an npm automation token). The job refuses a tag
   that does not match `package.json` (`v0.9.0` needs `"version": "0.9.0"`). Consumers then run
   `npm i -D threeforge playwright && npx playwright install chromium` and `npx threeforge`.

## What CI covers, and what it does not

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- **`commit-rules`** — the `Budget:` line check above.
- **`unit`** — `pnpm typecheck`, `pnpm test`, `pnpm build`, plus an informational ledger-overhead figure in the run
  summary (not a gate, compared to nothing).
- **`e2e`** — both backends, `--grep-invert "@corpus|@bench"`, and no downloaded content at all.
- **`bench`** — both backends, the gate in `scripts/bench-run.mjs`. The only pull-request job that downloads
  anything (the Kenney kits and the water map, with `FORGE_FETCH_STRICT=1` so a failed download fails by name).
  Deterministic cost metrics are gated; timing is recorded only, since the runner is SwiftShader, not a GPU.

A green pull-request run is not full coverage. The `@corpus` tag takes every test that needs downloaded content out
of the `e2e` job: most of `cli.spec.ts` and `mcp.spec.ts`, all of `ParticleBudget`, and the `arena`, `assets`,
`bench`, `biome`, `crowd`, `vat` and `warmup` specs. **The `e2e` job on `webgpu` checks no pixels at all**: a Linux
runner's WebGPU adapter is SwiftShader, so `test/e2e/fixtures.ts` turns `pixelChecks` off there. WebGPU pixel parity
is proven only by a local run on a native adapter (steps 2 and 4 above).

`.github/workflows/assets.yml` runs the full corpus on both backends weekly (Mondays 04:17 UTC) and on manual
dispatch. It fails when any asset misbehaves or failed to download, uploads `docs/assets-report*` as a build
artifact and never commits: the tracked report files are updated by hand, from that artifact or by step 4.

`FORGE_FETCH_STRICT=1` makes `pnpm assets` and `pnpm assets:kits` exit 1 after listing every failed download; unset
(the local default) the failure is recorded in the index and the script exits 0. `FORGE_BENCH_APP_OPTIONAL=1` lets
`scripts/bench-app-assets.mjs` warn instead of exiting 1 without the kits; only Playwright's `webServer` sets it.

## Device bench page and results (one-time repository settings)

- Settings → Pages → Source: **GitHub Actions**. The `pages` workflow deploys `dist/bench-app` on every push to
  `main`, and `bench-results` also dispatches it after every accepted result. The page's submit button targets this
  repository through `VITE_FORGE_REPO`.
- Create two labels: `bench-result` (applied by the issue template to every submission; triage only) and
  `bench-accepted` (the acceptance label: applying it makes `bench-results` ingest the issue's result into `main`).
- Trust model: a submitted issue is untrusted input. `bench-results` ingests only after `bench-accepted` is applied
  by a user with `write` or `admin` permission (checked live; Maintain reports as `write`); otherwise it removes the
  label and comments why. Editing an accepted, still-open issue withdraws acceptance. Re-accepting an unedited issue
  reproduces byte-identical content and closes it without a second commit; a different result colliding on the same
  id (same device, same day) leaves the earlier file untouched and removes the label.
- The workflow commits to `main` with the default `GITHUB_TOKEN`: branch protection must allow that push.
  `pnpm bench:devices` regenerates `docs/devices.md` locally from `bench/devices/*.json`.
