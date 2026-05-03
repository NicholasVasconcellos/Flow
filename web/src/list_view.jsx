import React from 'react';
import { I } from './icons.jsx';
import { StagePill, StatusBadge } from './primitives.jsx';
import { StatusFilterButton } from './dag_view.jsx';

// List View — chronological task table. Alternate rendering of the same task
// set as DAGView; same prop contract.

const COLS = [
  { id: "n",         label: "#",         width: 36,                align: "right",  mono: true },
  { id: "title",     label: "Title",     flex: 2, minWidth: 220,   align: "left" },
  { id: "stage",     label: "Stage",     width: 110,               align: "left" },
  { id: "status",    label: "Status",    width: 100,               align: "left" },
  { id: "started",   label: "Started",   width: 96,                align: "left",   mono: true },
  { id: "completed", label: "Completed", width: 96,                align: "left",   mono: true },
  { id: "duration",  label: "Duration",  width: 80,                align: "right",  mono: true },
  { id: "retries",   label: "Retries",   width: 60,                align: "right",  mono: true },
  { id: "deps",      label: "Deps",      width: 50,                align: "right",  mono: true },
  { id: "error",     label: "Error",     flex: 1, minWidth: 140,   align: "left" },
];

function pad2(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTs(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDuration(startedAt, completedAt) {
  if (!startedAt) return "—";
  if (!completedAt) return "running";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function sortTasks(tasks) {
  // Started tasks first, ordered by startedAt ASC. Unstarted tasks tail,
  // ordered by createdAt ASC.
  return tasks.slice().sort((a, b) => {
    const aStarted = a.startedAt ? new Date(a.startedAt).getTime() : Infinity;
    const bStarted = b.startedAt ? new Date(b.startedAt).getTime() : Infinity;
    if (aStarted !== bStarted) return aStarted - bStarted;
    const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aCreated - bCreated;
  });
}

const cellBaseStyle = (col) => ({
  flex: col.flex ? `${col.flex} 0 ${col.minWidth ?? 0}px` : `0 0 ${col.width}px`,
  minWidth: col.minWidth ?? 0,
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  justifyContent: col.align === "right" ? "flex-end" : "flex-start",
  fontFamily: col.mono ? "var(--font-mono)" : undefined,
  fontVariantNumeric: col.mono ? "tabular-nums" : undefined,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

const ListView = ({ tasks, selectedId, onSelect, hoveredId, onHover, statusFilter, onChangeStatusFilter }) => {
  const visible = React.useMemo(
    () => sortTasks(tasks.filter(t => statusFilter.has(t.status))),
    [tasks, statusFilter],
  );

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      width: "100%", height: "100%",
      background: "var(--bg-0)",
      minHeight: 0,
    }}>
      {/* Controls strip — mirrors the DAG control bar */}
      <div style={{
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10,
        borderBottom: "1px solid var(--border-1)",
        background: "var(--bg-0)",
        flexShrink: 0,
      }}>
        <StatusFilterButton tasks={tasks} statusFilter={statusFilter} onChange={onChangeStatusFilter}/>
        <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
          {visible.length} of {tasks.length} tasks
        </div>
      </div>

      {visible.length === 0 ? (
        <div style={{
          flex: 1,
          display: "grid", placeItems: "center",
          color: "var(--text-3)", fontSize: 12,
        }}>
          No tasks
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div className="list-view" role="table">
            {/* Header */}
            <div className="list-header" role="row">
              {COLS.map(c => (
                <div key={c.id} role="columnheader" style={cellBaseStyle(c)}>
                  {c.label}
                </div>
              ))}
            </div>
            {/* Rows */}
            {visible.map((t, i) => (
              <ListRow
                key={t.id}
                task={t}
                index={i}
                selected={selectedId === t.id}
                hovered={hoveredId === t.id}
                onSelect={onSelect}
                onHover={onHover}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ListRow = ({ task, index, selected, hovered, onSelect, onHover }) => {
  const t = task;
  const totalRetries = (t.retries || 0) + (t.transientRetries || 0);
  const deps = t.deps || [];
  const errMsg = t.lastError
    ? (typeof t.lastError === "string" ? t.lastError : (t.lastError.message || "error"))
    : null;

  return (
    <div
      role="row"
      className={`list-row${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      onClick={() => onSelect(t.id)}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div role="cell" style={{ ...cellBaseStyle(COLS[0]), color: "var(--text-4)" }}>
        {index + 1}
      </div>
      <div role="cell" style={cellBaseStyle(COLS[1])} title={t.title}>
        <span style={{ color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {t.title}
        </span>
      </div>
      <div role="cell" style={cellBaseStyle(COLS[2])}>
        <StagePill stage={t.stage}/>
      </div>
      <div role="cell" style={cellBaseStyle(COLS[3])}>
        <StatusBadge status={t.status}/>
      </div>
      <div role="cell" style={{ ...cellBaseStyle(COLS[4]), color: t.startedAt ? "var(--text-2)" : "var(--text-4)" }}>
        {fmtTs(t.startedAt)}
      </div>
      <div role="cell" style={{ ...cellBaseStyle(COLS[5]), color: t.completedAt ? "var(--text-2)" : "var(--text-4)" }}>
        {fmtTs(t.completedAt)}
      </div>
      <div role="cell" style={{ ...cellBaseStyle(COLS[6]), color: !t.startedAt ? "var(--text-4)" : t.completedAt ? "var(--text-2)" : "var(--accent)" }}>
        {fmtDuration(t.startedAt, t.completedAt)}
      </div>
      <div role="cell" style={{ ...cellBaseStyle(COLS[7]), color: totalRetries > 0 ? "var(--warn)" : "var(--text-4)" }}>
        {totalRetries > 0 ? totalRetries : "—"}
      </div>
      <div role="cell" style={{ ...cellBaseStyle(COLS[8]), color: deps.length > 0 ? "var(--text-2)" : "var(--text-4)" }}
           title={deps.length > 0 ? deps.join(", ") : undefined}>
        {deps.length}
      </div>
      <div role="cell" style={cellBaseStyle(COLS[9])}>
        {errMsg && (
          <span className="badge err" style={{ fontSize: 10, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
                title={errMsg}>
            <I.AlertCirc size={10}/>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{errMsg}</span>
          </span>
        )}
      </div>
    </div>
  );
};

export { ListView };
