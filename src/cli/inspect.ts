import { VERSION } from '../version.js';
import { launchBrowser } from './browser.js';
import { type CliDeps, Resources, withTimeout } from './lifecycle.js';
import { assertHookVersion, compileViaHook, evaluateWithin, measureViaHook, waitFor } from './measure.js';
import type { AgentDocument, CliCompileReport, InspectInput } from './types.js';
import { formatPageErrors } from './untrusted.js';
import { verdictOf } from './verdict.js';

/** `threeforge inspect <url>`: drive an app that called exposeToAgents(); optionally compile through its hook. */
export async function inspectApp(
  input: InspectInput,
  log: (line: string) => void = () => {},
  deps: CliDeps = {},
): Promise<AgentDocument> {
  const started = Date.now();
  const resources = new Resources();
  resources.armAbort(deps.signal);
  return resources.run(async () => {
    const browser = await (deps.launch ?? launchBrowser)(input.backend, input.headed);
    resources.add('the browser', () => browser.close());
    // Bounded like every other page step: an unbounded `newPage()` is a wait `--timeout` cannot shorten (M2).
    const page = await withTimeout('opening a browser page', input.timeout, () => browser.newPage());
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    log(`opening ${input.url} on ${input.backend}`);
    await page.goto(input.url, { timeout: input.timeout, waitUntil: 'domcontentloaded' });
    await waitFor(
      page,
      `!!window.__threeforge`,
      input.timeout,
      'no window.__threeforge hook appeared: call exposeToAgents({ ledger, world, renderer, scene, camera }) in the app',
    );
    // Before anything is measured or formatted: an older app's snapshot lacks fields this CLI reads.
    await assertHookVersion(page, input.timeout);
    log(`hook found; measuring ${input.frames} frames`);
    const before = await measureViaHook(page, input.frames, input.timeout);
    let after: AgentDocument['after'] = null;
    let compile: CliCompileReport | null = null;
    if (input.compile) {
      const canCompile = await evaluateWithin<boolean>(
        page,
        'looking for compile()',
        input.timeout,
        `typeof window.__threeforge.compile === 'function'`,
      );
      if (canCompile) {
        compile = await compileViaHook(page, input.timeout);
        log(
          `compiled: ${compile.after.batches} batches, ${compile.after.instanced} instanced, ${compile.skippedCount} skipped; measuring again`,
        );
        await evaluateWithin(
          page,
          'rendering 3 frames after compile',
          input.timeout,
          `(async () => { for (let i = 0; i < 3; i++) await window.__threeforge.frameAsync(); })()`,
        );
        after = (await measureViaHook(page, input.frames, input.timeout)).snapshot;
      } else log('the hook has no compile(): the app gave no World or already compiled');
    }
    if (pageErrors.length) log(`page errors: ${formatPageErrors(pageErrors)}`);
    const verdict = verdictOf(after, before.snapshot, input.budget, null);
    return {
      schemaVersion: 2,
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
