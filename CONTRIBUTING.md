# Contributing to threeforge

threeforge is a scene compiler + draw-call diagnostics layer for three.js r186 (`three/webgpu`, WebGL2 fallback).
It is not an engine. Three.js renders; we rewrite naive scenes into batched ones and explain every remaining draw call.

Read `docs/threeforge.md` (the complete reference: every module, option and mechanism) before changing behaviour.

## Non-negotiable rules

1. One material per surface type. App code never constructs a material outside `MaterialRegistry`; call `registry.register(material)` and use what it returns.
2. Tag every mesh: `tag.static(obj)` or `tag.dynamic(obj)`. Untagged meshes appear in the ledger as `untagged` and are the first thing to fix.
3. Never overwrite `onBeforeRender` on a `BatchedMesh` or an instanced object. Those hooks do frustum culling and sorting; threeforge's own hooks compose via `prependRenderHook` and are marked with `FORGE_HOOK`.
4. Run `pnpm budget` after every change that touches rendering and put the resulting `sceneSubmissions` number in the commit message.
5. Never assert on `renderer.info.render.calls` (cumulative since app start) or raw `drawCalls` (backend dependent: N per BatchedMesh on WebGPU). Assert on `ledger.frame().totals.sceneSubmissions`.
6. The bake (`src/compiler/bake.ts`) must never change a pixel: a wrong deletion is visible, a missed one is invisible. New removal rules need a parity e2e on both backends (`test/e2e/bake.spec.ts`) and a counted entry in the report.
7. `threeforge optimize`'s `safe` preset must stay pixel-identical on the Fox and the Buggy e2e (`test/e2e/cli.spec.ts`); lossy steps are flags or the `balanced`/`aggressive` presets, never defaults. A new step needs a counted entry in `steps[]` and, if it adds an extension, a `requires` entry.
8. Run `pnpm bench` before merging anything that touches rendering. Baselines (`bench/baselines/*.json`) change only through `pnpm bench:baseline`, and the commit must say why the numbers moved. A measured snapshot must come from `frameAsync()`: shadow maps re-render once per animation-frame tick.

## Commands

- `pnpm test`: Vitest units (node, imports from `three` only, no GPU). `pnpm typecheck` and `pnpm lint` (Biome, also `pnpm lint:fix`) alongside it.
- `pnpm e2e`: Playwright on `webgl2` (headless shell) and `webgpu` (`FORGE_WEBGPU=native` on macOS/Windows, SwiftShader on Linux; caveats in `docs/design.md`).
- `pnpm budget`: fails above `FORGE_BUDGET` (default 30) scene submissions on the naive scene.
- `pnpm bench [webgl2|webgpu]`: the eight-scene suite (`test/app/scenes`, naive and optimized variants); fails on a 10 % regression against `bench/baselines`. `pnpm bench:baseline` promotes results, `pnpm bench:table` regenerates `docs/bench.md`, `pnpm bench:devices` regenerates `docs/devices.md` from `bench/devices/*.json`.
- `pnpm assets` then `pnpm assets:report`: the public glTF corpus (gitignored) compiled with pixel parity; `FORGE_ASSETS=Fox,Duck` limits the run. Read `docs/assets-report.md` before touching batching rules.
- `pnpm build`: library plus the harness page the CLI ships; `node dist/cli/index.js` is the agent CLI (`analyze`, `inspect`, `optimize`, `explain`, `schema`, `mcp`, `decoders`). Regenerate `AGENTS.md` with `node scripts/agents-md.mjs` after touching the hint table; a unit test checks it.
- `pnpm dev`: the test harness. Every `scene=` value and query parameter is parsed in `test/app/main.ts`; bench scenes take `scene=<name>&variant=naive|optimized`, and `backend=webgl2|webgpu`, `compile=1`, `overlay=1` are the ones to reach for first.
- `pnpm spike`: three's experimental `SceneOptimizer` on the naive scene, for comparison.

## Layout

- `src/compiler` classify, batch, bake, culling, instancing and `World` · `src/registry` material dedup and keys · `src/ledger` the frame ledger and hints · `src/character` the character assembler.
- One directory per cost module: `src/lod`, `src/overdraw`, `src/scheduler`, `src/lighting`, `src/skinning`, `src/load`, `src/memory`, `src/streaming`, `src/overlay`; `docs/threeforge.md` maps each to its exports.
- `src/cli` the agent CLI and MCP server (node only; Playwright and the MCP SDK are optional peers imported lazily) · `src/agent` the `exposeToAgents` hook · `cli-app` the harness page shipped with the CLI · `bench-app` the device bench page (GitHub Pages, not in the package).
- `test/unit` Vitest · `test/scenes` deterministic scenes · `test/app` Vite harness exposing `window.__forge` · `test/e2e` Playwright specs.
- Relative imports use `.js` extensions (NodeNext resolution). No default exports.

## Workflow

Failing test first, then the smallest implementation that passes, then refactor. Every module has unit tests; anything touching the renderer also has an e2e spec.
