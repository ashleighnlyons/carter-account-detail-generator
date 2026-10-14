import type { TBAccount } from '../models/trialBalance';
import type { GLAccountSummary } from '../models/generalLedger';
import { normalizeAccountNumber } from '../utils/accountMatching';
/** Exact source-key coverage only; never establishes the correct CCH matching level or reconciliation. */
export function sourceIdentifierCoverage(tb: readonly TBAccount[], gl: readonly GLAccountSummary[]) {
  const tbKeys = new Set(tb.map(a => normalizeAccountNumber(a.accountNumber)));
  const glKeys = new Set(gl.map(a => normalizeAccountNumber(a.accountNumber)));
  return { glOnlyIdentifierCount: [...glKeys].filter(key => !tbKeys.has(key)).length };
}
