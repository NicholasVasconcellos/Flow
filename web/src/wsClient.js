const DEFAULT_WS_URL = 'ws://127.0.0.1:7777';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// Inactivity-based watchdog tick. We don't time individual requests; we evict
// pending entries only when the wire has been silent for `stalenessMs` past
// their start. A chatty server keeps long-running commands alive.
const WATCHDOG_TICK_MS = 5_000;
const DEFAULT_STALENESS_MS = 30_000;

function genRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Tests may run in environments without crypto.randomUUID.
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createWsClient(url, onFrame, onStatusChange) {
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let stopped = false;
  let reconnectTimer = null;
  let watchdogTimer = null;

  // requestId -> { resolve, reject, sentAt, stalenessMs }
  const pending = new Map();
  // Failure subscribers — any command.result with ok:false is forwarded here
  // regardless of which API the caller used (sendCommand or sendCommandAwait).
  const failureListeners = new Set();
  // Last-frame timestamp drives staleness eviction.
  let lastFrameAt = Date.now();

  function emitFailure(message, requestId) {
    const evt = { message, requestId };
    for (const cb of failureListeners) {
      try { cb(evt); } catch { /* listener error — skip */ }
    }
  }

  function rejectAllPending(message) {
    for (const [, entry] of pending) {
      try { entry.reject(new Error(message)); } catch { /* ignore */ }
    }
    pending.clear();
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (pending.size === 0) return;
      const now = Date.now();
      // Quiet wire: if no inbound frame has arrived in `stalenessMs`, the
      // connection is effectively idle. Evict any pending entry whose age
      // exceeds that threshold.
      const quietMs = now - lastFrameAt;
      for (const [id, entry] of pending) {
        const age = now - entry.sentAt;
        if (age > entry.stalenessMs && quietMs > entry.stalenessMs) {
          pending.delete(id);
          const msg = `command timed out after ${entry.stalenessMs}ms of inactivity`;
          try { entry.reject(new Error(msg)); } catch { /* ignore */ }
          emitFailure(msg, id);
        }
      }
    }, WATCHDOG_TICK_MS);
    if (typeof watchdogTimer?.unref === 'function') watchdogTimer.unref();
  }
  function stopWatchdog() {
    if (!watchdogTimer) return;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function connect() {
    if (stopped) return;
    onStatusChange?.('connecting');
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_MS;
      lastFrameAt = Date.now();
      onStatusChange?.('connected');
      startWatchdog();
    });

    ws.addEventListener('message', (evt) => {
      lastFrameAt = Date.now();
      let frame;
      try {
        frame = JSON.parse(evt.data);
      } catch {
        return; // malformed frame — skip
      }
      // command.result is transport plumbing — resolve the awaiting promise
      // (if any) and never forward to the reducer. Failures are also
      // broadcast on the failureListeners so a global toast surfaces them
      // even when the caller used sendCommand (fire-and-forget).
      if (frame && frame.type === 'command.result') {
        const { requestId, ok, message } = frame;
        const entry = requestId ? pending.get(requestId) : null;
        if (entry) {
          pending.delete(requestId);
          if (ok) entry.resolve(frame);
          else entry.reject(new Error(message || 'command failed'));
        }
        if (!ok) emitFailure(message || 'command failed', requestId);
        return;
      }
      onFrame(frame);
    });

    ws.addEventListener('close', () => {
      ws = null;
      stopWatchdog();
      rejectAllPending('connection lost');
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
    if (ws?.readyState !== WebSocket.OPEN) return;
    // Auto-attach a requestId so failures route to the toast emitter even for
    // fire-and-forget callers. Skips when the caller already supplied one
    // (e.g. sendCommandAwait, useArtifact).
    const out = command && command.requestId ? command : { ...command, requestId: genRequestId() };
    ws.send(JSON.stringify(out));
  }

  function sendCommandAwait(command, opts = {}) {
    const stalenessMs = typeof opts.stalenessMs === 'number' ? opts.stalenessMs : DEFAULT_STALENESS_MS;
    if (ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('connection lost'));
    }
    const requestId = (command && command.requestId) || genRequestId();
    const payload = { ...command, requestId };
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, sentAt: Date.now(), stalenessMs });
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        pending.delete(requestId);
        reject(err);
      }
    });
  }

  function onCommandFailure(cb) {
    failureListeners.add(cb);
    return () => failureListeners.delete(cb);
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    stopWatchdog();
    rejectAllPending('connection lost');
    ws?.close();
    ws = null;
  }

  connect();
  return { send, sendCommandAwait, onCommandFailure, stop };
}

export function getWsUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('ws') || DEFAULT_WS_URL;
}

export function isFixtureMode() {
  const params = new URLSearchParams(window.location.search);
  return params.has('fixture');
}
