import React from 'react';
import { I } from './icons.jsx';
import { Panel, StatusBadge, ContextDonut, formatK, formatCost } from './primitives.jsx';
import { useArtifact } from './useArtifact.js';

// Log column — renders formatted session log events

const LOG_FILTER_TYPES = [
  { kind: "user",           label: "User" },
  { kind: "assistant_text", label: "Agent" },
  { kind: "tool_use",       label: "Tool call" },
  { kind: "tool_result",    label: "Result" },
];

const LogColumn = ({ session, events, onClose, onExpand, collapsed, fixedWidth }) => {
  const [collapsedEvents, setCollapsedEvents] = React.useState({});
  const toggleEvt = (id) => setCollapsedEvents(s => ({ ...s, [id]: !s[id] }));

  // Filter state — all types visible by default
  const [enabled, setEnabled] = React.useState(
    () => Object.fromEntries(LOG_FILTER_TYPES.map(t => [t.kind, true]))
  );
  const [filterOpen, setFilterOpen] = React.useState(false);
  const filterRef = React.useRef(null);

  React.useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [filterOpen]);

  // Lazily replay this session's full event JSONL on first render. Idempotent
  // across mounts/StrictMode via the module-scope inflight map in useArtifact.
  // The hook is called unconditionally (rules-of-hooks); it no-ops when
  // session?.id is missing.
  useArtifact('session.events', { sessionId: session?.id });

  if (!session) return null;
  const allSessionEvents = events
    .filter(e => e.sessionId === session.id)
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  const sessionEvents = allSessionEvents.filter(e => enabled[e.kind] !== false);
  const activeCount = LOG_FILTER_TYPES.filter(t => enabled[t.kind]).length;
  const filtersActive = activeCount < LOG_FILTER_TYPES.length;

  const style = fixedWidth
    ? { flex: `0 0 ${fixedWidth}px`, width: fixedWidth, minWidth: fixedWidth, maxWidth: fixedWidth }
    : { flex: "1 1 360px", minWidth: 300, maxWidth: 560 };

  const filterAction = (
    <div ref={filterRef} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        onClick={() => setFilterOpen(o => !o)}
        title="Filter log types"
        style={{
          color: filtersActive ? "var(--accent)" : undefined,
          background: filterOpen ? "var(--bg-2)" : undefined,
        }}
      >
        <I.Filter size={12}/>
      </button>
      {filtersActive && (
        <span style={{
          position: "absolute", top: 1, right: 1,
          width: 5, height: 5, borderRadius: 999,
          background: "var(--accent)",
          pointerEvents: "none",
        }}/>
      )}
      {filterOpen && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0,
            background: "var(--bg-1)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--r-md)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
            padding: 4,
            minWidth: 160,
            zIndex: 40,
          }}
        >
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "6px 8px 4px", fontSize: 10, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.06em",
            color: "var(--text-3)",
          }}>
            <span>Show</span>
            <button
              className="icon-btn"
              onClick={() => setEnabled(Object.fromEntries(LOG_FILTER_TYPES.map(t => [t.kind, true])))}
              title="Show all"
              style={{ width: "auto", padding: "0 6px", fontSize: 10, color: "var(--text-3)", textTransform: "none", letterSpacing: 0, fontWeight: 500 }}
            >
              All
            </button>
          </div>
          {LOG_FILTER_TYPES.map(t => {
            const { icon, color } = eventStyle({ kind: t.kind });
            const on = enabled[t.kind] !== false;
            return (
              <button
                key={t.kind}
                onClick={() => setEnabled(e => ({ ...e, [t.kind]: !on }))}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", padding: "6px 8px",
                  background: "transparent",
                  border: "none",
                  borderRadius: "var(--r-sm)",
                  cursor: "pointer",
                  color: "var(--text-1)",
                  fontSize: 12,
                  textAlign: "left",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--bg-2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <span style={{
                  width: 14, height: 14, borderRadius: 3,
                  border: `1px solid ${on ? "var(--accent)" : "var(--border-2)"}`,
                  background: on ? "var(--accent)" : "transparent",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", flexShrink: 0,
                }}>
                  {on && <I.Check size={10}/>}
                </span>
                <span style={{ color, display: "inline-flex", width: 14 }}>{icon}</span>
                <span style={{ flex: 1 }}>{t.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Panel
      className="log-col"
      style={style}
      collapsed={collapsed}
      leftActions={
        <>
          {onClose && (
            <button className="icon-btn" onClick={onClose} title="Close"><I.X size={14}/></button>
          )}
          {filterAction}
        </>
      }
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden", flex: 1 }}>
          {session.status === "running" ? (
            <span
              className="drop-at-sm"
              title="Active session"
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 8, height: 8, borderRadius: 999,
                background: "var(--ok)",
                boxShadow: "0 0 0 3px color-mix(in oklch, var(--ok) 22%, transparent)",
                flexShrink: 0,
                animation: "flowPulse 1.6s ease-in-out infinite",
              }}
            />
          ) : (
            <span
              className="drop-at-sm"
              title={`Session ${session.status}`}
              style={{
                display: "inline-block",
                width: 8, height: 8, borderRadius: 999,
                background: session.status === "done" ? "var(--text-4)"
                          : session.status === "queued" ? "var(--text-4)"
                          : session.status === "blocked" ? "var(--err)"
                          : "var(--text-4)",
                opacity: session.status === "queued" ? 0.5 : 0.8,
                flexShrink: 0,
              }}
            />
          )}
          <span title={session.name} style={{ fontFamily: "var(--font-mono)", textTransform: "none", fontSize: 12, color: "var(--text-1)", fontWeight: 500, letterSpacing: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "0 1 auto" }}>
            {session.name}
          </span>
          <span className="drop-at-xs" style={{ flexShrink: 0 }}>
            <StatusBadge status={session.status}/>
          </span>
        </span>
      }
    >
      {/* Session metadata strip */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 12px", borderBottom: "1px solid var(--border-1)",
        background: "var(--bg-1)", fontSize: 11, minWidth: 0,
      }}>
        <ContextDonut used={session.contextUsed} max={session.contextMax} size={42} stroke={4} showLabel={false} autocompacted={session.autocompacted}/>
        <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
          <div className="mono" style={{ color: "var(--text-2)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.model}
            {session.skillName && <span style={{ color: "var(--text-4)" }}> · {session.skillName}</span>}
          </div>
          <div style={{ color: "var(--text-4)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", gap: 6, alignItems: "center" }}>
            {formatK(session.tokens.input + session.tokens.output)} tok · {formatCost(session.costUsd ?? session.cost)}
            {session.effort && <span>· {session.effort}</span>}
            {session.thinkingMode && session.thinkingMode !== "auto" && <span>· {session.thinkingMode}</span>}
            {typeof session.ordinal === "number" && <span>· #{session.ordinal}</span>}
            {session.autocompacted && <span style={{ color: "var(--warn)" }}>· *compact</span>}
          </div>
        </div>
        {session.reviewRequested && (
          <span title="FLOW_REVIEW_REQUESTED" style={{ fontSize: 9.5, fontWeight: 600, color: "var(--warn)", padding: "2px 6px", border: "1px solid rgba(227,179,65,0.3)", borderRadius: 3, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>REVIEW</span>
        )}
      </div>

      {/* Transient-error stripe */}
      {session.transientError && (
        <div style={{
          padding: "6px 12px",
          background: "var(--warn-bg)",
          borderBottom: "1px solid rgba(227,179,65,0.22)",
          color: "var(--warn)", fontSize: 11, display: "flex", gap: 6, alignItems: "center",
        }}>
          <I.AlertTri size={12}/>
          <span style={{ color: "var(--text-2)" }}>
            <strong style={{ color: "var(--warn)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", marginRight: 6 }}>
              {session.transientError.kind?.replace("_", " ") || "transient"}
            </strong>
            {session.transientError.message}
          </span>
          {session.transientError.at && <span className="mono" style={{ marginLeft: "auto", color: "var(--text-4)", fontSize: 10 }}>{session.transientError.at}</span>}
        </div>
      )}

      {/* Exit / error footer for ended sessions */}
      {(session.status === "succeeded" || session.status === "failed" || session.status === "done") && (typeof session.exitCode === "number" || session.error) && (
        <div style={{
          padding: "6px 12px",
          background: session.exitCode === 0 ? "var(--ok-bg)" : "var(--err-bg)",
          borderBottom: `1px solid ${session.exitCode === 0 ? "rgba(124,196,127,0.22)" : "rgba(229,128,107,0.22)"}`,
          fontSize: 10.5, color: session.exitCode === 0 ? "var(--ok)" : "var(--err)",
          display: "flex", gap: 8, alignItems: "center",
          fontFamily: "var(--font-mono)",
        }}>
          {typeof session.exitCode === "number" && <span>exit {session.exitCode}</span>}
          {session.error && <span style={{ color: "var(--text-2)" }}>{session.error}</span>}
        </div>
      )}

      {/* Events */}
      <div style={{ padding: "8px 0" }}>
        {sessionEvents.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-4)", fontSize: 12 }}>
            {allSessionEvents.length === 0
              ? <>No events yet. Session {session.status}.</>
              : <>No events match the active filter.</>}
          </div>
        )}
        {sessionEvents.map(ev => (
          <LogEvent key={ev.id} ev={ev} collapsed={collapsedEvents[ev.id]} onToggle={() => toggleEvt(ev.id)} />
        ))}
      </div>
    </Panel>
  );
};

const LogEvent = ({ ev, collapsed, onToggle }) => {
  const { icon, color, label } = eventStyle(ev);
  const body = renderBody(ev, collapsed);
  const canCollapse = ev.kind === "tool_use" || ev.kind === "tool_result";
  return (
    <div style={{
      display: "flex", gap: 8,
      padding: "6px 12px 6px 10px",
      borderLeft: `2px solid ${ev.kind === "user" ? "var(--accent)" : "transparent"}`,
      background: ev.kind === "user" ? "rgba(217,119,87,0.04)" : "transparent",
      fontSize: 11.5,
    }}>
      <div style={{ width: 16, paddingTop: 2, color }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, color, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {label}
          </span>
          {ev.tool && <span className="mono" style={{ fontSize: 10.5, color: "var(--text-2)" }}>{ev.tool}</span>}
          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginLeft: "auto" }}>{ev.t}</span>
          {canCollapse && (
            <button className="icon-btn" onClick={onToggle} style={{ width: 16, height: 16 }}>
              {collapsed ? <I.ChevronRt size={10}/> : <I.Chevron size={10}/>}
            </button>
          )}
        </div>
        {!collapsed && body}
      </div>
    </div>
  );
};

function eventStyle(ev) {
  switch (ev.kind) {
    case "user": return { icon: <I.User size={13}/>, color: "var(--accent)", label: "User" };
    case "assistant_text": return { icon: <I.MessageSq size={13}/>, color: "var(--text-2)", label: "Assistant" };
    case "tool_use": return { icon: <I.Wrench size={13}/>, color: "var(--info)", label: "Tool call" };
    case "tool_result": return { icon: <I.CheckCircle size={13}/>, color: "var(--ok)", label: "Result" };
    default: return { icon: <I.Dot size={13}/>, color: "var(--text-3)", label: ev.kind };
  }
}

function renderBody(ev, collapsed) {
  if (collapsed) {
    return <div style={{ color: "var(--text-4)", fontSize: 11, fontStyle: "italic" }}>(collapsed)</div>;
  }
  if (ev.kind === "user" || ev.kind === "assistant_text") {
    return <div style={{ color: ev.kind === "user" ? "var(--text-1)" : "var(--text-2)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{ev.content}</div>;
  }
  if (ev.kind === "tool_use") {
    return <KVBlock data={ev.input} tint="info"/>;
  }
  if (ev.kind === "tool_result") {
    const exit = ev.result?.exitCode;
    const data = ev.result ?? ev.content;
    return (
      <div>
        {typeof exit === "number" && (
          <div style={{ marginBottom: 4 }}>
            <span className={`badge ${exit === 0 ? "ok" : "err"}`} style={{ fontFamily: "var(--font-mono)" }}>
              exit {exit}
            </span>
          </div>
        )}
        <KVBlock data={data} tint={exit === 0 || exit === undefined ? "ok" : "err"}/>
      </div>
    );
  }
  return null;
}

// Formatted key-value block for JSON-ish tool payloads
const KVBlock = ({ data, tint = "" }) => {
  const tintColor = {
    ok: "rgba(124,196,127,0.35)",
    err: "rgba(229,128,107,0.35)",
    info: "rgba(122,167,224,0.3)",
  }[tint] || "var(--border-2)";
  if (data == null) return null;
  const isPlainObject = typeof data === "object" && !Array.isArray(data);
  const entries = isPlainObject ? Object.entries(data) : null;
  return (
    <div style={{
      background: "var(--bg-2)",
      border: "1px solid var(--border-1)",
      borderLeft: `2px solid ${tintColor}`,
      borderRadius: "var(--r-sm)",
      padding: "7px 10px",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-2)",
      overflow: "auto",
    }}>
      {entries ? entries.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 8, padding: "1px 0" }}>
          <span style={{ color: "var(--text-3)", minWidth: 70 }}>{k}:</span>
          <span style={{ color: "var(--text-1)", whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>
            {formatValue(v)}
          </span>
        </div>
      )) : (
        <span style={{ color: "var(--text-1)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {formatValue(data)}
        </span>
      )}
    </div>
  );
};

function formatValue(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object" && v !== null) return JSON.stringify(v, null, 2);
  return String(v);
}

export { LogColumn };
