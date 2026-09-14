# Benchmark suite

Eight scenes (`test/app/scenes/*.ts`), each with a naive assembly and an optimized path through threeforge.

- `pnpm bench [webgl2|webgpu]` runs the suite (Playwright, `test/e2e/bench.spec.ts`), writes `bench/results/local.<backend>.json` (gitignored) and gates it against `bench/baselines/<backend>.json`: any deterministic cost metric worse by 10 % or more fails. Timing metrics are gated only with `FORGE_GPU=native`.
- `pnpm bench:baseline [backend]` promotes the last results to the baseline and rewrites `docs/bench.md` plus the README table. Commit the baseline diff with an explanation of why the numbers moved.
- `pnpm bench:table` rewrites the docs from the committed baselines.
- `pnpm bench:app` serves the device bench page (`bench-app/`, needs `FORGE_KITS_ONLY=1 pnpm assets:kits`); results submitted from it land in `bench/devices/*.json` through the `bench-results` workflow, and `pnpm bench:devices` renders `docs/devices.md`. Device numbers are published, never gated.
