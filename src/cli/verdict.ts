import type { FrameSnapshot } from '../ledger/snapshot.js';
import type { Parity, Verdict } from './types.js';

/** A run passes when it is within the budget, has no error-severity hint and (if measured) kept pixel parity. */
export function verdictOf(after: FrameSnapshot | null, before: FrameSnapshot, budget: number | null, parity: Parity | null): Verdict {
  const frame = after ?? before;
  const reasons: string[] = [];
  const budgetResult = budget === null ? null : { maxSubmissions: budget, actual: frame.totals.sceneSubmissions, pass: frame.totals.sceneSubmissions <= budget };
  if (budgetResult && !budgetResult.pass) reasons.push(`${budgetResult.actual} scene submissions over the budget of ${budgetResult.maxSubmissions}`);
  const errors = frame.hints.filter((h) => h.severity === 'error').map((h) => h.code);
  for (const code of errors) reasons.push(`error hint ${code}`);
  if (parity && !parity.pass) reasons.push(`pixel parity ${parity.diffPct.toFixed(2)}% > ${parity.threshold}%`);
  return { pass: reasons.length === 0, budget: budgetResult, errors, reasons };
}

export function exitCodeOf(verdict: Verdict): 0 | 1 {
  return verdict.pass ? 0 : 1;
}
