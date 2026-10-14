import type { ExcelExtension } from '../models/workbook';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const EXCEL_ACCEPT = '.xlsx,.xlsm,.xlsb,.xls';
export class WorkbookInputError extends Error {}

export function validateExcelFile(file: Pick<File, 'name' | 'size'>): ExcelExtension {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !['xlsx', 'xlsm', 'xlsb', 'xls'].includes(extension)) {
    throw new WorkbookInputError('Choose an Excel workbook (.xlsx, .xlsm, .xlsb, or .xls).');
  }
  if (file.size === 0) throw new WorkbookInputError('The file is empty. Choose a workbook with content.');
  if (file.size > MAX_FILE_BYTES) throw new WorkbookInputError('The file exceeds the 25 MB input limit. Ask for a smaller Excel export that preserves the required account detail.');
  return extension as ExcelExtension;
}

export function assertExcelSignature(bytes: ArrayBuffer, extension: ExcelExtension): void {
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const isOle = header.length === 8 && ole.every((value, index) => header[index] === value);
  const isZip = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
  if ((extension === 'xls' && !isOle) || (extension !== 'xls' && !isZip)) {
    throw new WorkbookInputError('File contents do not match a supported Excel workbook. Re-export the workbook from Excel.');
  }
}
