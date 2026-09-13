# threeforge — rules for agents working in this repo

threeforge is a scene compiler + draw-call diagnostics layer for three.js r186 (`three/webgpu`, WebGL2 fallback).
It is not an engine. Three.js renders; we rewrite naive scenes into batched ones and explain every remaining draw call.

## Non-negotiable rules

1. One material per surface type. App code never constructs a material outside `MaterialRegistry`; call `registry.register(material)` and use what it returns.
2. Tag every mesh: `tag.static(obj)` or `tag.dynamic(obj)`. Untagged meshes appear in the ledger as `untagged` and are the first thing to fix.
3. Never overwrite `onBeforeRender` on a `BatchedMesh` or an instanced object. Those hooks do frustum culling and sorting.
4. Run `pnpm budget` after every change that touches rendering and put the resulting `sceneSubmissions` number in the commit message.
5. Never assert on `renderer.info.render.calls` (cumulative since app start) or raw `drawCalls` (backend dependent: N per BatchedMesh on WebGPU). Assert on `ledger.frame().totals.sceneSubmissions`.

## Commands

- `pnpm test` — Vitest units (node, imports from `three` only, no GPU).
- `pnpm e2e` — Playwright, WebGL2 backend in headless Chromium (the CI truth). The `webgpu` project is best effort and self-skips.
- `pnpm budget` — fails when the naive scene compiles to more than `FORGE_BUDGET` (default 30) scene submissions.
- `pnpm spike` — runs three's experimental `SceneOptimizer` on the naive scene for a baseline number.
- `pnpm typecheck`, `pnpm build` (tsc only, ESM, declarations).
- `pnpm dev` — opens the test app (`?scene=naive&compile=1&backend=webgl2`).

## Layout

- `src/registry` material dedup and keys · `src/ledger` draw-call attribution · `src/compiler` classify + batch + World · `src/overlay` optional DOM panel.
- `test/unit` Vitest · `test/scenes` deterministic scenes · `test/app` Vite harness exposing `window.__forge` · `test/e2e` Playwright specs.
- Relative imports use `.js` extensions (NodeNext resolution). No default exports.

## Workflow

Failing test first, then the smallest implementation that passes, then refactor. Every module has unit tests; anything touching the renderer also has an e2e spec.
