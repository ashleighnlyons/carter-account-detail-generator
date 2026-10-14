import type { TBAccount } from './trialBalance';
import type { WorkbookMetadata } from './workbook';
import type { GLParseResult, ParserIssue } from '../parsers/types';
import type { ParserId } from './generalLedger';
import type { AccountReconciliation } from './reconciliation';
import type { LeadcodeGroup } from './leadcode';
import type { ReportContext } from './reportContext';

export interface TBParseResult {
  readonly reportContext?:ReportContext;
  readonly accounts: readonly TBAccount[];
  readonly warnings: readonly ParserIssue[];
  readonly errors: readonly ParserIssue[];
  readonly diagnostics: { readonly detectedSheet?: string; readonly headerRowNumber?: number; readonly accountCount: number; readonly reviewedRows: readonly number[];
    readonly format?: 'published-cch' | 'flat' | 'unknown'; readonly confidence?: number; readonly detectionReasons?: readonly string[];
    readonly skippedRows?: Readonly<Record<string, number>>; readonly sourceColumns?: Readonly<Record<string, number>> };
}
export interface DetectionSummary {
  readonly parserId: ParserId;
  readonly displayName?: string;
  readonly confidence: number;
  readonly recognized: boolean;
  readonly reasons: readonly string[];
}
export type WorkbookProcessingResult =
  | { readonly role: 'trialBalance'; readonly metadata: WorkbookMetadata; readonly tb: TBParseResult }
  | { readonly role: 'generalLedger'; readonly metadata: WorkbookMetadata; readonly gl: GLParseResult; readonly detection: DetectionSummary };

export interface ReconciledAccount extends AccountReconciliation {
  readonly tb: TBAccount;
  readonly unadjustedTB: number;
  readonly finalAdjustedTB: number;
  readonly auditAdjustmentDifference: number;
  readonly transactionCount: number;
}
export interface AnalysisResult {
  readonly accounts: readonly ReconciledAccount[];
  readonly leadcodes: readonly LeadcodeGroup[];
  readonly warnings: readonly ParserIssue[];
  readonly matchedAccountCount: number;
  readonly unmatchedAccountCount: number;
  /** Distinct GL identifiers with no exact authoritative TB mapping. */
  readonly glOnlyAccountCount: number;
  readonly availableBalanceCount: number;
  readonly noActivityAccountCount: number;
  readonly reviewAccountCount: number;
  readonly unavailableBalanceCount: number;
  readonly differingBalanceCount: number;
  readonly transactionCount: number;
}
