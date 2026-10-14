export const AccountMappingStatus = {
  Matched: 'matched', Unmatched: 'unmatched', NoActivity: 'noActivity', Review: 'review',
} as const;
export type AccountMappingStatus = typeof AccountMappingStatus[keyof typeof AccountMappingStatus];

export const BalanceValidationStatus = {
  Agrees: 'agrees', Differs: 'differs', Unavailable: 'unavailable', NotTested: 'notTested',
} as const;
export type BalanceValidationStatus = typeof BalanceValidationStatus[keyof typeof BalanceValidationStatus];

export interface AccountReconciliation {
  readonly accountNumber: string;
  readonly mappingStatus: AccountMappingStatus;
  readonly balanceStatus: BalanceValidationStatus;
  readonly glEndingBalance?: number;
  /** GL ending balance minus Unadjusted TB, only when available. */
  readonly glVsUnadjustedDifference?: number;
}

/** Eligibility only: this does not calculate or assert that balances agree. */
export function initialBalanceStatus(available: boolean): BalanceValidationStatus {
  return available ? BalanceValidationStatus.NotTested : BalanceValidationStatus.Unavailable;
}
