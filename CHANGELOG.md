# Changelog

## Unreleased

- Device bench page (`bench-app/`, deployed by the `pages` workflow): runs the eight benchmark scenes on any device, shows the `pnpm bench` metrics plus real frame times, and submits the result as a GitHub issue; the `bench-results` workflow validates it, stores it under `bench/devices/` and regenerates `docs/devices.md`. Not part of the npm package.

## 0.3.0 — 2026-09-14

- `threeforge optimize <file>`: glTF-Transform build-time pipeline with three presets (`safe` never changes a pixel; `balanced` adds quantize and WebP textures; `aggressive` adds simplify), per-step reports, load-time requirements (`requires`), verification by rendering the original and the optimized file through the harness and compiling both, and a verdict that fails on lost pixels, clips, skins or morph targets. `optimize_asset` on the MCP server, `schema optimize`, `optimizeAsset` in `threeforge/cli`.
- `@gltf-transform/{core,functions,extensions}` are dependencies; `sharp` (texture compression) and `draco3dgltf` (Draco inputs) are optional peers.

## 0.2.0 — 2026-09-13

- Ledger v2: six cost sections (draw calls, measured overdraw, skinning, lighting, js, memory), device tiers, budgets and hints.
- Benchmark suite: eight scenes with naive and optimized variants, `pnpm bench` regression gate, committed baselines.
- Bake: `World({ bake })` merges each finished static group into one mesh, removing seams and duplicates (and, opt-in, buried faces), welding matching vertices; rebake on hide, `bakeDebug()`, CLI `--bake --views N` multi-view parity.
- For AI agents: `npx threeforge analyze|inspect|explain|schema|mcp`, `exposeToAgents()` hook, `AGENTS.md`, `llms.txt`.
- Warm-up renders a scissored frame instead of `compileAsync` (three r186 mis-compiles two-pass materials).

## 0.1.0

- Material registry, draw-call ledger, static batching, auto-instancing, spatial chunks, BVH culling, LOD, occlusion proxies, character assembler; verified on 104 public glTF assets on both backends.
