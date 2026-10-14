import type { WorkbookCell, WorkbookRow } from '../models/workbook';
import type { TransactionDate } from '../models/generalLedger';
import { fromCents, toCents } from './money';

export function cellAt(row: WorkbookRow, index: number): WorkbookCell { return row.cells[index] ?? { value: null }; }
export function cellText(cell: WorkbookCell): string {
  return cell.value === null ? '' : typeof cell.value === 'string' ? cell.value : cell.formattedText ?? String(cell.value);
}
export function identifierText(cell: WorkbookCell): string {
  if (cell.error || cell.value === null || typeof cell.value === 'boolean') throw new TypeError('Identifier is missing or invalid.');
  const value = typeof cell.value === 'string' ? cell.value : cell.formattedText ?? String(cell.value);
  if (!value.trim()) throw new TypeError('Identifier is required.');
  return value;
}
export function monetaryValue(cell: WorkbookCell): number | undefined {
  if (cell.error) throw new TypeError('The monetary cell contains an Excel error.');
  if (cell.value === null || (typeof cell.value === 'string' && !cell.value.trim())) return undefined;
  if (typeof cell.value !== 'string' && typeof cell.value !== 'number') throw new TypeError('Invalid monetary cell.');
  return fromCents(toCents(cell.value));
}
export function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\u00a0-]+/g, ' ').replace(/\s*\/\s*/g, '/');
}
export function isBlankRow(row: WorkbookRow): boolean { return row.cells.every(cell => !cell.error && (cell.value === null || (typeof cell.value === 'string' && !cell.value.trim()))); }

export function dateFromCell(cell: WorkbookCell): TransactionDate | undefined {
  if (cell.error) return undefined;
  const value = cell.dateValue ?? (typeof cell.value === 'string' ? cell.value.trim() : '');
  let match: readonly string[] | null = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z?)?$/.exec(value);
  if (!match) {
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
    if (us) match = [us[0], us[3], us[1], us[2]];
  }
  if (!match) return undefined;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as TransactionDate;
}
