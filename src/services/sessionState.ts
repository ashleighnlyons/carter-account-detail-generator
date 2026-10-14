import type { WorkbookMetadata } from '../models/workbook';
import type { AnalysisResult, DetectionSummary, TBParseResult, WorkbookProcessingResult } from '../models/processing';
import type { GLParseResult, ParserIssue } from '../parsers/types';
import { reconcileAccounts } from './reconcileAccounts';
import { demoLeadcodes } from '../test-fixtures/demoAccounts';

export type FileRole = 'trialBalance' | 'generalLedger';
export type FileSlot =
  | { readonly status: 'empty' }
  | { readonly status: 'reading'; readonly requestId: number }
  | { readonly status: 'ready'; readonly metadata: WorkbookMetadata }
  | { readonly status: 'error'; readonly message: string };
export interface SessionState {
  readonly files: Readonly<Record<FileRole, FileSlot>>;
  readonly demoVisible: boolean;
  readonly selectedLeadcodes: readonly string[];
  readonly search: string;
  readonly trialBalance?: TBParseResult;
  readonly generalLedger?: GLParseResult;
  readonly detection?: DetectionSummary;
  readonly analysis?: AnalysisResult;
  readonly processingErrors?: readonly ParserIssue[];
}
export function createInitialSession(): SessionState {
  return { files: { trialBalance: { status: 'empty' }, generalLedger: { status: 'empty' } }, demoVisible: false, selectedLeadcodes: [], search: '' };
}
export type SessionAction =
  | { type: 'fileStarted'; role: FileRole; requestId: number }
  | { type: 'fileReady'; role: FileRole; requestId: number; metadata: WorkbookMetadata; processing?: WorkbookProcessingResult }
  | { type: 'fileFailed'; role: FileRole; requestId: number; message: string }
  | { type: 'showDemo' }
  | { type: 'setSearch'; value: string }
  | { type: 'setSelection'; leadcodes: readonly string[] }
  | { type: 'reset' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'reset': return createInitialSession();
    case 'fileStarted': return {
      ...state, demoVisible: false, selectedLeadcodes: [], search: '',
      files: { ...state.files, [action.role]: { status: 'reading', requestId: action.requestId } },
      analysis: undefined, processingErrors: undefined,
      trialBalance: action.role === 'trialBalance' ? undefined : state.trialBalance,
      generalLedger: action.role === 'generalLedger' ? undefined : state.generalLedger,
      detection: action.role === 'generalLedger' ? undefined : state.detection,
    };
    case 'fileReady':
    case 'fileFailed': {
      const current = state.files[action.role];
      if (current.status !== 'reading' || current.requestId !== action.requestId) return state;
      let next: SessionState = { ...state, files: { ...state.files, [action.role]: action.type === 'fileReady'
        ? { status: 'ready', metadata: action.metadata } : { status: 'error', message: action.message } } };
      if (action.type === 'fileReady' && action.processing) {
        if (action.processing.role === 'trialBalance') next = { ...next, trialBalance: action.processing.tb };
        else next = { ...next, generalLedger: action.processing.gl, detection: action.processing.detection };
      }
      if (next.trialBalance && next.generalLedger && !next.trialBalance.errors.length && !next.generalLedger.errors.length && next.generalLedger.accountMatching?.status !== 'requiresConfirmation') {
        try { next = { ...next, analysis: reconcileAccounts(next.trialBalance.accounts, next.generalLedger.accountSummaries) }; }
        catch { next = { ...next, analysis: undefined, processingErrors: [{ code: 'MATCHING_REVIEW_REQUIRED', message: 'Account grouping or amounts require review before processing can continue.' }] }; }
      }
      return next;
    }
    case 'showDemo':
      if (Object.values(state.files).some(slot => slot.status !== 'empty')) return state;
      return { ...state, demoVisible: true };
    case 'setSearch': return { ...state, search: action.value };
    case 'setSelection': {
      const available = state.demoVisible ? demoLeadcodes : state.analysis?.leadcodes;
      if (!available) return state;
      const valid = new Set(available.map(group => group.leadcode));
      return { ...state, selectedLeadcodes: [...new Set(action.leadcodes)].filter(code => valid.has(code)) };
    }
  }
}
