import React, { createContext, useContext, useReducer, useMemo, useRef, useCallback } from 'react';
import { initialState, applyEvent } from './store.js';

const FlowDataContext = createContext(null);

const FlowDataProvider = ({ children }) => {
  const [state, dispatchRaw] = useReducer(
    (s, frame) => applyEvent(s, frame),
    initialState,
  );

  const sendCommandRef = useRef(null);
  const setSendCommand = useCallback((fn) => { sendCommandRef.current = fn; }, []);
  const sendCommand = useCallback((cmd) => sendCommandRef.current?.(cmd), []);

  const value = useMemo(() => {
    const TASKS = Object.values(state.TASKS);
    const SESSIONS = Object.values(state.SESSIONS);
    return {
      ...state,
      TASKS,
      SESSIONS,
      dispatch: dispatchRaw,
      sendCommand,
      setSendCommand,
    };
  }, [state, sendCommand, setSendCommand]);

  return (
    <FlowDataContext.Provider value={value}>
      {children}
    </FlowDataContext.Provider>
  );
};

const useFlowData = () => {
  const ctx = useContext(FlowDataContext);
  if (!ctx) throw new Error('useFlowData must be used inside FlowDataProvider');
  return ctx;
};

export { FlowDataContext, FlowDataProvider, useFlowData };
