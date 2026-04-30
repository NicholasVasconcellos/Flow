import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './displayMeta.js';
import { ProjectScreen } from './project_screen.jsx';
import { FlowDataProvider, useFlowData } from './FlowDataContext.jsx';
import { loadFixture } from './fixtureReplay.js';
import { createWsClient, getWsUrl, isFixtureMode } from './wsClient.js';

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

function App() {
  const { dispatch, setSendCommand } = useFlowData();
  const clientRef = useRef(null);

  useEffect(() => {
    if (isFixtureMode()) {
      loadFixture(dispatch);
    } else {
      const client = createWsClient(
        getWsUrl(),
        dispatch,
        (status) => { /* TODO: expose connection status in UI */ }
      );
      clientRef.current = client;
      setSendCommand((cmd) => client.send(cmd));
      return () => client.stop();
    }
  }, []);

  return <ProjectScreen />;
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <FlowDataProvider>
      <App />
    </FlowDataProvider>
  </ErrorBoundary>
);
