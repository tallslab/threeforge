# Releasing threeforge

1. Bump `version` in `package.json` and `src/version.ts` (a unit test keeps them equal), regenerate the agent docs
   with `pnpm build:lib && node scripts/agents-md.mjs`, update `CHANGELOG.md`.
2. `pnpm typecheck && pnpm test && pnpm build && pnpm e2e && pnpm bench` on a machine with a GPU.
3. `npm pack --dry-run` must list `dist/cli/index.js`, `dist/cli-app/index.html`, `AGENTS.md`, `llms.txt`.
4. Commit, tag `vX.Y.Z`, push the tag. The `publish` job in `.github/workflows/ci.yml` runs `npm publish --provenance
   --access public`; it needs the `NPM_TOKEN` repository secret (an npm automation token).

Consumers: `npm i -D threeforge playwright && npx playwright install chromium`, then `npx threeforge`.

## Device bench page and results (one-time repository settings)

- Settings → Pages → Source: **GitHub Actions**. The `pages` workflow then deploys `dist/bench-app` on every push to
  `main`, and `bench-results` also dispatches it (`gh workflow run pages.yml`) after every accepted result, since a
  `GITHUB_TOKEN` push does not itself fire another workflow's `on: push`. The page's submit button targets this
  repository through `VITE_FORGE_REPO`.
- Create two labels:
  - `bench-result` — applied automatically by the issue template to every submission; triage only, it grants no
    access.
  - `bench-accepted` — the acceptance label. Applying it is what makes `bench-results` ingest the issue's result
    and commit it to `main`.
- **Trust model.** A submitted issue is untrusted input from anyone with a GitHub account. `bench-results` only
  ingests a result after `bench-accepted` is applied, and only when the user who applied it has `write` or `admin`
  permission on the repository (checked live via the GitHub API for that specific user, not just "the label is
  present"). GitHub's Maintain role is accepted too — the collaborator-permission API reports that role's
  `permission` as `write`, not `maintain`. If someone without qualifying permission applies the label, the
  workflow removes it immediately and comments explaining why, without touching `bench/devices` or `main`.
  - **Editing withdraws acceptance.** If an already-accepted, still-open issue (one still carrying
    `bench-accepted`) is edited, `bench-results` removes the label and comments that the edit withdrew
    acceptance — a maintainer must look at the new content and re-apply the label before it is ingested. This
    stops a submitter from getting a body approved and then swapping in something else afterwards. (A closed,
    already-ingested issue is left alone if edited — re-applying the label to a closed issue wouldn't do
    anything, since ingestion also requires the issue to still be open.)
  - Applying a label at all needs GitHub's Triage role or higher, which is still short of `write`/`admin` — a
    triage-only collaborator can technically apply `bench-accepted`, so the label alone is not proof of
    maintainer trust. The workflow is what enforces the actual `write`/`admin` requirement (removing the label
    again within seconds if the labeler doesn't qualify), so no separate repository setting is needed to restrict
    who can apply labels.
  - **Duplicate and colliding ids.** A result's id is derived from its GPU/browser/backend and the day it was
    submitted, so re-accepting the same unedited issue (or a duplicate webhook delivery) reproduces byte-identical
    content — the workflow recognizes this and closes the issue as recorded without a second commit. If a
    *different* result collides on the same id (the same device benched again the same day), the workflow leaves
    the earlier file untouched, removes `bench-accepted`, and comments on the issue rather than silently
    overwriting the first submission.
- The `bench-results` workflow commits to `main` with the default `GITHUB_TOKEN`: branch protection on `main` must
  allow that push — either let the GitHub Actions bot push directly, or add a bypass for it — otherwise the push
  step fails after its retries, the `bench-accepted` label is removed, and a comment says so on the issue.
- `pnpm bench:devices` regenerates `docs/devices.md` locally from `bench/devices/*.json`.
