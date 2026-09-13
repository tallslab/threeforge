# threeforge — rules for agents working in this repo

threeforge is a scene compiler + draw-call diagnostics layer for three.js r186 (`three/webgpu`, WebGL2 fallback).
It is not an engine. Three.js renders; we rewrite naive scenes into batched ones and explain every remaining draw call.

## Non-negotiable rules

1. One material per surface type. App code never constructs a material outside `MaterialRegistry`; call `registry.register(material)` and use what it returns.
2. Tag every mesh: `tag.static(obj)` or `tag.dynamic(obj)`. Untagged meshes appear in the ledger as `untagged` and are the first thing to fix.
3. Never overwrite `onBeforeRender` on a `BatchedMesh` or an instanced object. Those hooks do frustum culling and sorting; threeforge's own hooks compose via `prependRenderHook` and are marked with `FORGE_HOOK`.
4. Run `pnpm budget` after every change that touches rendering and put the resulting `sceneSubmissions` number in the commit message.
5. Never assert on `renderer.info.render.calls` (cumulative since app start) or raw `drawCalls` (backend dependent: N per BatchedMesh on WebGPU). Assert on `ledger.frame().totals.sceneSubmissions`.
6. Run `pnpm bench` before merging anything that touches rendering. Baselines (`bench/baselines/*.json`) change only through `pnpm bench:baseline`, and the commit must say why the numbers moved. A measured snapshot must come from `frameAsync()`: shadow maps re-render once per animation-frame tick.

## Commands

- `pnpm test` — Vitest units (node, imports from `three` only, no GPU).
- `pnpm e2e` — Playwright on both backends: `webgl2` (headless shell) and `webgpu` (native adapter on macOS/Windows via `FORGE_WEBGPU=native`, SwiftShader on Linux; see docs/design.md for the SwiftShader caveats). Includes the 20k-instance field scene (`test/scenes/field.ts`).
- `pnpm budget` — fails when the naive scene compiles to more than `FORGE_BUDGET` (default 30) scene submissions.
- `pnpm spike` — runs three's experimental `SceneOptimizer` on the naive scene for a baseline number.
- `pnpm assets` then `pnpm assets:report` — downloads public glTF test content (gitignored) and compiles every model with pixel parity; `FORGE_ASSETS=Fox,Duck` limits the run. Read `docs/assets-report.md` before touching batching rules. The biome and arena specs are the integration stress tests; use `frameAsync()` in the harness when a measurement must include shadow passes.
- `pnpm bench [webgl2|webgpu]` — the benchmark suite (eight scenes in `test/app/scenes`, naive and optimized variants): writes `bench/results/local.<backend>.json` and fails when any deterministic cost metric regresses by 10 % against `bench/baselines`. `pnpm bench:baseline` promotes results; `pnpm bench:table` rewrites `docs/bench.md` and the README table.
- `pnpm build` — library (tsc) plus the shipped harness page (`dist/cli-app`); `node dist/cli/index.js …` is the agent CLI (`npx threeforge` after install): `analyze <file>`, `inspect <url>`, `explain <code>`, `schema`, `mcp`. Regenerate `AGENTS.md` with `node scripts/agents-md.mjs` after touching the hint table; a unit test checks it.
- `pnpm typecheck`.
- `pnpm dev` — opens the test app. Query params: `scene=naive|field|character|gltf&asset=<name>|biome|arena|empty` or a bench scene `scene=village|forest|crowd|bossfight|lake|daynight|zen|rpg&variant=naive|optimized`, `backend=webgl2|webgpu`, `compile=1`, `overlay=1&budget=30`, `animate=1`, `dynamics=batch-sync`, `lod=1`, `chunk=40`, `occlusion=1`, `wall=1`, `shadows=1`, `count=20000`.

## Layout

- `src/cli` the agent CLI and MCP server (node only; Playwright and the MCP SDK are optional peers imported lazily) · `src/agent` the `exposeToAgents` hook · `cli-app` the harness page shipped with the CLI · `src/registry` material dedup and keys · `src/ledger` the six-section frame ledger (draw calls, measured overdraw, skinning, lighting, js, memory, hints) · `src/compiler` classify + batch + culling + instancing + World · `src/lod` meshoptimizer LOD generation · `src/overlay` optional DOM panel.
- `test/unit` Vitest · `test/scenes` deterministic scenes · `test/app` Vite harness exposing `window.__forge` · `test/e2e` Playwright specs.
- Relative imports use `.js` extensions (NodeNext resolution). No default exports.

## Workflow

Failing test first, then the smallest implementation that passes, then refactor. Every module has unit tests; anything touching the renderer also has an e2e spec.
