import { test } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer } from 'ws';
import { createWsClient } from '../src/wsClient.js';

// Node 20+ exposes the global WebSocket; createWsClient uses it. The wsClient
// module references `crypto.randomUUID` (also a Node 20 global) and
// `setTimeout` (built-in).

function startServer(handler) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('listening', () => {
      const { port } = wss.address();
      const url = `ws://127.0.0.1:${port}`;
      const sockets = new Set();
      wss.on('connection', (ws) => {
        sockets.add(ws);
        ws.on('close', () => sockets.delete(ws));
        ws.on('message', (raw) => {
          let frame;
          try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
          handler(ws, frame);
        });
      });
      const close = () => new Promise((r) => {
        for (const s of sockets) try { s.terminate(); } catch { /* ignore */ }
        wss.close(() => r());
      });
      resolve({ url, wss, close });
    });
  });
}

function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('sendCommandAwait resolves on matching command.result {ok:true}', async () => {
  const { url, close } = await startServer((ws, frame) => {
    if (frame.type === 'task.retry') {
      ws.send(JSON.stringify({ type: 'command.result', requestId: frame.requestId, ok: true, data: { applied: true } }));
    }
  });
  try {
    let connected = false;
    const client = createWsClient(url, () => {}, (s) => { if (s === 'connected') connected = true; });
    await waitFor(() => connected);
    const result = await client.sendCommandAwait({ type: 'task.retry', taskId: 'T1' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { applied: true });
    client.stop();
  } finally {
    await close();
  }
});

test('sendCommandAwait rejects on command.result {ok:false}', async () => {
  const { url, close } = await startServer((ws, frame) => {
    if (frame.type === 'task.retry') {
      ws.send(JSON.stringify({
        type: 'command.result',
        requestId: frame.requestId,
        ok: false,
        message: 'task.retry not permitted: serve runs read-only.',
      }));
    }
  });
  try {
    let connected = false;
    const client = createWsClient(url, () => {}, (s) => { if (s === 'connected') connected = true; });
    await waitFor(() => connected);
    await assert.rejects(
      () => client.sendCommandAwait({ type: 'task.retry', taskId: 'T1' }),
      /read-only/i,
    );
    client.stop();
  } finally {
    await close();
  }
});

test('command failure emitter fires regardless of API used', async () => {
  const { url, close } = await startServer((ws, frame) => {
    ws.send(JSON.stringify({
      type: 'command.result',
      requestId: frame.requestId,
      ok: false,
      message: 'rejected',
    }));
  });
  try {
    let connected = false;
    const client = createWsClient(url, () => {}, (s) => { if (s === 'connected') connected = true; });
    await waitFor(() => connected);
    const failures = [];
    const off = client.onCommandFailure((evt) => failures.push(evt));
    // Fire-and-forget — wsClient auto-attaches a requestId so failures still
    // route through the emitter.
    client.send({ type: 'task.retry', taskId: 'T1' });
    await waitFor(() => failures.length > 0);
    assert.equal(failures[0].message, 'rejected');
    off();
    client.stop();
  } finally {
    await close();
  }
});

test('sendCommandAwait rejects with "connection lost" on ws.close', async () => {
  const { url, close } = await startServer(() => {
    /* never reply — leave the request hanging until the server closes */
  });
  try {
    let connected = false;
    const client = createWsClient(url, () => {}, (s) => { if (s === 'connected') connected = true; });
    await waitFor(() => connected);
    const promise = client.sendCommandAwait({ type: 'task.retry', taskId: 'T1' });
    // Close the server, which forces the underlying socket close.
    await close();
    await assert.rejects(() => promise, /connection lost/);
    client.stop();
  } finally {
    /* server already closed */
  }
});
