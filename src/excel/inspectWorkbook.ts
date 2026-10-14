import { read } from 'xlsx';
import type { ExcelExtension } from '../models/workbook';
import { assertExcelSignature, WorkbookInputError } from './fileValidation';

/** Only the worker/test layer imports SheetJS. No rows or formulas enter application state. */
export function inspectWorkbook(bytes: ArrayBuffer, extension: ExcelExtension): { sheetNames: string[]; sheetCount: number } {
  assertExcelSignature(bytes, extension);
  try {
    const workbook = read(new Uint8Array(bytes), {
      type: 'array', bookSheets: true, bookProps: false, bookVBA: false,
      bookFiles: false, cellFormula: false, cellHTML: false, cellStyles: false,
    });
    if (!workbook.SheetNames?.length) throw new Error('Missing worksheet directory.');
    return { sheetNames: [...workbook.SheetNames], sheetCount: workbook.SheetNames.length };
  } catch {
    // Never log a library exception, which may contain source values.
    throw new WorkbookInputError('The workbook could not be inspected. It may be damaged, encrypted, or unsupported. Try an unencrypted Excel export.');
  }
}
