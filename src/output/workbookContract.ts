import type { GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { AccountReconciliation } from '../models/reconciliation';
import type { ReportContext } from '../models/reportContext';
import type { GenerationCounts } from './generationIntegrity';

export const OUTPUT_CONTRACT = {
  summarySheetName: 'Summary',
  leadcodeSheetSections: ['GL Detail'],
  transactionColumns: ['Account Number', 'Account Description', 'Date', 'Reference', 'Name / Payee', 'Description', 'Debit', 'Credit', 'Balance'],
  transactionSort: ['accountNumber', 'transactionDate', 'reference'],
  sourceColumnsPosition: 'after-standard-columns-before-traceability',
  identifierCellType: 'text',
  sourceRowTraceability: ['Source GL Format', 'Source Worksheet', 'Source Row Number'],
  transactionHeaderRow: 1,
  transactionFirstDataRow: 2,
  excludeFromTransactions: ['beginning-balance', 'account-heading', 'subtotal', 'ending-balance'],
} as const;

export interface LeadcodeControl {
  readonly leadcode: string;
  readonly leadcodeDescription: string;
  readonly numberOfAccounts: number;
  readonly transactionCount?:number;
  readonly unadjustedTBBalance: number;
  readonly finalAdjustedTBBalance: number;
  readonly priorYearTBBalance?: number;
  readonly glEndingBalance?: number;
  readonly glVsUnadjustedTBDifference?: number;
  /** Final Adjusted TB minus Unadjusted TB. */
  readonly auditAdjustmentDifference: number;
}
export interface OutputAccountRow extends AccountReconciliation {
  readonly accountDescription: string;
  readonly unadjustedTB: number;
  readonly finalAdjustedTB: number;
  readonly priorYearFinalTB?: number;
  readonly auditAdjustmentDifference?: number;
}
export interface OutputSummaryRow extends LeadcodeControl {
  readonly matchedAccountCount: number;
  readonly unmatchedAccountCount: number;
  readonly transactionCount: number;
  readonly balanceStatus: AccountReconciliation['balanceStatus'];
  readonly warnings: readonly string[];
  readonly noActivityAccountCount?: number;
  readonly balanceUnavailableCount?: number;
  readonly balanceDifferenceCount?: number;
}
export interface LeadcodeWorksheetPlan {
  readonly sheetName: string;
  readonly control: LeadcodeControl;
  readonly accounts: readonly OutputAccountRow[];
  readonly transactions: readonly (GLTransaction & { readonly leadcode: string })[];
  readonly additionalSourceColumns: readonly string[];
  readonly additionalSourceValues?: readonly Readonly<Record<string, SourceFieldValue>>[];
}
/** Values-only production plan; Excel serialization remains behind the Excel abstraction. */
export interface AccountDetailWorkbookPlan {
  readonly summary: readonly OutputSummaryRow[];
  readonly leadcodeSheets: readonly LeadcodeWorksheetPlan[];
  readonly metadata?: {
    readonly generatedAt: string; readonly tbFileName: string; readonly glFileName: string;
    readonly tbFormat: string; readonly glFormat: string; readonly totalGLTransactions: number;
    readonly glOnlyAccountCount: number;
    readonly tbContext?:ReportContext;readonly glContext?:ReportContext;
    readonly displayEntity?:string;readonly displayPeriodEnd?:string;
    readonly scopeWarnings?:readonly string[];readonly expectedPopulation?:GenerationCounts;
    readonly applicationVersion?:string;
    readonly sourceWarnings: readonly {readonly source: string; readonly message: string; readonly sheet?: string; readonly row?: number}[];
  };
}
