import type { TBAccount } from '../models/trialBalance';
import type { GLAccountSummary } from '../models/generalLedger';
import { AccountMappingStatus } from '../models/reconciliation';

/** V1 is deliberately identity-only. No trim, punctuation removal, case folding or numeric conversion. */
export function normalizeAccountNumber(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Account identifiers must be text.');
  return value;
}

export interface AccountMatch {
  readonly status: AccountMappingStatus;
  readonly candidates: readonly GLAccountSummary[];
}

export function matchTBAccountToGLAccount(tb: TBAccount, glAccounts: readonly GLAccountSummary[]): AccountMatch {
  const identifier = normalizeAccountNumber(tb.accountNumber);
  if (identifier.trim().length === 0) return { status: AccountMappingStatus.Review, candidates: [] };
  const candidates = glAccounts.filter(gl => normalizeAccountNumber(gl.accountNumber) === identifier);
  if (candidates.length === 0) return { status: AccountMappingStatus.Unmatched, candidates };
  if (candidates.length > 1) return { status: AccountMappingStatus.Review, candidates };
  return {
    status: candidates[0].transactionCount === 0 ? AccountMappingStatus.NoActivity : AccountMappingStatus.Matched,
    candidates,
  };
}
