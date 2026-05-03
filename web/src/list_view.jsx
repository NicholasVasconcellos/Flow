import React from 'react';
import { I } from './icons.jsx';
import { StagePill, StatusBadge } from './primitives.jsx';
import { StatusFilterButton } from './dag_view.jsx';
import { fmtRelative, fmtAbsolute, useNowTick } from './timeUtils.js';

// List View — chronological task table. Alternate rendering of the same task
// set as DAGView; same prop contract.

const COLS = [
  { id: "n",         label: "#",         width: 44,                align: "right",  mono: true },
  { id: "title",     label: "Title",     width: 320, minWidth: 120, align: "left" },
  { id: "stage",     label: "Stage",     width: 110,               align: "left" },
  { id: "status",    label: "Status",    width: 100,               align: "left" },
  { id: "started",   label: "Started",   width: 70,                align: "left",   mono: true },
  { id: "completed", label: "Completed", width: 70,                align: "left",   mono: true },
  { id: "duration",  label: "Duration",  width: 80,                align: "right",  mono: true },
  { id: "retries",   label: "Retries",   width: 60,                align: "right",  mono: true },
  { id: "deps",      label: "Deps",      width: 110,               align: "left",   mono: true },
  { id: "error",     label: "Error",     width: 200, minWidth: 100, align: "left" },
];

const COL_MIN = 30;
const COL_MAX = 800;
const WIDTHS_KEY = "flow.listview.widths.v1";

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

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

function loadWidths() {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === COLS.length) return arr.map(Number);
  } catch { /* ignore */ }
  return null;
}

