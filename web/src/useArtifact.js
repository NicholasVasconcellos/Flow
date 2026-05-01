import { useEffect } from 'react';
import { useFlowData } from './FlowDataContext.jsx';
import { artifactKey } from './store.js';

// Module-scope inflight registry — survives React StrictMode double-effects
// and component remounts within the same module instance. Cleared per-key
// on artifact.end / artifact.error.
const inflight = new Map();

function newFetchId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts in tests / older runtimes.
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Lazily request a server artifact (session events, learnings, task files, etc.).
 *
 * - Idempotent across multiple component mounts of the same key.
 * - Returns the current artifact entry from state (or undefined when nothing
 *   has been requested yet); callers typically only need it for `status`.
 *
 * Caller passes `kind` and `ids`; the hook key is derived from both.
 */
export function useArtifact(kind, ids) {
  const { ARTIFACTS, dispatch, sendCommand } = useFlowData();
  // Rules-of-hooks demands stable hook order, so callers can't conditionally
  // skip the hook when their ids aren't ready. Detect "not ready" inside and
  // no-op so the hook is always callable.
  const idsReady =
    kind &&
    ids &&
    typeof ids === 'object' &&
    Object.values(ids).every((v) => v !== undefined && v !== null && v !== '');
  const key = idsReady ? artifactKey(kind, ids) : null;
  const entry = key ? ARTIFACTS[key] : undefined;
  const status = entry?.status;

  useEffect(() => {
    if (!idsReady || !key) return;
    // Already loading or loaded in store — do nothing.
    if (status === 'loading' || status === 'loaded') return;
    // Another instance kicked it off this tick (StrictMode dual-mount race).
    if (inflight.has(key)) return;

    const fetchId = newFetchId();
    inflight.set(key, fetchId);

    // Synthetic reducer action so subsequent useArtifact mounts see
    // status === 'loading' immediately, without waiting for round-trip.
    dispatch({ type: 'artifact.fetch.start', kind, ids });

    try {
      sendCommand({ type: 'artifact.fetch', fetchId, kind, ids });
    } catch {
      // sendCommand swallows internally; only direct throws end up here.
      inflight.delete(key);
    }
    // status drives effect re-runs: when artifact.end flips it to 'loaded',
    // we don't dispatch again. ids-by-stable-key is captured via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status, idsReady]);

  // Clear the inflight entry when the key transitions to a terminal state so
  // a future re-fetch (e.g. after a manual invalidation in step 6) can fire.
  useEffect(() => {
    if (!key) return;
    if (status === 'loaded' || status === 'error') {
      inflight.delete(key);
    }
  }, [key, status]);

  return entry;
}

// Test-only — clears the module-scope inflight map. Avoids leaking state
// between unit tests that exercise the hook's idempotency guarantees.
export function _resetInflightForTests() {
  inflight.clear();
}
