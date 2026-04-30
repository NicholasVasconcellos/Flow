const DEFAULT_WS_URL = 'ws://127.0.0.1:7777';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function createWsClient(url, onFrame, onStatusChange) {
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    onStatusChange?.('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_MS;
      onStatusChange?.('connected');
    });

    ws.addEventListener('message', (evt) => {
      try {
        const frame = JSON.parse(evt.data);
        onFrame(frame);
      } catch {
        // malformed frame — skip
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      onStatusChange?.('disconnected');
      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      }
    });

    ws.addEventListener('error', () => {
      // close event fires after error — let that handle reconnect
    });
  }

  function send(command) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(command));
    }
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
  }

  connect();
  return { send, stop };
}

export function getWsUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('ws') || DEFAULT_WS_URL;
}

export function isFixtureMode() {
  const params = new URLSearchParams(window.location.search);
  return params.has('fixture');
}
