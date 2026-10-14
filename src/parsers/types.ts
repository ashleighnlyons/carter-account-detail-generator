import type { GLTransaction, GLAccountSummary, GLSubaccountSummary, GLAccountControl, ParserId, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookMetadata, ExcelExtension } from '../models/workbook';
import type { ReportContext } from '../models/reportContext';

export interface ParserIssue {
  readonly code: string;
  readonly message: string;
  readonly sourceSheetName?: string;
  readonly sourceRowNumber?: number;
}
export interface ParserDetection {
  /** Finite 0–1 score. Zero means no recognition evidence. */
  readonly confidence: number;
  readonly reasons: readonly string[];
}
export interface GLParseResult {
  readonly transactions: readonly GLTransaction[];
  readonly accountSummaries: readonly GLAccountSummary[];
  readonly subaccountSummaries?: readonly GLSubaccountSummary[];
  readonly accountControls?: readonly GLAccountControl[];
  /** Parsing success is independent of whether the source account level is proven against CCH. */
  readonly accountMatching?: {
    readonly status: 'requiresConfirmation';
    readonly sourceIdentifierDescription: string;
    readonly reason: string;
  };
  readonly warnings: readonly ParserIssue[];
  readonly errors: readonly ParserIssue[];
  readonly sourceMetadata: {
    readonly parserId: ParserId;
    readonly workbook: WorkbookMetadata;
    readonly parserVersion: string;
    /** Local report-level fields (e.g. entity/scope); never logged or persisted. */
    readonly reportFields?: Readonly<Record<string, SourceFieldValue>>;
    readonly reportContext?:ReportContext;
  };
  readonly diagnostics?: GLParserDiagnostics;
}
export type SkippedRowCategory = 'reportHeader' | 'columnHeader' | 'accountHeading' | 'beginningBalance' | 'endingBalance' | 'subtotal' | 'blank' | 'reportFooter' | 'review';
export interface GLParserDiagnostics {
  readonly workbookType?: ExcelExtension;
  readonly controlHeaderRowNumber?: number;
  readonly detectedSheet: string;
  readonly headerRowNumber: number;
  readonly accountHeadingRows: readonly number[];
  readonly endingBalanceRows: readonly number[];
  /** May overlap heading/ending rows when one physical row supplies several controls. */
  readonly beginningBalanceRows?: readonly number[];
  readonly subtotalRows?: readonly number[];
  readonly repeatedHeaderCount?: number;
  readonly subaccountHeadingRows?: readonly number[];
  readonly subaccountTotalRows?: readonly number[];
  readonly subaccountEndingRows?: readonly number[];
  readonly mainAccountTotalRows?: readonly number[];
  readonly reportTotalRows?: readonly number[];
  readonly ambiguousHierarchyRows?: readonly number[];
  readonly skippedRows: Readonly<Record<SkippedRowCategory, number>>;
  readonly transactionCount: number;
  readonly endingBalanceCount: number;
  readonly reliableEndingBalanceCount: number;
  readonly warningCount: number;
  readonly numericIdentifierCount?: number;
  readonly hierarchyLevels?: number;
  readonly postingAccountCount?: number;
  readonly parentControlAccountCount?: number;
  readonly accountTotalRows?: readonly number[];
  readonly parentTotalRows?: readonly number[];
  readonly derivedEndingBalanceCount?: number;
  readonly sourceControlTotals?: {
    readonly debit: number; readonly credit: number;
    readonly parsedDebit: number; readonly parsedCredit: number;
    readonly endingBalance?: number; readonly primaryEndingBalance?: number;
    readonly activityAgrees: boolean; readonly endingBalancesAgree?: boolean;
    readonly beginningBalance?: number; readonly primaryBeginningBalance?: number;
    readonly beginningBalancesAgree?: boolean;
  };
}
export interface GLParser {
  readonly id: ParserId;
  readonly displayName: string;
  readonly implemented: boolean;
  detect(workbook: ParserWorkbook): ParserDetection;
  parse(workbook: ParserWorkbook): Promise<GLParseResult>;
}
