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
  `main`; the page's submit button targets this repository through `VITE_FORGE_REPO`.
- Create the `bench-result` label (the issue template applies it; the `bench-results` workflow also accepts any
  issue whose title starts with `bench:`).
- The `bench-results` workflow commits to `main` with the default `GITHUB_TOKEN`: branch protection must allow
  that (or add a bypass for GitHub Actions), otherwise the push step fails and the issue stays open.
- `pnpm bench:devices` regenerates `docs/devices.md` locally from `bench/devices/*.json`.
