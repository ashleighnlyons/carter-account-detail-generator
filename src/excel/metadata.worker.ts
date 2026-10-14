import { inspectWorkbook } from './inspectWorkbook';
import { buildParserWorkbook } from './parserWorkbook';
import { processParserWorkbook } from '../services/processWorkbook';
import { WorkbookInputError } from './fileValidation';
import type { ExcelExtension } from '../models/workbook';

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; extension: ExcelExtension; mode?: 'metadata' | 'trialBalance' | 'generalLedger'; fileName?: string; sizeBytes?: number }>) => {
  try {
    const { bytes, extension, mode } = event.data;
    if (!mode || mode === 'metadata') self.postMessage({ ok: true, metadata: inspectWorkbook(bytes, extension) });
    else {
      const workbook = buildParserWorkbook(bytes, { extension, fileName: event.data.fileName ?? '', sizeBytes: event.data.sizeBytes ?? bytes.byteLength });
      self.postMessage({ ok: true, result: await processParserWorkbook(workbook, mode) });
    }
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof WorkbookInputError ? error.message : 'The workbook could not be processed locally. Try an unencrypted Excel export.' });
  }
};
