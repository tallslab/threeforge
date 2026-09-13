// Generates AGENTS.md, llms.txt and docs/agents.md from the built remedy table so the hint list never drifts.
// Run after `pnpm build:lib`: node scripts/agents-md.mjs
import { writeFileSync } from 'node:fs';
import { REMEDIES } from '../dist/cli/explain.js';
import { VERSION } from '../dist/version.js';

const hintRows = Object.values(REMEDIES)
  .map((r) => `| \`${r.code}\` | ${r.category} | ${r.severity} | ${r.fix} |`)
  .join('\n');

const body = `# threeforge for AI agents

threeforge ${VERSION} is a frame-budget compiler and diagnostics layer for three.js games (r186, WebGPU with a
WebGL2 fallback). This file is what \`npx threeforge\` prints. Everything below is scriptable from a terminal and
prints JSON with \`--json\`.

## Install

\`\`\`bash
npm i -D threeforge playwright && npx playwright install chromium
\`\`\`

Playwright is only needed for \`analyze\`, \`inspect\` and \`mcp\`; the library itself has no such dependency.

## Commands

| command | what it does |
|---|---|
| \`npx threeforge analyze <file.glb\\|.gltf> [--backend webgl2\\|webgpu] [--tier auto\\|desktop\\|phone-mid\\|phone-low] [--budget N] [--frames 30] [--no-compile] [--bake] [--bake-buried] [--views N] [--json]\` | Renders the asset headlessly, measures every cost category, compiles (batches, or bakes with \`--bake\`) it, measures again, checks pixel parity from the default framing plus \`--views\` orbit views, returns hints and a verdict. |
| \`npx threeforge inspect <url> [--frames 30] [--compile] [--budget N] [--json]\` | Drives your running app (dev server) through \`window.__threeforge\`; same document without asset facts and parity. |
| \`npx threeforge explain <hint-code> \\| --all [--json]\` | What a hint means, what to change, which API. |
| \`npx threeforge schema [snapshot\\|analyze\\|inspect\\|all]\` | JSON Schemas (draft 2020-12) of everything the commands print. |
| \`npx threeforge mcp\` | Stdio MCP server with tools \`analyze_asset\`, \`inspect_app\`, \`explain_hint\` (needs \`npm i -D @modelcontextprotocol/sdk zod\`). |

Exit codes: \`0\` pass · \`1\` verdict failed (over budget, an error-severity hint, or pixel parity lost) · \`2\` usage or
input error · \`3\` environment (Playwright or Chromium missing; the message has the install command) · \`4\` the page
threw or timed out. In \`--json\` mode stdout is only the JSON document; the human summary goes to stderr.

## Make your app inspectable (one line)

\`\`\`ts
import { DrawCallLedger, MaterialRegistry, World, exposeToAgents, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);
const world = new World(scene, { registry, ledger, policy: 'auto' });
exposeToAgents({ ledger, world, renderer, scene, camera }); // publishes window.__threeforge
\`\`\`

Then \`npx threeforge inspect http://localhost:5173 --compile --json\`. The hook offers \`frame()\`, \`frameAsync()\`,
\`compile()\`, \`decompile()\`, \`measureOverdraw()\`, \`measureMemory()\`, \`hints()\`, \`report()\`; an agent driving its own
browser can call them directly.

## The document you get back

\`\`\`json
{
  "schemaVersion": 1, "tool": "threeforge", "version": "${VERSION}", "command": "analyze",
  "input": { "file": "scene.glb", "backend": "webgpu", "tier": "phone-mid", "budget": null, "frames": 30, "compile": true },
  "env": { "three": "186", "backend": "webgpu", "gpu": "apple metal-3", "tier": "phone-mid" },
  "asset": { "meshes": 12, "materials": 5, "vertices": 40210, "triangles": 38000, "animations": 1, "skinned": 1, "morph": 0, "loadMs": 120 },
  "before": { "totals": { "sceneSubmissions": 503 }, "overdraw": {}, "skinning": {}, "lighting": {}, "js": {}, "memory": {}, "hints": [] },
  "after":  { "totals": { "sceneSubmissions": 28 } },
  "compile": { "after": { "batches": 15, "instanced": 0, "meshes": 13 }, "skipped": [{ "path": "player", "rule": "skinned-mesh" }] },
  "parity": { "diffPct": 0.01, "threshold": 0.5, "pass": true },
  "hints": [{ "category": "lighting", "severity": "warn", "code": "point-light-shadow", "message": "...", "objects": ["lamp"] }],
  "verdict": { "pass": true, "budget": null, "errors": [], "reasons": [] },
  "timings": { "totalMs": 4200 }
}
\`\`\`

\`before\` and \`after\` are full snapshots (\`npx threeforge schema snapshot\`): draw calls by reason, measured
overdraw (fragments per pixel, opaque and transparent), skinning, lighting and shadow texels, JS timings, memory
estimate, and \`hints\`. Read \`after\` when present, otherwise \`before\`.

## Hints and what to do about them

\`npx threeforge explain <code> --json\` returns \`{ code, category, severity, meaning, fix, api, docs }\`.

| code | category | severity | fix |
|---|---|---|---|
${hintRows}

## Bake (opt in, verify by pixels)

\`--bake\` turns each finished static group into one mesh: seams between touching modules and duplicated faces
are removed and matching vertices welded. \`--bake-buried\` also removes faces with solid geometry within 0.1
units in front of them. A wrong deletion is visible and a missed one is invisible, so: run with \`--views 6\`,
read \`parity.views\` (every view must stay under the threshold) and \`compile.bake\` (seams, duplicates, buried,
welded counts). If a view changed, retry without \`--bake-buried\`, or exclude modules with
\`mesh.userData.forgeBake = false\` in the app. In code: \`new World(scene, { bake: true | { removeBuried, tolerance } })\`,
\`world.bakeDebug()\` returns the removed faces as meshes to render and screenshot.

## Budgets per device tier

Tiers are detected from the GPU and device (override with \`--tier\`). Defaults: scene submissions 400 / 150 / 80,
triangles 5 M / 1.5 M / 500 k, transparent overdraw 3 / 2 / 1.5 fragments per pixel, skinned vertices 400 k /
150 k / 60 k, shadow texels 4 M / 1 M / 262 k, textures 512 / 192 / 96 MB, frame 16.6 / 16.6 / 33 ms for
desktop / phone-mid / phone-low. In code: \`budgetsFor(tier, overrides)\`.

## MCP registration

Claude Code: \`claude mcp add threeforge -- npx threeforge mcp\`. Cursor / other clients: add a stdio server with
command \`npx\` and args \`["threeforge", "mcp"]\`.

## Programmatic use

\`\`\`ts
import { analyzeAsset, inspectApp, explain } from 'threeforge/cli';
const doc = await analyzeAsset({ file: 'scene.glb', backend: 'webgpu', tier: 'auto', budget: null, frames: 30, compile: true, timeout: 60000, headed: false });
\`\`\`

## Where to read more

\`docs/threeforge.md\` in the repository is the complete reference: every module, every option, and how each
mechanism works (ledger, registry, classification, compiler, bake, assembler, CLI, benchmark suite, three.js
findings). \`README.md\` is the overview; \`docs/bench.md\` the benchmark baselines.

## Rules the library expects of a scene

1. One material per surface type, shared (or registered through \`MaterialRegistry\`).
2. Tag meshes: \`tag.static(obj)\` for things that never move, \`tag.dynamic(obj)\` for the rest; or \`policy: 'auto'\`.
3. Never overwrite \`onBeforeRender\` on a \`BatchedMesh\` or an instanced object.
4. Judge by \`totals.sceneSubmissions\` and the six cost sections, never by \`renderer.info.render.calls\`.
`;

