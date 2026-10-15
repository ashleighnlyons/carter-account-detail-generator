import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { FileUpload } from './components/FileUpload';
import { ValidationPanel } from './components/ValidationPanel';
import { LeadcodeSelection } from './components/LeadcodeSelection';
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
    <main>
      <header className="app-header"><div><h1>Carter &amp; Company</h1><p className="app-subtitle">Account Detail Generator</p></div><aside className="privacy-notice"><strong>Files are processed locally in your browser.</strong><p>Client files remain on your computer. Files are processed locally in your browser and are not uploaded or stored.</p></aside></header>
      <section className="panel files-panel workflow-step" aria-labelledby="files-title"><div className="section-heading"><div className="heading-with-step"><span className="step-number">1</span><h2 id="files-title">Upload Trial Balance and General Ledger</h2></div></div>
        <div className="uploads" key={resetKey}><FileUpload title="CCH Trial Balance" description="The authoritative account-to-leadcode mapping" slot={state.files.trialBalance} onFile={file => void selectFile('trialBalance', file)}/><FileUpload title="Client General Ledger" description="Transaction detail from the client’s accounting system" slot={state.files.generalLedger} onFile={file => void selectFile('generalLedger', file)}/></div>
        <ValidationPanel state={state}/>
        <StaffHelp/>
      </section>
      <LeadcodeSelection state={state} dispatch={dispatch}/>
      <section className="panel generate-panel workflow-step" aria-labelledby="generate-title"><div className="section-heading"><div className="heading-with-step"><span className="step-number">3</span><h2 id="generate-title">Generate Excel</h2></div></div><GenerationControls state={state} onReset={startOver}/></section>
      <footer><span>Carter &amp; Company · Account Detail Generator · {APP_RELEASE_LABEL}</span><span>Browser memory only · No uploads · No saved client data</span></footer>
    </main>
  </div>;
}

