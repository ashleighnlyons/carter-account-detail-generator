export type ExcelExtension = 'xlsx' | 'xlsm' | 'xlsb' | 'xls';
export interface WorkbookMetadata {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly extension: ExcelExtension;
  readonly sheetNames: readonly string[];
  readonly sheetCount: number;
}

/** Future parsers receive a library-independent workbook, supplied by the Excel adapter. */
export interface WorkbookCell {
  readonly value: string | number | boolean | null;
  readonly formattedText?: string;
  readonly formula?: string;
  readonly numberFormat?: string;
  readonly dateValue?: string;
  readonly error?: string;
}
export interface WorkbookRow {
  readonly sourceRowNumber: number;
  readonly cells: readonly WorkbookCell[];
}
export interface WorkbookSheet {
  readonly name: string;
  readonly rows: readonly WorkbookRow[];
  readonly mergedRanges?: readonly {
    readonly startRow: number;
    readonly endRow: number;
    readonly startColumn: number;
    readonly endColumn: number;
  }[];
}
export interface ParserWorkbook {
  readonly metadata: WorkbookMetadata;
  readonly sheets: readonly WorkbookSheet[];
}
