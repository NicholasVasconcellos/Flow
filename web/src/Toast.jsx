import React, { useEffect, useState, useCallback } from 'react';
import { useFlowData } from './FlowDataContext.jsx';

const AUTO_DISMISS_MS = 5_000;

function ToastHost() {
  const { onCommandFailure } = useFlowData();
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (!onCommandFailure) return undefined;
    const off = onCommandFailure(({ message }) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((cur) => [...cur, { id, message: message || 'Command failed' }]);
      setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
    });
    return typeof off === 'function' ? off : undefined;
  }, [onCommandFailure]);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 420,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
          style={{
            pointerEvents: 'auto',
            textAlign: 'left',
            background: 'var(--bg-elev, var(--bg-1))',
            color: 'var(--text-1)',
            border: '1px solid var(--err, #e5806b)',
            borderLeft: '3px solid var(--err, #e5806b)',
            borderRadius: 'var(--r-md, 6px)',
            padding: '10px 12px',
            fontFamily: 'var(--font-sans)',
            fontSize: 12.5,
            lineHeight: 1.45,
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            cursor: 'pointer',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          <span style={{ color: 'var(--err, #e5806b)', fontWeight: 600, flexShrink: 0 }}>!</span>
          <span style={{ flex: 1 }}>{t.message}</span>
        </button>
      ))}
    </div>
  );
}

export { ToastHost };
