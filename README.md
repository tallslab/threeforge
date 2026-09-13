# threeforge

Scene compiler + draw-call diagnostics for three.js. Three.js stays the renderer; threeforge takes a naively assembled scene, rewrites it into a batched one at load time, and tells you exactly why every remaining draw call exists.

Status: Phase 1 (material registry, draw-call ledger, static merge). See `docs/` and `CONTRIBUTING.md`.
