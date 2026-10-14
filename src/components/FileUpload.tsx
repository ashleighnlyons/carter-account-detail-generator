import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { EXCEL_ACCEPT } from '../excel/fileValidation';
import type { FileSlot } from '../services/sessionState';
import { Icon } from './Icon';

export function FileUpload({ title, description, slot, onFile }: {
  title: string; description: string; slot: FileSlot; onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState('');
  function choose(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1) { setDropError('Choose one workbook for this area.'); return; }
    setDropError(''); onFile(files[0]);
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false); choose(event.dataTransfer.files);
  }
  return <div className="upload-card">
    <div className="upload-label"><Icon kind="file"/><div><h3>{title}</h3><p>{description}</p></div></div>
    <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <p>{slot.status === 'reading' ? 'Processing workbook locally…' : 'Drag an Excel workbook here'}</p>
      <span>or </span><button type="button" className="browse-button" onClick={() => input.current?.click()}>Browse <span className="sr-only">{title}</span></button>
      <input ref={input} type="file" accept={EXCEL_ACCEPT} aria-label={title} className="sr-only" tabIndex={-1} onChange={event => { choose(event.currentTarget.files); event.currentTarget.value = ''; }}/>
      <small>.xlsx, .xlsm, .xlsb, .xls · up to 25 MB</small>
    </div>
    <div className="file-state" aria-live="polite">
      {slot.status === 'empty' && !dropError && <span>No workbook selected</span>}
      {slot.status === 'reading' && <span>Reading and validating in a local browser worker. You can use Start Over to cancel.</span>}
      {slot.status === 'ready' && <><strong className="file-name">{slot.metadata.fileName}</strong><span>{slot.metadata.sheetCount} worksheet{slot.metadata.sheetCount === 1 ? '' : 's'} · {(slot.metadata.sizeBytes / 1024).toFixed(1)} KB · Workbook read</span><span className="sheet-names">Worksheets: {slot.metadata.sheetNames.join(', ')}</span></>}
      {slot.status === 'error' && <span className="error-text" role="alert">{slot.message}</span>}
      {dropError && <span className="error-text" role="alert">{dropError}</span>}
    </div>
  </div>;
}
