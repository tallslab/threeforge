# Releasing threeforge

## Commit rules

Every commit that touches a rendering path (`RENDERING_PATHS` in `scripts/commit-rules.mjs`) carries a
`Budget: <n>` or `Budget: n/a <reason>` line in its body, the `sceneSubmissions` number from `pnpm budget`
(CONTRIBUTING.md rule 4). CI's `commit-rules` job checks this on every pull request and every push, over the commits
the pull request or push adds; merge commits are not checked. Run it locally the same way:
`node scripts/commit-rules.mjs main..HEAD`. There is no way past the rule: a rendering commit without a
`Budget:` line fails the run.

## Cutting a release

1. Bump `version` in `package.json` and `src/version.ts` (a unit test keeps them equal), regenerate the agent docs
   with `pnpm build:lib && node scripts/agents-md.mjs`, update `CHANGELOG.md`.
2. `pnpm typecheck && pnpm test && pnpm build && pnpm e2e --grep-invert "assets\.spec\.ts" && pnpm bench` on a
   machine with a GPU (a native WebGPU adapter: this is the only run that checks WebGPU pixels in the e2e specs),
   with the kits and the corpus downloaded, and with KTX-Software installed and `FORGE_REQUIRE_KTX=1` set: CI encodes
   KTX2 on its `webgl2` leg only, so this is the run that proves encoding and the measured GPU saving on a native
   WebGPU adapter. `assets.spec.ts` is left out on purpose: it rewrites the tracked
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

- `commit-rules`: the `Budget:` line check above.
- `unit`: `pnpm typecheck`, `pnpm test`, `pnpm build`, plus an informational ledger-overhead figure in the run
  summary (not a gate, compared to nothing).
- `e2e`: both backends, `--grep-invert "@corpus|@bench|@temporal"`, and no downloaded content at all. Its
  `test-results` are uploaded whenever the run left any, the advisory `webgpu` leg included. The `webgl2` leg installs
  KTX-Software 4.4.2 (one pinned release, its package checked against the published SHA-256 before installation) and
  sets `FORGE_REQUIRE_KTX=1`, so the test that runs `optimize --textures ktx2`, loads the result and measures its GPU
  bytes cannot skip there; without the variable, and locally without the encoder, it skips.
- `temporal`: the six stepped-sequence tests (`test/e2e/temporal-*.spec.ts`), with the Kenney kits, because the two
  animation ones are also `@corpus`. `webgl2` gates. On `webgpu` every one of them skips (SwiftShader, no pixel
  checks), and the job's summary says so: that leg validates no WebGPU pixel. A failing sequence writes its first and
  its worst failing frame, each with reference, diff and neighbours, plus `sequence.json` (every step in order with
  its inputs, camera, buffer sizes and adapter, the pages opened, and the command to run it again) into a directory
  of its own under `FORGE_TEMPORAL_OUT`. The job uploads that directory and a ran/skipped/excluded report
  (`scripts/temporal-report.mjs`, also in the run summary) whatever the outcome. Locally the directory defaults to the
  system temp directory and the failing test's error names it.
- `bench`: both backends, the gate in `scripts/bench-run.mjs`. The only pull-request job that downloads
  anything (the Kenney kits and the water map, with `FORGE_FETCH_STRICT=1` so a failed download fails by name).
  Deterministic cost metrics are gated; timing is recorded only, since the runner is SwiftShader, not a GPU.

A green pull-request run is not full coverage. The `@corpus` tag takes every test that needs downloaded content out
of the `e2e` job: most of `cli.spec.ts` and `mcp.spec.ts`, all of `ParticleBudget`, and the `arena`, `assets`,
`bench`, `biome`, `crowd`, `vat` and `warmup` specs. **The `e2e` and `bench` jobs on `webgpu` are advisory and
establish nothing about WebGPU pixels**: a Linux runner's WebGPU adapter is SwiftShader, which drops the device
between test steps, so `test/e2e/fixtures.ts` turns `pixelChecks` off there, the specs that honour it compare no
pictures, and CI reports those legs without blocking on them. WebGPU pixel parity is proven only by a local run on a
native adapter (steps 2 and 4 above).

`.github/workflows/assets.yml` runs the full corpus on both backends weekly (Mondays 04:17 UTC) and on manual dispatch.
It fails when any asset misbehaves or failed to download, uploads `docs/assets-report*` as a build artifact and never
commits: the tracked report files are updated by hand, from that artifact or by step 4. It runs the temporal tests as
well and uploads their failure frames and report the same way as the `temporal` job. **Its `webgpu` leg is advisory for
the same reason as above, and only for its tests**: install, the strict downloads and the build still fail the job.
Inside the test step, `scripts/advisory-report.mjs` runs Playwright itself and judges its report after every run, a run
that exited 0 included, because Playwright exits 0 when a check is merely skipped. These stay blocking: an error of the
run itself (a global setup or teardown, a timeout of the whole run); a test command that was killed, exited outside 0
and 1, exited 1 with nothing in the report to account for it, or wrote no report; and the `@adapter` check not passing,
whether it failed, was skipped or never ran. That check is `smoke.spec.ts`, which opens a page on WebGPU and draws a
frame, so a runner without an adapter fails the job even though the CLI's help and schema tests pass with no GPU. Other
failed tests become a warning with the real counts, the run summary lists each one and every blocking reason
(`scripts/advisory-report.mjs`), and `test-results` is uploaded either way. On the first run of this workflow that leg
failed 43 tests: 32 with the adapter's lost-device errors (`mapAsync` on a vanished instance, `createBuffer` refused),
one because `arena.spec.ts` captured the canvas where captures are off (since guarded), and 10 assertions nobody has
traced to the adapter. Advisory is a statement about this runner, not about those 10: they are open until someone traces
them. The guarded specs skip their captures on this adapter, while `biome.spec.ts`, `assets.spec.ts` and the CLI's own
comparisons still capture there; a pass on this runner does not establish native WebGPU pixel correctness. That stays
the native run of steps 2 and 4, required before every release.

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
