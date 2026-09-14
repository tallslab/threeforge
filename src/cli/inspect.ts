import type { CompileReport } from '../compiler/World.js';
import { VERSION } from '../version.js';
import { launchBrowser } from './browser.js';
import { Resources, type CliDeps } from './lifecycle.js';
import { evaluateWithin, measureViaHook, waitFor } from './measure.js';
import type { AgentDocument, InspectInput } from './types.js';
import { verdictOf } from './verdict.js';

/** `threeforge inspect <url>`: drive an app that called exposeToAgents(); optionally compile through its hook. */
export async function inspectApp(input: InspectInput, log: (line: string) => void = () => {}, deps: CliDeps = {}): Promise<AgentDocument> {
  const started = Date.now();
  const resources = new Resources();
  return resources.run(async () => {
    const browser = await (deps.launch ?? launchBrowser)(input.backend, input.headed);
    resources.add('the browser', () => browser.close());
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    log(`opening ${input.url} on ${input.backend}`);
    await page.goto(input.url, { timeout: input.timeout, waitUntil: 'domcontentloaded' });
    await waitFor(page, `!!(window.__threeforge && window.__threeforge.schemaVersion === 2)`, input.timeout, 'no window.__threeforge hook appeared: call exposeToAgents({ ledger, world, renderer, scene, camera }) in the app');
    log(`hook found; measuring ${input.frames} frames`);
    const before = await measureViaHook(page, input.frames, input.timeout);
    let after: AgentDocument['after'] = null;
    let compile: CompileReport | null = null;
    if (input.compile) {
      const canCompile = await evaluateWithin<boolean>(page, 'looking for compile()', input.timeout, `typeof window.__threeforge.compile === 'function'`);
      if (canCompile) {
        compile = await evaluateWithin<CompileReport>(page, 'compiling', input.timeout, `window.__threeforge.compile()`);
        log(`compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.skipped.length} skipped; measuring again`);
        await evaluateWithin(page, 'rendering 3 frames after compile', input.timeout, `(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`);
        after = (await measureViaHook(page, input.frames, input.timeout)).snapshot;
      } else log('the hook has no compile(): the app gave no World or already compiled');
    }
    if (pageErrors.length) log(`page errors: ${pageErrors.join(' | ')}`);
    const verdict = verdictOf(after, before.snapshot, input.budget, null);
    return {
      schemaVersion: 1,
      tool: 'threeforge',
      version: VERSION,
      command: 'inspect',
      input,
      env: before.snapshot.env,
      asset: null,
      before: before.snapshot,
      after,
      compile,
      parity: null,
      hints: (after ?? before.snapshot).hints,
      verdict,
      timings: { totalMs: Date.now() - started },
    } satisfies AgentDocument;
  });
}