writeFileSync('AGENTS.md', body);
writeFileSync('docs/agents.md', body.replace('# threeforge for AI agents', '# threeforge for AI agents\n\n_Generated by `node scripts/agents-md.mjs`; the same text ships in the package as `AGENTS.md`._'));
writeFileSync(
  'llms.txt',
  `# threeforge

> Frame-budget compiler and diagnostics for three.js games. Batches naive scenes at load time, measures draw calls, overdraw, skinning, lighting, JS and memory in one ledger, explains what to fix. CLI and MCP server for AI agents.

- Quick start for agents: AGENTS.md (also printed by \`npx threeforge\`)
- Commands: analyze <file>, inspect <url>, explain <hint>, schema, mcp — all with --json
- JSON Schemas: \`npx threeforge schema\`
- Hint remedies: \`npx threeforge explain --all --json\`
- Complete reference (every module, option, mechanism): docs/threeforge.md
- Library API: README.md
- Benchmark suite and baselines: docs/bench.md
- Design: docs/superpowers/specs/2026-09-13-frame-budget-design.md, docs/superpowers/specs/2026-09-13-agent-cli-design.md
`,
);
console.log(`AGENTS.md, docs/agents.md, llms.txt written for ${VERSION} with ${Object.keys(REMEDIES).length} hint codes`);
