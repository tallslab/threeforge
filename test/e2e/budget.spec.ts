import { expect, test } from './fixtures.js';

/** The CI gate: `pnpm budget` (FORGE_BUDGET overrides the limit, default 30). */
const BUDGET = Number(process.env.FORGE_BUDGET ?? 30);

test(`the compiled naive scene stays within ${BUDGET} scene submissions`, async ({ forge }) => {
  await forge.open('naive', { compile: '1' });
  const { budget, report } = await forge.page.evaluate((max) => {
    const f = window.__forge;
    f.frame();
    return { budget: f.ledger.budget({ maxSubmissions: max }), report: f.ledger.report() };
  }, BUDGET);
  console.log(report);
  console.log(`FORGE_BUDGET ${budget.actual}/${budget.max} ${budget.pass ? 'PASS' : 'FAIL'}`);
  expect(budget.pass, `over budget: ${budget.actual} > ${budget.max}; top offenders ${JSON.stringify(budget.offenders.slice(0, 3))}`).toBe(true);
});
