import type { FrameSnapshot } from '../ledger/snapshot.js';
import type { Parity, Verdict } from './types.js';
import { formatPageErrors } from './untrusted.js';

/** `1 page error: boom` or `7 page errors: a | b | c | d | e (+2 more)`, each error cleaned and capped by `formatPageErrors`. */
export function pageErrorsReason(errors: readonly string[]): string {
  return `${errors.length} page error${errors.length === 1 ? '' : 's'}: ${formatPageErrors(errors)}`;
}

/**
 * A run passes when it is within the budget, has no error-severity hint, (if measured) kept pixel parity and raised no
 * page error. `pageErrors` are the uncaught exceptions of the page that rendered the asset (`analyze`, and `optimize`
 * for each verified render); `inspect` passes none, its page being the user's own app. The reason quotes them cleaned
 * and capped, never raw.
 */
export function verdictOf(after: FrameSnapshot | null, before: FrameSnapshot, budget: number | null, parity: Parity | null, pageErrors: readonly string[] = []): Verdict {
  const frame = after ?? before;
  const reasons: string[] = [];
  const budgetResult = budget === null ? null : { maxSubmissions: budget, actual: frame.totals.sceneSubmissions, pass: frame.totals.sceneSubmissions <= budget };
  if (budgetResult && !budgetResult.pass) reasons.push(`${budgetResult.actual} scene submissions over the budget of ${budgetResult.maxSubmissions}`);
  const errors = frame.hints.filter((h) => h.severity === 'error').map((h) => h.code);
  for (const code of errors) reasons.push(`error hint ${code}`);
  if (parity && !parity.pass) reasons.push(`pixel parity ${parity.diffPct.toFixed(2)}% > ${parity.threshold}%`);
  if (pageErrors.length > 0) reasons.push(pageErrorsReason(pageErrors));
  return { pass: reasons.length === 0, budget: budgetResult, errors, reasons };
}

export function exitCodeOf(verdict: Verdict): 0 | 1 {
  return verdict.pass ? 0 : 1;
}
