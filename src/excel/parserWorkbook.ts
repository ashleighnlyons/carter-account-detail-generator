import { read, utils, SSF } from 'xlsx';
import type { CellObject } from 'xlsx';
import type { ExcelExtension, ParserWorkbook, WorkbookCell, WorkbookMetadata } from '../models/workbook';
import { assertExcelSignature, WorkbookInputError } from './fileValidation';

function convertCell(cell: CellObject | undefined, date1904: boolean): WorkbookCell {
  if (!cell) return { value: null };
  if (cell.t === 'e') return { value: null, error: cell.w ?? 'Excel cell error', formula: cell.f };
  const value = typeof cell.v === 'string' || typeof cell.v === 'number' || typeof cell.v === 'boolean' ? cell.v : null;
  let dateValue: string | undefined;
  if (typeof value === 'number' && cell.z && SSF.is_date(cell.z)) {
    const parsed = SSF.parse_date_code(value, { date1904 });
    if (parsed) dateValue = `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  return { value, formattedText: cell.w, formula: cell.f, numberFormat: cell.z === undefined ? undefined : String(cell.z), dateValue };
}

/** Full source cells live only in the disposable worker or explicitly invoked developer tests. */
export function buildParserWorkbook(bytes: ArrayBuffer, metadata: Pick<WorkbookMetadata, 'fileName' | 'sizeBytes'> & { extension: ExcelExtension }): ParserWorkbook {
  assertExcelSignature(bytes, metadata.extension);
  try {
    const source = read(new Uint8Array(bytes), { type: 'array', cellNF: true, cellText: true, cellDates: false, cellFormula: true, cellHTML: false, bookVBA: false, bookFiles: false });
    if (!source.SheetNames?.length) throw new Error('No sheets');
    const date1904 = !!source.Workbook?.WBProps?.date1904;
    const sheets = source.SheetNames.map(name => {
      const sheet = source.Sheets[name];
      if (!sheet['!ref']) return { name, rows: [], mergedRanges: [] };
      // Ignore style-only inflated used ranges, while retaining internal blank row positions.
      let lastRow = -1, lastColumn = -1;
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith('!') || !cell || (cell.v === undefined && !cell.f) ||
          (typeof cell.v === 'string' && !cell.v.trim() && !cell.f)) continue;
        const position = utils.decode_cell(address);
        lastRow = Math.max(lastRow, position.r); lastColumn = Math.max(lastColumn, position.c);
      }
      if (lastRow < 0) return { name, rows: [], mergedRanges: [] };
      const range = { e: { r: lastRow, c: lastColumn } };
      if ((range.e.r + 1) * (range.e.c + 1) > 10_000_000) throw new WorkbookInputError('Workbook dimensions exceed the local processing safety limit. Re-export a compact ledger.');
      const rows = Array.from({ length: range.e.r + 1 }, (_value, rowIndex) => ({ sourceRowNumber: rowIndex + 1,
        cells: Array.from({ length: range.e.c + 1 }, (_value, columnIndex) => convertCell(sheet[utils.encode_cell({ r: rowIndex, c: columnIndex })] as CellObject | undefined, date1904)) }));
      return { name, rows, mergedRanges: (sheet['!merges'] ?? []).map(merge => ({ startRow: merge.s.r + 1, endRow: merge.e.r + 1, startColumn: merge.s.c + 1, endColumn: merge.e.c + 1 })) };
    });
    return { metadata: { ...metadata, sheetNames: [...source.SheetNames], sheetCount: source.SheetNames.length }, sheets };
  } catch (error) {
    if (error instanceof WorkbookInputError) throw error;
    throw new WorkbookInputError('The workbook could not be read. It may be damaged, encrypted, or unsupported. Try an unencrypted Excel export.');
  }
}