function saveWidths(arr) {
  try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

const cellBaseStyle = (col) => ({
  padding: "6px 8px",
  display: "flex",
  alignItems: "center",
  justifyContent: col.align === "right" ? "flex-end" : "flex-start",
  fontFamily: col.mono ? "var(--font-mono)" : undefined,
  fontVariantNumeric: col.mono ? "tabular-nums" : undefined,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  minWidth: 0,
  overflow: "hidden",
});

const ListView = ({ tasks, selectedId, onSelect, hoveredId, onHover, statusFilter, onChangeStatusFilter }) => {
  const [widths, setWidths] = React.useState(() => loadWidths() || COLS.map(c => c.width));
  React.useEffect(() => { saveWidths(widths); }, [widths]);
  useNowTick(30_000);

  const sorted = React.useMemo(() => sortTasks(tasks), [tasks]);
  const visible = React.useMemo(
    () => sorted.filter(t => statusFilter.has(t.status)),
    [sorted, statusFilter],
  );

  // Stable display number per task (across the full sorted list, not the
  // filtered visible list) — keeps the # column and dep chips in sync.
  const taskNum = React.useMemo(() => {
    const m = new Map();
    sorted.forEach((t, i) => m.set(t.id, i + 1));
    return m;
  }, [sorted]);

  const tasksById = React.useMemo(() => {
    const m = new Map();
    tasks.forEach(t => m.set(t.id, t));
    return m;
  }, [tasks]);

  const rowRefs = React.useRef({});
  const setRowRef = React.useCallback((id) => (el) => {
    if (el) rowRefs.current[id] = el;
    else delete rowRefs.current[id];
  }, []);

  const selectAndScroll = React.useCallback((id) => {
    onSelect(id);
    requestAnimationFrame(() => {
      const el = rowRefs.current[id];
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [onSelect]);

  const gridTemplate = widths.map(w => `${w}px`).join(" ");

  const onResize = React.useCallback((colIdx, deltaX, startW) => {
    setWidths(prev => prev.map((w, i) =>
      i === colIdx ? Math.min(COL_MAX, Math.max(COL_MIN, startW + deltaX)) : w,
    ));
  }, []);

  const tableRef = React.useRef(null);
  const onAutoFit = React.useCallback((colIdx) => {
    const root = tableRef.current;
    if (!root) return;
    const cells = root.querySelectorAll(`[data-col="${colIdx}"]`);
    let max = COL_MIN;
    cells.forEach((el) => {
      // Temporarily disable wrap to get true content width.
      const prevWS = el.style.whiteSpace;
      el.style.whiteSpace = "nowrap";
      const w = el.scrollWidth;
      el.style.whiteSpace = prevWS;
      if (w > max) max = w;
    });
    const padded = Math.min(COL_MAX, Math.max(COL_MIN, max + 16));
    setWidths(prev => prev.map((w, i) => i === colIdx ? padded : w));
  }, []);

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
          <div className="list-view" role="table" ref={tableRef}>
            {/* Header */}
            <div className="list-header" role="row" style={{ gridTemplateColumns: gridTemplate }}>
              {COLS.map((c, i) => (
                <div key={c.id} role="columnheader" className="list-cell list-headercell" style={{
                  ...cellBaseStyle(c),
                  whiteSpace: "nowrap",
                }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                  {i < COLS.length - 1 && (
                    <ResizeHandle
                      colIdx={i}
                      width={widths[i]}
                      onResize={onResize}
                      onAutoFit={onAutoFit}
                    />
                  )}
                </div>
              ))}
            </div>
            {/* Rows */}
            {visible.map((t) => (
              <ListRow
                key={t.id}
                task={t}
                num={taskNum.get(t.id)}
                taskNum={taskNum}
                tasksById={tasksById}
                selected={selectedId === t.id}
                hovered={hoveredId === t.id}
                onSelect={onSelect}
                onHover={onHover}
                onDepClick={selectAndScroll}
                gridTemplate={gridTemplate}
                rowRef={setRowRef(t.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ResizeHandle = ({ colIdx, width, onResize, onAutoFit }) => {
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (m) => onResize(colIdx, m.clientX - startX, startW);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onDoubleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onAutoFit(colIdx);
  };
  return (
    <span
      className="col-resize"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title="Drag to resize · double-click to fit"
    />
  );
};

const ListRow = ({ task, num, taskNum, tasksById, selected, hovered, onSelect, onHover, onDepClick, gridTemplate, rowRef }) => {
  const t = task;
  const totalRetries = (t.retries || 0) + (t.transientRetries || 0);
  const deps = t.deps || [];
  const errMsg = t.lastError
    ? (typeof t.lastError === "string" ? t.lastError : (t.lastError.message || "error"))
    : null;

  const startedRel = fmtRelative(t.startedAt);
  const completedRel = fmtRelative(t.completedAt);
  const startedAbs = fmtAbsolute(t.startedAt);
  const completedAbs = fmtAbsolute(t.completedAt);

  return (
    <div
      role="row"
      ref={rowRef}
      className={`list-row${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
      style={{ gridTemplateColumns: gridTemplate }}
      onClick={() => onSelect(t.id)}
      onMouseEnter={() => onHover(t.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div role="cell" data-col="0" className="list-cell" style={{ ...cellBaseStyle(COLS[0]), color: "var(--text-4)" }}>
        {num}
      </div>
      <div role="cell" data-col="1" className="list-cell" style={cellBaseStyle(COLS[1])} title={t.title}>
        <span style={{ color: "var(--text-1)" }}>{t.title}</span>
      </div>
      <div role="cell" data-col="2" className="list-cell" style={cellBaseStyle(COLS[2])}>
        <StagePill stage={t.stage}/>
      </div>
      <div role="cell" data-col="3" className="list-cell" style={cellBaseStyle(COLS[3])}>
        <StatusBadge status={t.status}/>
      </div>
      <div role="cell" data-col="4" className="list-cell" style={{ ...cellBaseStyle(COLS[4]), color: t.startedAt ? "var(--text-2)" : "var(--text-4)" }}
           title={startedAbs || undefined}>
        {t.startedAt ? startedRel : "—"}
      </div>
      <div role="cell" data-col="5" className="list-cell" style={{ ...cellBaseStyle(COLS[5]), color: t.completedAt ? "var(--text-2)" : "var(--text-4)" }}
           title={completedAbs || undefined}>
        {t.completedAt ? completedRel : "—"}
      </div>
      <div role="cell" data-col="6" className="list-cell" style={{ ...cellBaseStyle(COLS[6]), color: !t.startedAt ? "var(--text-4)" : t.completedAt ? "var(--text-2)" : "var(--accent)" }}>
        {fmtDuration(t.startedAt, t.completedAt)}
      </div>
      <div role="cell" data-col="7" className="list-cell" style={{ ...cellBaseStyle(COLS[7]), color: totalRetries > 0 ? "var(--warn)" : "var(--text-4)" }}>
        {totalRetries > 0 ? totalRetries : "—"}
      </div>
      <div role="cell" data-col="8" className="list-cell cell-deps" style={cellBaseStyle(COLS[8])}>
        {deps.length === 0 ? (
          <span style={{ color: "var(--text-4)" }}>—</span>
        ) : deps.map(depId => {
          const dep = tasksById.get(depId);
          const n = taskNum.get(depId);
          const label = n != null ? `#${n}` : `#?`;
          return (
            <button
              key={depId}
              type="button"
              className="dep-chip"
              title={dep ? `${label} ${dep.title}` : depId}
              onClick={(e) => { e.stopPropagation(); onDepClick(depId); }}
            >{label}</button>
          );
        })}
      </div>
      <div role="cell" data-col="9" className="list-cell" style={cellBaseStyle(COLS[9])}>
        {errMsg && (
          <span className="badge err" style={{ fontSize: 10, maxWidth: "100%" }}
                title={errMsg}>
            <I.AlertCirc size={10}/>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{errMsg}</span>
          </span>
        )}
      </div>
    </div>
  );
};

export { ListView };
