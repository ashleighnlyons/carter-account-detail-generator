import type { WorkbookMetadata } from '../models/workbook';
import { validateExcelFile, WorkbookInputError } from './fileValidation';
import type { WorkbookProcessingResult } from '../models/processing';

function readBytes(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const abort = () => {
      reader.abort();
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => { const bytes = reader.result as ArrayBuffer; cleanup(); resolve(bytes); };
    reader.onerror = () => { cleanup(); reject(new WorkbookInputError('The file could not be read locally. Choose it again.')); };
    reader.readAsArrayBuffer(file);
  });
}

/** One disposable local worker per inspection; no files, buffers or workbook objects are cached. */
interface WorkerReply {
  ok: boolean;
  metadata?: { sheetNames: string[]; sheetCount: number };
  result?: WorkbookProcessingResult;
  message?: string;
}

async function executeWorkbookRequest(file: File, signal: AbortSignal, mode: 'metadata' | 'trialBalance' | 'generalLedger'): Promise<WorkerReply> {
  const extension = validateExcelFile(file);
  const bytes = await readBytes(file, signal);
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./metadata.worker.ts', import.meta.url), { type: 'module' }); }
    catch { reject(new WorkbookInputError('This browser could not start local workbook inspection. Use a current browser.')); return; }
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null;
      worker.terminate();
    };
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timeout = setTimeout(() => {
      cleanup(); reject(new WorkbookInputError('Workbook inspection timed out. Try a smaller, unencrypted export.'));
    }, mode === 'metadata' ? 15000 : 60000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      cleanup();
      if (!event.data.ok || (mode === 'metadata' ? !event.data.metadata : !event.data.result)) {
        reject(new WorkbookInputError(event.data.message ?? 'Workbook inspection failed.')); return;
      }
      resolve(event.data);
    };
    worker.onerror = event => {
      event.preventDefault(); cleanup(); reject(new WorkbookInputError('Local workbook inspection failed. Try a smaller Excel export.'));
    };
    try { worker.postMessage({ bytes, extension, mode, fileName: file.name, sizeBytes: file.size }, [bytes]); }
    catch { cleanup(); reject(new WorkbookInputError('The workbook could not be passed to the local reader.')); }
  });
}

/** Preserved Phase 1 inspection contract for metadata-only consumers and lifecycle tests. */
export async function readWorkbookMetadata(file: File, signal: AbortSignal): Promise<WorkbookMetadata> {
  const result = await executeWorkbookRequest(file, signal, 'metadata');
  return { fileName: file.name, sizeBytes: file.size, extension: validateExcelFile(file), ...result.metadata! };
}
/** Worker returns standardized records, issues and diagnostics; raw workbook objects are discarded. */
export async function processWorkbookFile(file: File, role: 'trialBalance' | 'generalLedger', signal: AbortSignal): Promise<WorkbookProcessingResult> {
  return (await executeWorkbookRequest(file, signal, role)).result!;
}
