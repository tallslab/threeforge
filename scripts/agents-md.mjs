// Generates AGENTS.md, llms.txt and docs/agents.md from the built remedy table and command specs so the hint list,
// the command table and the flag table never drift. Run after `pnpm build:lib`: node scripts/agents-md.mjs
import { writeFileSync } from 'node:fs';
import { COMMAND_SPECS, flagForms, usageLine } from '../dist/cli/args.js';
import { REMEDIES } from '../dist/cli/explain.js';
import { DATA_NOTE } from '../dist/cli/mcp.js';
import { VERSION } from '../dist/version.js';

const hintRows = Object.values(REMEDIES)
  .map((r) => `| \`${r.code}\` | ${r.category} | ${r.severity} | ${r.fix} |`)
  .join('\n');

/** Table cells: a literal `|` would end the cell. */
const cell = (text) => text.replaceAll('|', '\\|');

/** What each command does, in the command table. The usage column comes from COMMAND_SPECS. */
const COMMAND_DESCRIPTIONS = {
  analyze:
    'Renders the asset headlessly, measures every cost category, compiles (batches, or bakes with `--bake`) it, measures again, checks pixel parity from the default framing plus `--views` orbit views, returns hints and a verdict.',
  inspect:
    'Drives your running app (dev server) through `window.__threeforge`, compiling through the hook unless `--no-compile`; same document without asset facts and parity. The app measures itself at the tier its ledger detects, so there is no `tier` flag here.',
  optimize:
    'Rewrites the asset with glTF-Transform and writes `<name>.forge.glb`. `safe` (default) never changes a pixel, and no step in it costs bytes: dedup, palette, prune. `balanced` adds weld, resample, quantize and WebP textures (2048 px); `aggressive` adds simplify to 50 % and 1024 px textures. Renders the original and the result, compares pixels, compiles both, and lists what the file needs at load time (`requires`).',
  explain: 'What a hint means, what to change, which API (a hint code or `--all`, not both).',
  schema: 'JSON Schemas (draft 2020-12) of everything the commands print.',
  mcp: 'Stdio MCP server with tools `analyze_asset`, `inspect_app`, `optimize_asset`, `explain_hint` (needs `npm i -D @modelcontextprotocol/sdk zod`).',
  decoders: "Copies three's Draco decoder and Basis transcoder into `<dir>/draco` and `<dir>/basis` for `createLoader(renderer, { decoders })`. No JSON output.",
};

const specs = Object.values(COMMAND_SPECS);
for (const spec of specs) if (!COMMAND_DESCRIPTIONS[spec.name]) throw new Error(`scripts/agents-md.mjs: no description for command ${spec.name}`);

const commandRows = specs.map((spec) => `| \`npx ${cell(usageLine(spec))}\` | ${COMMAND_DESCRIPTIONS[spec.name]} |`).join('\n');

// One row per distinct flag (same forms and meaning), listing every command that takes it.
const flagRowsByKey = new Map();
for (const spec of specs) {
  for (const flag of spec.flags) {
    const forms = flagForms(flag);
    const key = `${forms.join(' ')} :: ${flag.description}`;
    const row = flagRowsByKey.get(key) ?? { forms, description: flag.description, commands: [] };
    row.commands.push(spec.name);
    flagRowsByKey.set(key, row);
  }
}
const flagRows = [...flagRowsByKey.values()].map((row) => `| ${row.forms.map((form) => `\`${cell(form)}\``).join(', ')} | ${row.commands.join(', ')} | ${cell(row.description)} |`).join('\n');

const body = `# threeforge for AI agents

