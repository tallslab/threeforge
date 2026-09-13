# Changelog

## 0.2.0 — 2026-09-13

- Ledger v2: six cost sections (draw calls, measured overdraw, skinning, lighting, js, memory), device tiers, budgets and hints.
- Benchmark suite: eight scenes with naive and optimized variants, `pnpm bench` regression gate, committed baselines.
- Bake: `World({ bake })` merges each finished static group into one mesh, removing seams and duplicates (and, opt-in, buried faces), welding matching vertices; rebake on hide, `bakeDebug()`, CLI `--bake --views N` multi-view parity.
- For AI agents: `npx threeforge analyze|inspect|explain|schema|mcp`, `exposeToAgents()` hook, `AGENTS.md`, `llms.txt`.
- Warm-up renders a scissored frame instead of `compileAsync` (three r186 mis-compiles two-pass materials).

## 0.1.0

- Material registry, draw-call ledger, static batching, auto-instancing, spatial chunks, BVH culling, LOD, occlusion proxies, character assembler; verified on 104 public glTF assets on both backends.
