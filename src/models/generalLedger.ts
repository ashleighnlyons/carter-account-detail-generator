export const PARSER_IDS = ['yardi', 'appfolio', 'onesite', 'firstservice', 'quickbooks', 'vantaca', 'custom'] as const;
export type ParserId = typeof PARSER_IDS[number];
/** Date-only, validated YYYY-MM-DD; avoids locale/timezone shifts. */
export type TransactionDate = `${number}-${number}-${number}`;
export type SourceFieldValue = string | number | boolean | null;

/** Arbitrary-depth source evidence; paths never become inferred CCH account numbers. */
export interface GLAccountHierarchy {
  readonly accountPath: readonly string[];
  /** One-based: root = 1. */
  readonly accountDepth: number;
  readonly parentAccountIdentifier?: string;
  readonly sourceHeadingRows: readonly number[];
  readonly sourceHeadingColumns: readonly number[];
}
/** Aggregate controls stay outside primary summaries to prevent double counting. */
export interface GLAccountControl {
  readonly accountIdentifier: string;
  readonly accountHierarchy: GLAccountHierarchy;
  readonly role: 'postingAccount' | 'parentAggregate' | 'postingAndParent';
  readonly beginningBalance?: number;
  readonly endingBalance?: number;
  readonly debit?: number;
  readonly credit?: number;
  readonly directTransactionCount: number;
  readonly descendantTransactionCount: number;
  readonly balanceControlsReliable: boolean;
  readonly sourceSheetName: string;
  readonly sourceHeadingRowNumber: number;
  readonly sourceTotalRowNumber?: number;
}

/** Source hierarchy is evidence, never an inferred TB mapping or synthetic account key. */
export interface GLSourceHierarchy {
  readonly parentAccountNumber: string;
  readonly parentAccountDescription?: string;
  readonly subaccountNumber?: string;
  readonly subaccountDescription?: string;
  readonly sourceParentHeadingRowNumber: number;
  readonly sourceSubaccountHeadingRowNumber: number;
}
/** Kept outside primary summaries to prevent parent/child balance double counting. */
export interface GLSubaccountSummary extends GLSourceHierarchy {
  readonly beginningBalance?: number;
  readonly endingBalance?: number;
  readonly transactionCount: number;
  readonly balanceControlsReliable: boolean;
  readonly sourceSheetName: string;
  readonly sourceHeadingText: string;
  readonly sourceTotalRowNumber?: number;
  readonly sourceEndingRowNumber?: number;
}

export interface GLTransaction {
  readonly accountNumber: string;
  readonly accountDescription?: string;
  readonly transactionDate?: TransactionDate;
  readonly transactionType?: string;
  readonly reference?: string;
  readonly payeeOrName?: string;
  readonly description?: string;
  readonly debit?: number;
  readonly credit?: number;
  /** Missing when the source does not support a reliable amount. */
  readonly netAmount?: number;
  readonly runningBalance?: number;
  readonly sourceFormat: ParserId;
  /** Physical Excel row, one-based, never an index after filtering. */
  readonly sourceRowNumber: number;
  readonly sourceSheetName: string;
  /** Original column labels (disambiguated when repeated), including extra source columns. */
  readonly sourceFields: Readonly<Record<string, SourceFieldValue>>;
  readonly sourceHierarchy?: GLSourceHierarchy;
  readonly accountHierarchy?: GLAccountHierarchy;
}

export interface GLAccountSummary {
  readonly accountNumber: string;
  readonly accountDescription?: string;
  readonly beginningBalance?: number;
  readonly endingBalance?: number;
  readonly transactionCount: number;
  readonly balanceValidationAvailable: boolean;
  readonly sourceSheetName?: string;
  readonly sourceHeadingRowNumber?: number;
  readonly sourceEndingRowNumber?: number;
  readonly accountHierarchy?: GLAccountHierarchy;
}
