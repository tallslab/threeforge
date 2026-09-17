import { buildDocument, compileAndRemeasure, openPage } from './document.js';
import { type CliDeps, Resources } from './lifecycle.js';
import { assertHookVersion, evaluateWithin, measureViaHook, waitFor } from './measure.js';
import type { AgentDocument, CliCompileReport, InspectInput } from './types.js';
import { formatPageErrors } from './untrusted.js';

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
    const { page, pageErrors } = await openPage(resources, input, deps);
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
      if (canCompile) ({ compile, after } = await compileAndRemeasure(page, input, log));
      else log('the hook has no compile(): the app gave no World or already compiled');
    }
    if (pageErrors.length) log(`page errors: ${formatPageErrors(pageErrors)}`);
    return buildDocument({
      command: 'inspect',
      input,
      asset: null,
      before: before.snapshot,
      after,
      compile,
      parity: null,
      started,
    });
  });
}
