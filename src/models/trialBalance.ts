/** Identifiers are source text, never numbers. Numeric source cells use their displayed text. */
export interface TBAccount {
  readonly accountNumber: string;
  readonly accountDescription: string;
  readonly leadcode: string;
  readonly leadcodeDescription: string;
  readonly unadjustedBalance: number;
  readonly finalAdjustedBalance: number;
  readonly priorYearFinalBalance: number;
  readonly sourceRowNumber?: number;
  readonly sourceSheetName?: string;
}

export const TB_COLUMNS = [
  'Account Number', 'Account Description', 'Leadcode', 'Leadcode Description',
  'Unadjusted Balance', 'Final Adjusted Balance', 'Prior-Year Final Balance',
] as const;