threeforge ${VERSION} is a frame-budget compiler and diagnostics layer for three.js games (r186, WebGPU with a
WebGL2 fallback). This file is what \`npx threeforge\` prints. Everything below is scriptable from a terminal and
prints JSON with \`--json\`.

## Install

\`\`\`bash
npm i -D threeforge playwright && npx playwright install chromium
\`\`\`

Playwright is only needed for \`analyze\`, \`inspect\`, \`optimize\` (its verification) and \`mcp\`; the library itself has no
such dependency. \`optimize\` works out of the box (glTF-Transform is a dependency); texture compression needs
\`npm i -D sharp\` and a Draco-compressed input needs \`npm i -D draco3dgltf\`.

## Commands

| command | what it does |
|---|---|
${commandRows}

Exit codes: \`0\` pass · \`1\` verdict failed (over budget, an error-severity hint, pixel parity lost, or a page error during
\`analyze\`/\`optimize\`) · \`2\` usage or
input error · \`3\` environment (Playwright or Chromium missing; the message has the install command) · \`4\` the page
threw or timed out. In \`--json\` mode stdout is only the JSON document; the human summary goes to stderr.

## Flags

Flags follow the command, before or after its argument. A value is \`--flag value\` or \`--flag=value\`; boolean flags
never take one, so \`analyze --json scene.glb\` works. \`--simplify\` and \`--textures\` take a value only after \`=\` or
when the next argument is a valid value. \`--\` ends the flags (for a path that starts with \`-\`). \`--help\` on any
command prints this file. An unknown flag (the message suggests the nearest one), an extra argument, a flag given twice,
a malformed or out-of-range number, \`inspect --tier\` and \`optimize --budget\` with \`--no-verify\` exit \`2\` with
nothing on stdout.

| flag | commands | meaning |
|---|---|---|
${flagRows}

## Make your app inspectable (one line)

\`\`\`ts
import { DrawCallLedger, MaterialRegistry, World, exposeToAgents, tag } from 'threeforge';

const registry = new MaterialRegistry();
const ledger = new DrawCallLedger({ registry });
ledger.attach(renderer);
const world = new World(scene, { registry, ledger, policy: 'auto' });
if (import.meta.env.DEV) exposeToAgents({ ledger, world, renderer, scene, camera }); // publishes window.__threeforge
\`\`\`

Then \`npx threeforge inspect http://localhost:5173 --json\` (it compiles through the hook; \`--no-compile\` measures
only). The hook offers \`frame()\`, \`frameAsync()\`, \`compile()\`, \`decompile()\`, \`measureOverdraw()\`, \`measureMemory()\`,
\`hints()\`, \`report()\`; an agent driving its own browser can call them directly. It also lets *any* script on the
page — a browser extension, a third-party tag, an XSS payload — call \`compile()\`/\`decompile()\` and read the ledger,
so publish it only in a development build or behind your own flag; \`import.meta.env.DEV\` is Vite's dev check,
other bundlers need their own.

## The document you get back

\`\`\`json
{
  "schemaVersion": 2, "tool": "threeforge", "version": "${VERSION}", "command": "analyze",
  "input": { "file": "scene.glb", "backend": "webgpu", "tier": "phone-mid", "budget": null, "frames": 30, "compile": true },
  "env": { "three": "186", "backend": "webgpu", "gpu": "apple metal-3", "tier": "phone-mid" },
  "asset": { "meshes": 12, "materials": 5, "vertices": 40210, "triangles": 38000, "animations": 1, "skinned": 1, "morph": 0, "loadMs": 120 },
  "before": { "totals": { "sceneSubmissions": 503 }, "overdraw": {}, "skinning": {}, "lighting": {}, "js": {}, "memory": {}, "hints": [] },
  "after":  { "totals": { "sceneSubmissions": 28 } },
  "compile": { "after": { "batches": 15, "instanced": 0, "meshes": 13 }, "skipped": [{ "path": "player", "rule": "skinned-mesh" }] },
  "parity": { "diffPct": 0.01, "threshold": 0.5, "pass": true, "views": [{ "view": "default", "diffPct": 0.01, "changedPixels": 92 }] },
  "hints": [{ "category": "lighting", "severity": "warn", "code": "point-light-shadow", "message": "...", "objects": ["lamp"] }],
  "verdict": { "pass": true, "budget": null, "errors": [], "reasons": [] },
  "timings": { "totalMs": 4200 }
}
\`\`\`

\`before\` and \`after\` are full snapshots (\`npx threeforge schema snapshot\`): draw calls by reason, measured
overdraw (fragments per pixel, opaque and transparent), skinning, lighting and shadow texels, JS timings, memory
estimate, and \`hints\`. Read \`after\` when present, otherwise \`before\`.

## Untrusted content in a document

${DATA_NOTE}

Names and messages are capped (120 and 300 characters); an \`inspect\` page snapshot is additionally cleaned of
ANSI escapes, control characters and bidi/zero-width formatting characters, and capped in string and array size,
because its target is any page, not only one built with threeforge. The MCP tools \`analyze_asset\`, \`inspect_app\`
and \`optimize_asset\` return this same paragraph as a second \`content\` block after the JSON; \`explain_hint\`'s
result carries no asset or page text, so it has no such block.

## Hints and what to do about them

\`npx threeforge explain <code> --json\` returns \`{ code, category, severity, meaning, fix, api, docs }\`.

| code | category | severity | fix |
|---|---|---|---|
${hintRows}

## Bake (opt in, verify by pixels)

\`--bake\` turns each finished static group into one mesh: seams between touching modules and duplicated faces
are removed and matching vertices welded. \`--bake-buried\` also removes faces with solid geometry within 0.1
units in front of them. A wrong deletion is visible and a missed one is invisible, so: run with \`--views 6\`,
read \`parity.views\` (every view must stay under the threshold; its \`changedPixels\` is the exact count behind the
rounded \`diffPct\`, and only \`changedPixels: 0\` means no pixel moved) and \`compile.bake\` (seams, coincident faces kept,
duplicates, buried, welded counts). If a view changed, retry without \`--bake-buried\`, or exclude modules with
\`mesh.userData.forgeBake = false\` in the app. In code: \`new World(scene, { bake: true | { removeBuried, tolerance } })\`,
\`world.bakeDebug()\` returns the removed faces as meshes to render and screenshot.

## Optimize assets at build time

\`npx threeforge optimize scene.glb --json\` → \`scene.forge.glb\`. Read \`steps\` (what each step changed), \`requires\`
(loader code to add, e.g. \`loader.setMeshoptDecoder(MeshoptDecoder)\` after \`--compress meshopt\`), \`verify.parity\`
(original vs optimized render, per view) and \`verify.delta\` (bytes, materials, submissions naive and compiled, load ms).
Steps in order: dedup, instance, palette, flatten, join, weld, simplify, resample, prune, textures, quantize, meshopt;
\`--no-<step>\` removes one, \`--<step>\` adds one. \`--instance\`, \`--join\` and \`--compress meshopt\` are never defaults: the
first two change the node graph your code may address by name, the third needs a decoder. The verdict fails when the
pixels moved past \`--parity\`, when a clip, skin or morph target was lost, when the optimized file fails \`--budget\`, or
when either render raised a page error; size and count deltas are reported, not judged. If parity fails, go back to
\`--preset safe\` or raise \`--parity\` only after looking at the views. The output never uses Draco. An image or buffer
URI that is absolute, has a scheme other than \`data:\`, or leads outside the input's directory (symlinks included)
exits \`2\` before anything is read, as does an \`--out\` that is the input file or does not end in \`.glb\`/\`.gltf\`, and
a \`.gltf\` output whose resources would overwrite the input's own (write it to another directory, or as \`.glb\`).
Not covered: atlasing textured materials, KTX2 encoding.

## Budgets per device tier

Tiers are detected from the GPU and device (override with \`--tier\` on \`analyze\` and \`optimize\`; \`inspect\` measures
the app at the tier its own ledger detects). Defaults: scene submissions 400 / 150 / 80,
triangles 5 M / 1.5 M / 500 k, transparent overdraw 3 / 2 / 1.5 fragments per pixel, skinned vertices 400 k /
150 k / 60 k, shadow texels 4 M / 1 M / 262 k, textures 512 / 192 / 96 MB, frame 16.6 / 16.6 / 33 ms for
desktop / phone-mid / phone-low. In code: \`budgetsFor(tier, overrides)\`.

## MCP registration

Claude Code: \`claude mcp add threeforge -- npx threeforge mcp\`. Cursor / other clients: add a stdio server with
command \`npx\` and args \`["threeforge", "mcp"]\`.

## Programmatic use

\`\`\`ts
import { analyzeAsset, inspectApp, optimizeAsset, explain } from 'threeforge/cli';
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
- Commands: ${specs.map((spec) => [spec.name, ...spec.positionals.map((p) => p.usage.startsWith('<') ? p.usage : `[${p.usage}]`)].join(' ')).join(', ')}; analyze, inspect, optimize, explain and schema take --json; unknown flags exit 2
- JSON Schemas: \`npx threeforge schema\`
- Hint remedies: \`npx threeforge explain --all --json\`
- Complete reference (every module, option, mechanism): docs/threeforge.md
- Library API: README.md
- Benchmark suite and baselines: docs/bench.md
- Design: docs/superpowers/specs/2026-09-13-frame-budget-design.md, docs/superpowers/specs/2026-09-13-agent-cli-design.md, docs/superpowers/specs/2026-09-14-optimize-command-design.md
`,
);
console.log(`AGENTS.md, docs/agents.md, llms.txt written for ${VERSION} with ${Object.keys(REMEDIES).length} hint codes, ${specs.length} commands and ${flagRowsByKey.size} flag rows`);
