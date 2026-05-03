import React, { createContext, useContext, useReducer, useMemo, useRef, useCallback } from 'react';
import { initialState, applyEvent } from './store.js';

const FlowDataContext = createContext(null);

const FlowDataProvider = ({ children }) => {
  const [state, dispatchRaw] = useReducer(
    (s, frame) => applyEvent(s, frame),
    initialState,
  );

  const sendCommandRef = useRef(null);
  const sendCommandAwaitRef = useRef(null);
  const commandFailureSubRef = useRef(null);

  const setSendCommand = useCallback((fn) => { sendCommandRef.current = fn; }, []);
  const setSendCommandAwait = useCallback((fn) => { sendCommandAwaitRef.current = fn; }, []);
  const setCommandFailureSubscriber = useCallback((fn) => {
    commandFailureSubRef.current = fn;
  }, []);

  const sendCommand = useCallback((cmd) => sendCommandRef.current?.(cmd), []);
  const sendCommandAwait = useCallback((cmd, opts) => {
    const fn = sendCommandAwaitRef.current;
    if (!fn) return Promise.reject(new Error('not connected'));
    return fn(cmd, opts);
  }, []);
  const onCommandFailure = useCallback((cb) => {
    const fn = commandFailureSubRef.current;
    return fn ? fn(cb) : () => {};
  }, []);

  const value = useMemo(() => {
    const TASKS = Object.values(state.TASKS);
    const SESSIONS = Object.values(state.SESSIONS);
    return {
      ...state,
      TASKS,
      SESSIONS,
      dispatch: dispatchRaw,
      sendCommand,
      sendCommandAwait,
      onCommandFailure,
      setSendCommand,
      setSendCommandAwait,
      setCommandFailureSubscriber,
    };
  }, [
    state,
    sendCommand,
    sendCommandAwait,
    onCommandFailure,
    setSendCommand,
    setSendCommandAwait,
    setCommandFailureSubscriber,
  ]);

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
