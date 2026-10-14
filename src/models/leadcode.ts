import type { TBAccount } from './trialBalance';
import type { BalanceValidationStatus } from './reconciliation';
import type { ReconciledAccount } from './processing';

export interface LeadcodeGroup {
  readonly leadcode: string;
  readonly leadcodeDescription: string;
  readonly descriptionConflict?: boolean;
  readonly accountCount: number;
  readonly accounts: readonly TBAccount[];
  readonly unadjustedTBBalance: number;
  readonly finalAdjustedTBBalance: number;
  readonly priorYearTBBalance: number;
  /** Undefined until mapping and transaction processing actually run. */
  readonly matchedAccountCount?: number;
  readonly unmatchedAccountCount?: number;
  readonly transactionCount?: number;
  readonly reconciliationStatus: BalanceValidationStatus;
  readonly glEndingBalance?: number;
  readonly glVsUnadjustedDifference?: number;
  readonly auditAdjustmentDifference?: number;
  readonly noActivityAccountCount?: number;
  readonly reviewAccountCount?: number;
  readonly balanceUnavailableCount?: number;
  readonly balanceDifferenceCount?: number;
  readonly accountReconciliations?: readonly ReconciledAccount[];
}
