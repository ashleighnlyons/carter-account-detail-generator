import type { ParserId } from '../models/generalLedger';
import type { GLParser } from './types';

export function createStubParser(id: ParserId, displayName: string): GLParser {
  return {
    id, displayName, implemented: false,
    detect: () => ({ confidence: 0, reasons: ['Parser is reserved and not implemented in Phase 1.'] }),
    parse: async workbook => ({
      transactions: [], accountSummaries: [], warnings: [],
      errors: [{ code: 'PARSER_NOT_IMPLEMENTED', message: `${displayName} parsing is not implemented in Phase 1.` }],
      sourceMetadata: { parserId: id, workbook: workbook.metadata, parserVersion: '0.1.0-stub' },
    }),
  };
}
