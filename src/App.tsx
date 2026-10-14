import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { FileUpload } from './components/FileUpload';
import { ValidationPanel } from './components/ValidationPanel';
import { LeadcodeSelection } from './components/LeadcodeSelection';
import { Icon } from './components/Icon';
import { GenerationControls } from './components/GenerationControls';
import { StaffHelp } from './components/StaffHelp';
import { APP_RELEASE_LABEL } from './version';
import { processWorkbookFile } from './excel/workbookReader';
import { createInitialSession, sessionReducer } from './services/sessionState';
import type { FileRole } from './services/sessionState';

export default function App() {
  const [state, dispatch] = useReducer(sessionReducer, undefined, createInitialSession);
  const [resetKey, setResetKey] = useState(0);
  const requests = useRef(0);
  const controllers = useRef<Partial<Record<FileRole, AbortController>>>({});
  const startOver = useCallback(() => {
    Object.values(controllers.current).forEach(controller => controller?.abort());
    controllers.current = {};
    dispatch({ type: 'reset' });
    setResetKey(key => key + 1);
  }, []);
  useEffect(() => {
    const abortAll = () => Object.values(controllers.current).forEach(controller => controller?.abort());
    window.addEventListener('pagehide', startOver);
    return () => { abortAll(); window.removeEventListener('pagehide', startOver); };
  }, [startOver]);

  async function selectFile(role: FileRole, file: File) {
    controllers.current[role]?.abort();
    const controller = new AbortController();
    controllers.current[role] = controller;
    const requestId = ++requests.current;
    dispatch({ type: 'fileStarted', role, requestId });
    try {
      const processing = await processWorkbookFile(file, role, controller.signal);
      if (!controller.signal.aborted) dispatch({ type: 'fileReady', role, requestId, metadata: processing.metadata, processing });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: 'fileFailed', role, requestId,
        message: error instanceof Error ? error.message : 'Workbook inspection failed.' });
    } finally {
      if (controllers.current[role] === controller) delete controllers.current[role];
    }
  }

  return <div className="app-shell" onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <header className="brand-bar"><div className="brand"><span className="brand-mark">C<span>&</span>C</span><span>Carter &amp; Company</span></div><span className="utility-label">INTERNAL AUDIT UTILITIES</span></header>
    <main>
      <div className="page-title"><div><h1>Account Detail Generator</h1><p>Create standardized audit account detail from a CCH trial balance and client general ledger.</p></div><span className="badge neutral">{APP_RELEASE_LABEL}</span></div>
      <aside className="privacy-notice"><Icon kind="shield" size={23}/><div><strong>Local processing. Client files stay with you.</strong><p>Client files remain on your computer. Files are processed locally in your browser and are not uploaded or stored.</p></div></aside>
      <StaffHelp/>
      <section className="panel files-panel" aria-labelledby="files-title"><div className="section-heading"><div className="heading-with-step"><span className="step-number">1</span><h2 id="files-title">Choose source workbooks</h2></div><span className="muted small">Excel files only</span></div>
        <div className="uploads" key={resetKey}><FileUpload title="CCH Trial Balance" description="The authoritative account-to-leadcode mapping" slot={state.files.trialBalance} onFile={file => void selectFile('trialBalance', file)}/><FileUpload title="Client General Ledger" description="Transaction detail from the client’s accounting system" slot={state.files.generalLedger} onFile={file => void selectFile('generalLedger', file)}/></div>
      </section>
      <ValidationPanel state={state}/>
      <LeadcodeSelection state={state} dispatch={dispatch}/>
      <GenerationControls state={state} onReset={startOver}/>
      <footer><span>Carter &amp; Company · Account Detail Generator · {APP_RELEASE_LABEL}</span><span>Browser memory only · No uploads · No saved client data</span></footer>
    </main>
  </div>;
}

