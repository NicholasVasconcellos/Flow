import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './displayMeta.js';
import { ProjectScreen } from './project_screen.jsx';
import { FlowDataProvider, useFlowData } from './FlowDataContext.jsx';
import { loadFixture } from './fixtureReplay.js';
import { createWsClient, getWsUrl, isFixtureMode } from './wsClient.js';
import { ToastHost } from './Toast.jsx';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: '#e5806b', background: '#0a0a0f', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Render error</div>
          <pre style={{ fontSize: 12, color: '#9aa3b2', maxWidth: 600, whiteSpace: 'pre-wrap' }}>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function ConnectionBanner({ status, wsUrl }) {
  if (status === 'connected') return null;

  const styles = {
    fixture:      { bg: 'var(--warn-bg)',  fg: 'var(--warn)',   border: 'rgba(227,179,65,0.3)' },
    connecting:   { bg: 'var(--bg-2)',     fg: 'var(--text-3)', border: 'var(--border-2)' },
    disconnected: { bg: 'var(--warn-bg)',  fg: 'var(--warn)',   border: 'rgba(227,179,65,0.3)' },
  }[status] || null;
  if (!styles) return null;

  const message = status === 'fixture'
    ? <>Showing fixture snapshot — append <code style={{ background: 'var(--bg-3)', padding: '0 4px', borderRadius: 3 }}>?ws={wsUrl}</code> for live data</>
    : status === 'connecting'
      ? <>Connecting to <code style={{ background: 'var(--bg-3)', padding: '0 4px', borderRadius: 3 }}>{wsUrl}</code>…</>
      : <>Disconnected from <code style={{ background: 'var(--bg-3)', padding: '0 4px', borderRadius: 3 }}>{wsUrl}</code> — retrying</>;

  return (
    <div style={{
      background: styles.bg,
      color: styles.fg,
      borderBottom: `1px solid ${styles.border}`,
      padding: '6px 12px',
      fontSize: 12,
      fontFamily: 'var(--font-sans)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ fontWeight: 500 }}>{message}</span>
    </div>
  );
}

function App() {
  const {
    dispatch,
    setSendCommand,
    setSendCommandAwait,
    setCommandFailureSubscriber,
  } = useFlowData();
  const clientRef = useRef(null);
  const fixture = isFixtureMode();
  const wsUrl = getWsUrl();
  const [status, setStatus] = useState(fixture ? 'fixture' : 'connecting');

  useEffect(() => {
    if (fixture) {
      loadFixture(dispatch);
      return;
    }
    const client = createWsClient(wsUrl, dispatch, setStatus);
    clientRef.current = client;
    setSendCommand((cmd) => client.send(cmd));
    setSendCommandAwait((cmd, opts) => client.sendCommandAwait(cmd, opts));
    setCommandFailureSubscriber((cb) => client.onCommandFailure(cb));
    return () => client.stop();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <ConnectionBanner status={status} wsUrl={wsUrl} />
      <ToastHost />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ProjectScreen />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <FlowDataProvider>
      <App />
    </FlowDataProvider>
  </ErrorBoundary>
);
