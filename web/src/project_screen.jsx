import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { I } from './icons.jsx';
import { Panel } from './primitives.jsx';
import { DAGView, ALL_STATUSES } from './dag_view.jsx';
import { LogColumn } from './log_column.jsx';
import { TaskDetailsPanel } from './task_details.jsx';
import { ContextChartsPanel, LearningsPanel, NotificationsPanel } from './side_panels.jsx';
import { useFlowData } from './FlowDataContext.jsx';
import {
  defaultTree,
  flattenTreeToCol,
  flattenTreeToRow,
  collectLeafIds,
  validateTree,
  insertAdjacent,
} from './layout_tree.jsx';

// Project Screen — recursive split-tree layout with edge-snap drag-docking.
// Drop a pane on the top/right/bottom/left strip of any other pane to dock it
// there. The tree compacts itself so single-child splits get unwrapped.

const STORAGE_KEY = "flow.layout.v4";
const VIEW_MODE_KEY = "flow.dag.viewMode";

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.tree) return null;
    if (!validateTree(parsed.tree)) return null;
    return parsed;
  } catch { return null; }
}
function saveLayout(layout) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch {}
}
function loadViewMode() {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    return v === "line" || v === "tree" ? v : "tree";
  } catch { return "tree"; }
}

const ProjectScreen = () => {
  const { TASKS, SESSIONS } = useFlowData();

  // ---- Layout state ----
  const initial = loadLayout();
  const [tree, setTree] = useState(initial?.tree || defaultTree());

  useEffect(() => { saveLayout({ tree }); }, [tree]);

  const resetLayout = () => setTree(defaultTree());
  const flattenTo = (mode) => {
    const ids = collectLeafIds(tree);
    setTree(mode === "row" ? flattenTreeToRow(ids) : flattenTreeToCol(ids));
  };
  // For Settings dropdown: figure out current "shape" if it's a flat split.
  const flatDir = (tree.type === "split" && tree.children.every(c => c.type === "leaf")) ? tree.dir : null;

  // ---- Drag state ----
  const [dragging, setDragging] = useState(null);     // id being dragged
  const [hover, setHover] = useState(null);           // { id, edge }

  const onPaneDragStart = (id) => (e) => {
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch {}
    setDragging(id);
  };
  const onPaneDragEnd = () => { setDragging(null); setHover(null); };

  const onEdgeOver = (id, edge) => (e) => {
    if (!dragging || dragging === id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setHover({ id, edge });
  };
  const onEdgeDrop = (id, edge) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragging || dragging === id) { setDragging(null); setHover(null); return; }
    setTree(t => insertAdjacent(t, id, edge, dragging));
    setDragging(null);
    setHover(null);
  };

  // ---- Selected task / sessions ----
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [statusFilter, setStatusFilter] = useState(() => new Set(ALL_STATUSES));
  const [viewMode, setViewMode] = useState(loadViewMode);
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch {}
  }, [viewMode]);

  const [closedSessionIds, setClosedSessionIds] = useState(() => new Set());
  const [logCollapsed, setLogCollapsed] = useState({});
  const [logWidths, setLogWidths] = useState({});
  const [paneCollapsed, setPaneCollapsed] = useState({});
  const togglePane = (id) => setPaneCollapsed(s => ({ ...s, [id]: !s[id] }));

  const startLogResize = (sid) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = logWidths[sid] ?? 360;
    const onMove = (ev) => {
      const next = Math.max(240, Math.min(900, startW + (ev.clientX - startX)));
      setLogWidths(w => ({ ...w, [sid]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const [rightMode, setRightMode] = useState("task");

  useEffect(() => {
    setClosedSessionIds(new Set());
    setLogCollapsed({});
  }, [selectedId]);

  const logSessionIds = useMemo(
    () => SESSIONS
      .filter(s => s.taskId === selectedId && !closedSessionIds.has(s.id))
      .map(s => s.id),
    [SESSIONS, selectedId, closedSessionIds],
  );

  const closeLog = (sid) =>
    setClosedSessionIds(s => { const n = new Set(s); n.add(sid); return n; });
  const toggleLogCollapse = (sid) => setLogCollapsed(s => ({ ...s, [sid]: !s[sid] }));
  const openLog = (sid) => {
    setClosedSessionIds(s => {
      if (!s.has(sid)) return s;
      const n = new Set(s); n.delete(sid); return n;
    });
    setLogCollapsed(s => ({ ...s, [sid]: false }));
    requestAnimationFrame(() => {
      const wrap = document.querySelector(`[data-log-sid="${sid}"]`);
      const el = wrap && wrap.firstElementChild;
      if (!el) return;
      el.classList.remove("flash-focus");
      void el.offsetWidth;
      el.classList.add("flash-focus");
      const container = el.closest('[data-logs-scroller]');
      if (container && container.scrollTo) {
        const left = el.offsetLeft - 8;
        try { container.scrollTo({ left, behavior: "smooth" }); } catch (e) { container.scrollLeft = left; }
      }
    });
  };

  // ---- Pane renderers ----
  const paneRenderers = {
    dag: (dragHandleProps) => (
      <Panel
        style={{ flex: 1, minHeight: 0 }}
        icon={<I.Layout size={13}/>}
        title="Task DAG"
        count={TASKS.length}
        badge={<span className="badge accent" style={{ fontSize: 10 }}>running</span>}
        dragHandleProps={dragHandleProps}
        collapsed={!!paneCollapsed.dag}
        onToggleCollapse={() => togglePane("dag")}
      >
        <DAGView
          tasks={TASKS}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setRightMode("task"); }}
          hoveredId={hoveredId}
          onHover={setHoveredId}
          statusFilter={statusFilter}
          onChangeStatusFilter={setStatusFilter}
          viewMode={viewMode}
          onChangeViewMode={setViewMode}
        />
      </Panel>
    ),
    sessions: (dragHandleProps) => (
      <SessionsPane
        logSessionIds={logSessionIds}
        logCollapsed={logCollapsed}
        logWidths={logWidths}
        startLogResize={startLogResize}
        closeLog={closeLog}
        dragHandleProps={dragHandleProps}
        collapsed={!!paneCollapsed.sessions}
        onToggleCollapse={() => togglePane("sessions")}
      />
    ),
    details: (dragHandleProps) => (
      <DetailsPane
        mode={rightMode}
        setMode={setRightMode}
        selectedId={selectedId}
        openLog={openLog}
        openLogIds={logSessionIds}
        dragHandleProps={dragHandleProps}
        collapsed={!!paneCollapsed.details}
        onToggleCollapse={() => togglePane("details")}
      />
    ),
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-0)" }}>
      <TopBar
        onResetLayout={resetLayout}
        flatDir={flatDir}
        onFlatten={flattenTo}
      />

      <div style={{ flex: 1, minHeight: 0, padding: 10, position: "relative" }}>
        <TreeRenderer
          node={tree}
          paneRenderers={paneRenderers}
          paneCollapsed={paneCollapsed}
          dragging={dragging}
          hover={hover}
          onPaneDragStart={onPaneDragStart}
          onPaneDragEnd={onPaneDragEnd}
          onEdgeOver={onEdgeOver}
          onEdgeDrop={onEdgeDrop}
          setTree={setTree}
        />
      </div>
    </div>
  );
};

// ---- Tree renderer ----
// A subtree is "fully collapsed" if every leaf inside it is collapsed.
// In that case, its wrapper takes flex: 0 0 auto so siblings can reflow.
function isSubtreeFullyCollapsed(node, paneCollapsed) {
  if (node.type === "leaf") return !!paneCollapsed[node.id];
  return node.children.every(c => isSubtreeFullyCollapsed(c, paneCollapsed));
}

const TreeRenderer = (props) => {
  const { node } = props;
  if (node.type === "leaf") return <LeafRenderer {...props} />;
  return <SplitRenderer {...props} />;
};

const LeafRenderer = ({ node, paneRenderers, paneCollapsed, dragging, hover, onPaneDragStart, onPaneDragEnd, onEdgeOver, onEdgeDrop, leafFlex }) => {
  const id = node.id;
  const isDragged = dragging === id;
  const isCollapsed = !!paneCollapsed[id];
  const dragHandleProps = {
    draggable: true,
    onDragStart: onPaneDragStart(id),
    onDragEnd: onPaneDragEnd,
  };
  return (
    <div style={{
      flex: isCollapsed ? "0 0 auto" : 1,
      minWidth: isCollapsed ? 32 : 0,
      minHeight: isCollapsed ? 28 : 0,
      display: "flex",
      flexDirection: "column",
      position: "relative",
      opacity: isDragged ? 0.45 : 1,
      transition: "opacity 0.15s",
    }}>
      {paneRenderers[id](dragHandleProps)}
      {/* Edge drop overlay — only shown while dragging another pane */}
      {dragging && dragging !== id && (
        <EdgeOverlay
          id={id}
          hoverEdge={hover && hover.id === id ? hover.edge : null}
          onEdgeOver={onEdgeOver}
          onEdgeDrop={onEdgeDrop}
        />
      )}
    </div>
  );
};

const SplitRenderer = ({ node, paneCollapsed, ...rest }) => {
  const isRow = node.dir === "row";
  // Compute effective sizes: children that are fully collapsed take 0 share; the
  // remaining flex weight is distributed across non-collapsed siblings via the
  // child wrapper's flex value below.
  const collapsedChildren = node.children.map(c => isSubtreeFullyCollapsed(c, paneCollapsed));
  const nonCollapsedTotal = node.sizes.reduce((s, n, i) => s + (collapsedChildren[i] ? 0 : n), 0) || 1;

  // Resizers are useless when one of the two adjacent children is fully collapsed
  // (no space to redistribute). Hide them in that case.
  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: isRow ? "row" : "column",
      minWidth: 0,
      minHeight: 0,
      gap: 0,
      width: "100%",
      height: "100%",
    }}>
      {node.children.map((child, i) => {
        const childCollapsed = collapsedChildren[i];
        const childFlex = childCollapsed ? "0 0 auto" : `${node.sizes[i] / nonCollapsedTotal} 1 0%`;
        const showResizerAfter = i < node.children.length - 1 && !collapsedChildren[i] && !collapsedChildren[i + 1];
        return (
          <React.Fragment key={i}>
            <div style={{
              flex: childFlex,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              position: "relative",
              transition: "flex-basis 0.18s ease, flex-grow 0.18s ease",
            }}>
              <TreeRenderer node={child} paneCollapsed={paneCollapsed} {...rest} leafFlex={childFlex} />
            </div>
            {i < node.children.length - 1 && showResizerAfter && (
              <SplitResizer
                isRow={isRow}
                dragging={rest.dragging}
                onPointerDown={(e) => startSplitResize(e, node, i, rest.setTree, isRow)}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const SplitResizer = ({ isRow, onPointerDown, dragging }) => (
  <div
    className={`resizer ${isRow ? "v" : "h"}${dragging ? " dragging" : ""}`}
    onPointerDown={onPointerDown}
    style={{
      position: "relative",
      zIndex: dragging ? 0 : 1,
    }}
  />
);

// Resize between siblings of a particular split node. Mutates by `setTree`.
function startSplitResize(e, splitNode, leftIdx, setTree, isRow) {
  e.preventDefault();
  const target = e.currentTarget;
  const pointerId = e.pointerId;
  try { target.setPointerCapture(pointerId); } catch (_) { /* ignore */ }
  const startPos = isRow ? e.clientX : e.clientY;
  const startSizes = splitNode.sizes.slice();
  const total = startSizes[leftIdx] + startSizes[leftIdx + 1];
  // We need to know the pixel size of the (left+right) pair. Use the resizer's
  // parent (the split row/column).
  const parent = target && target.parentElement;
  const rect = parent ? parent.getBoundingClientRect() : null;
  const containerSize = rect ? (isRow ? rect.width : rect.height) : 1000;
  const sumAll = startSizes.reduce((s, n) => s + n, 0);
  const pairPx = (total / sumAll) * containerSize;

  const onMove = (ev) => {
    const cur = isRow ? ev.clientX : ev.clientY;
    const d = (cur - startPos) / pairPx;
    let nl = startSizes[leftIdx] + d * total;
    let nr = startSizes[leftIdx + 1] - d * total;
    const min = 0.18;
    if (nl < min) { nr = total - min; nl = min; }
    if (nr < min) { nl = total - min; nr = min; }
    setTree(t => updateSizesAtNode(t, splitNode, (sizes) => {
      const next = sizes.slice();
      next[leftIdx] = nl;
      next[leftIdx + 1] = nr;
      return next;
    }));
  };
  const cleanup = () => {
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", cleanup);
    target.removeEventListener("pointercancel", cleanup);
    try { target.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    document.body.style.cursor = "";
  };
  document.body.style.cursor = isRow ? "col-resize" : "row-resize";
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", cleanup);
  target.addEventListener("pointercancel", cleanup);
}

// Find a split node in the tree that has the same shape (children leaf ids and dir)
// as `target`, and update its sizes via fn. Identity match by (dir + child leaf ids order).
function updateSizesAtNode(root, target, fn) {
  const targetSig = nodeSig(target);
  let updated = false;
  function walk(n) {
    if (n.type === "leaf") return n;
    if (!updated && nodeSig(n) === targetSig) {
      updated = true;
      return { type: "split", dir: n.dir, children: n.children.map(walk), sizes: fn(n.sizes) };
    }
    return { type: "split", dir: n.dir, children: n.children.map(walk), sizes: n.sizes.slice() };
  }
  return walk(root);
}
function nodeSig(n) {
  if (n.type === "leaf") return "L:" + n.id;
  return n.dir + "(" + n.children.map(nodeSig).join(",") + ")";
}

// ---- Edge overlay (drop targets on a leaf) ----
const EdgeOverlay = ({ id, hoverEdge, onEdgeOver, onEdgeDrop }) => {
  // 4 strips, ~28% each side. They overlap in corners — corners go to whichever
  // side's strip is on top. We give horizontal strips (top/bottom) priority on
  // the corners by stacking them last.
  const stripPct = 28;
  const strip = (edge) => {
    const active = hoverEdge === edge;
    const isVert = edge === "left" || edge === "right";
    const base = {
      position: "absolute",
      [isVert ? "top" : "left"]: 0,
      [isVert ? "bottom" : "right"]: 0,
      [edge]: 0,
      [isVert ? "width" : "height"]: stripPct + "%",
      zIndex: 50,
    };
    return (
      <div
        key={edge}
        onDragOver={onEdgeOver(id, edge)}
        onDragEnter={onEdgeOver(id, edge)}
        onDrop={onEdgeDrop(id, edge)}
        style={base}
      />
    );
  };
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 40 }}>
      {/* the strip divs themselves do receive pointer events */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}>
        {strip("left")}
        {strip("right")}
        {strip("top")}
        {strip("bottom")}
      </div>
      {/* Preview: where the dragged pane would land, accent-colored */}
      {hoverEdge && <DropPreview edge={hoverEdge}/>}
    </div>
  );
};

const DropPreview = ({ edge }) => {
  const isVert = edge === "left" || edge === "right";
  const halfStyle = {
    position: "absolute",
    [edge]: 0,
    [isVert ? "top" : "left"]: 0,
    [isVert ? "bottom" : "right"]: 0,
    [isVert ? "width" : "height"]: "50%",
    background: "color-mix(in oklch, var(--accent) 18%, transparent)",
    border: "2px dashed var(--accent)",
    borderRadius: 6,
    pointerEvents: "none",
    transition: "all 0.12s ease-out",
  };
  return <div style={halfStyle}/>;
};

// ---- Sessions pane ----
const SessionsPane = ({ logSessionIds, logCollapsed, logWidths, startLogResize, closeLog, dragHandleProps, collapsed, onToggleCollapse }) => {
  const { SESSIONS, LOG_EVENTS } = useFlowData();
  return (
    <Panel
      style={{ flex: 1, minHeight: 0 }}
      icon={<I.Terminal size={13}/>}
      title="Sessions"
      count={logSessionIds.length}
      dragHandleProps={dragHandleProps}
      bodyStyle={{ padding: 0 }}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
    >
      <div
        data-logs-scroller
        style={{
          display: "flex",
          gap: 8,
          padding: 10,
          minHeight: 0,
          height: "100%",
          overflowX: "auto",
          overflowY: "hidden",
        }}
      >
        {logSessionIds.length === 0 && (
          <div style={{
            flex: 1, display: "grid", placeItems: "center",
            background: "var(--bg-1)",
            border: "1px dashed var(--border-1)",
            borderRadius: "var(--r-md)",
            color: "var(--text-3)", fontSize: 12,
          }}>
            No sessions open. Click a task in the DAG.
          </div>
        )}
        {logSessionIds.map((sid, idx) => {
          const session = SESSIONS.find(s => s.id === sid);
          if (!session) return null;
          const isLast = idx === logSessionIds.length - 1;
          return (
            <React.Fragment key={sid}>
              <div data-log-sid={sid} style={{ display: "contents" }}>
                <LogColumn
                  session={session}
                  events={LOG_EVENTS}
                  onClose={() => closeLog(sid)}
                  collapsed={logCollapsed[sid]}
                  fixedWidth={logWidths[sid]}
                />
              </div>
              {!isLast && !logCollapsed[sid] && (
                <div className="resizer v" onMouseDown={startLogResize(sid)} style={{ alignSelf: "stretch", flexShrink: 0 }}/>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </Panel>
  );
};

// ---- Details pane ----
const DetailsPane = ({ mode, setMode, selectedId, openLog, openLogIds, dragHandleProps, collapsed, onToggleCollapse }) => {
  const { LEARNINGS, NOTIFICATIONS } = useFlowData();
  const tabs = [
    { id: "task",          label: "Task",          icon: <I.Info size={12}/> },
    { id: "context",       label: "Context",       icon: <I.Cpu size={12}/> },
    { id: "learnings",     label: "Learnings",     icon: <I.Lightbulb size={12}/>, count: LEARNINGS.length },
    { id: "notifications", label: "Alerts",        icon: <I.Bell size={12}/>, count: NOTIFICATIONS.length, urgent: true },
  ];

  const tabBarRef = React.useRef(null);
  const [compact, setCompact] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = tabBarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setCompact(entry.contentRect.width < 360);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const panelTitleMap = {
    task:          { title: "Task details", icon: <I.Info size={13}/> },
    context:       { title: "Context usage", icon: <I.Cpu size={13}/> },
    learnings:     { title: "Learnings", icon: <I.Lightbulb size={13}/>, count: LEARNINGS.length },
    notifications: { title: "Notifications", icon: <I.Bell size={13}/>, count: NOTIFICATIONS.length },
  };
  const cur = panelTitleMap[mode];

  return (
    <Panel
      style={{ flex: 1, minHeight: 0 }}
      icon={cur.icon}
      title={cur.title}
      count={cur.count}
      dragHandleProps={dragHandleProps}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      headerExtra={
        <div ref={tabBarRef} style={{
          display: "flex",
          background: "var(--bg-2)",
          border: "1px solid var(--border-1)",
          borderRadius: "var(--r-md)",
          padding: 2,
          gap: 1,
          minWidth: 0,
          flex: 1,
          marginLeft: 8,
          overflow: "hidden",
        }}>
          {tabs.map(t => {
            const active = mode === t.id;
            return (
              <button key={t.id} onClick={() => setMode(t.id)}
                title={t.label}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
                  padding: compact ? "4px 2px" : "4px 4px",
                  borderRadius: "var(--r-sm)",
                  background: active ? "var(--bg-4)" : "transparent",
                  color: active ? "var(--text-1)" : "var(--text-3)",
                  fontSize: 11, fontWeight: 500,
                  overflow: "hidden",
                  border: "none",
                  cursor: "pointer",
                }}>
                {t.icon}
                {!compact && (
                  <span style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
                  }}>{t.label}</span>
                )}
                {t.count > 0 && (
                  <span style={{
                    fontSize: 9.5, fontWeight: 600,
                    padding: "1px 5px", borderRadius: 999,
                    background: t.urgent ? "var(--err)" : "var(--bg-4)",
                    color: t.urgent ? "#1a1a19" : "var(--text-2)",
                  }}>{t.count}</span>
                )}
              </button>
            );
          })}
        </div>
      }
    >
      {mode === "task" && <TaskDetailsPanel taskId={selectedId} openLog={openLog} openLogIds={openLogIds}/>}
      {mode === "context" && <ContextChartsPanel/>}
      {mode === "learnings" && <LearningsPanel/>}
      {mode === "notifications" && <NotificationsPanel/>}
    </Panel>
  );
};

const ProjectStatusPill = () => {
  const { TASKS } = useFlowData();
  const total = TASKS.length;
  const running = TASKS.filter(t => t.status === "running").length;
  const blocked = TASKS.filter(t => t.status === "blocked").length;
  const done = TASKS.filter(t => t.status === "done").length;
  const dotClass = blocked > 0 ? "err" : running > 0 ? "" : "ok";
  const dotStyle = (!blocked && running > 0) ? { background: "var(--accent)", boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 22%, transparent)" } : undefined;
  return (
    <span className="status-pill" title={`${done} done · ${running} running · ${blocked} blocked · ${total - done - running - blocked} other`} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
      <span className={`dot ${dotClass}`} style={dotStyle}/>
      {total} tasks · {running} running{blocked > 0 ? ` · ${blocked} blocked` : ""}
    </span>
  );
};

// Parse `org/repo` out of common git remote URL forms:
//   https://github.com/org/repo(.git)?
//   git@github.com:org/repo(.git)?
//   ssh://git@github.com/org/repo(.git)?
// Returns null if the URL doesn't match — caller hides the button.
const parseRepoSlug = (url) => {
  if (!url) return null;
  const m =
    url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
};

const TopBar = ({ onResetLayout, flatDir, onFlatten }) => {
  const { PROJECT_NAME, PROJECT_PATH, GIT_REMOTE } = useFlowData();
  const repoSlug = parseRepoSlug(GIT_REMOTE);
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <div className="topbar" style={{ flexWrap: "nowrap", overflow: "visible" }}>
      <a href="Home.html" className="brand" style={{ textDecoration: "none", color: "var(--text-1)", flexShrink: 0 }}>
        <div className="brand-mark">F</div>
        Flow
      </a>
      <div className="crumb" style={{ display: "flex", alignItems: "center", minWidth: 0, flexShrink: 1, overflow: "hidden" }}>
        <a href="Home.html" style={{ color: "var(--text-3)", textDecoration: "none", flexShrink: 0 }}>Projects</a>
        <span className="sep">/</span>
        <span className="cur" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{PROJECT_NAME}</span>
      </div>
      <span className="mono" style={{ fontSize: 11, color: "var(--text-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 }}>{PROJECT_PATH}</span>
      <div style={{ flex: 1, minWidth: 8 }}/>
      <ProjectStatusPill/>
      {repoSlug && (
        <button className="btn sm" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
          <I.Github size={12}/> {repoSlug}
        </button>
      )}
      <button className="btn sm primary" style={{ whiteSpace: "nowrap", flexShrink: 0 }} disabled title="task.create command not yet implemented"><I.Plus size={12}/> New task</button>
      <button className="icon-btn" style={{ flexShrink: 0 }}><I.Bell size={14}/></button>
      <div ref={settingsRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          className="icon-btn"
          onClick={() => setMenuOpen(o => !o)}
          style={menuOpen ? { background: "var(--bg-3)", color: "var(--text-1)" } : undefined}
          aria-label="Settings"
        >
          <I.Settings size={14}/>
        </button>
        {menuOpen && (
          <div style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 240,
            background: "var(--bg-1)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--r-md)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            padding: 6,
            zIndex: 100,
            fontSize: 12,
          }}>
            <div style={{ padding: "6px 10px 4px", color: "var(--text-3)", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Flatten layout</div>
            <div style={{ padding: "2px 6px 6px" }}>
              <div style={{
                display: "flex",
                background: "var(--bg-2)",
                border: "1px solid var(--border-1)",
                borderRadius: "var(--r-sm)",
                padding: 2,
                gap: 1,
              }}>
                {[
                  { id: "col", label: "Rows", hint: "stacked top to bottom" },
                  { id: "row", label: "Columns", hint: "side by side" },
                ].map(opt => {
                  const active = flatDir === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => { onFlatten(opt.id); }}
                      title={opt.hint}
                      style={{
                        flex: 1,
                        padding: "6px 8px",
                        borderRadius: 4,
                        background: active ? "var(--bg-4)" : "transparent",
                        color: active ? "var(--text-1)" : "var(--text-3)",
                        fontSize: 11,
                        fontWeight: 500,
                        border: "none",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                      }}
                    >
                      {opt.id === "col" ? <RowsGlyph/> : <ColumnsGlyph/>}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-4)", padding: "6px 2px 0" }}>
                Or drag panel headers to dock on any edge.
              </div>
            </div>
            <button
              onClick={() => { onResetLayout(); setMenuOpen(false); }}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "var(--text-2)",
                fontSize: 12,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--bg-3)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <I.Layout size={12}/> Reset layout
            </button>
            <div style={{ height: 1, background: "var(--border-1)", margin: "4px 6px" }}/>
            <button
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "var(--text-2)",
                fontSize: 12,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--bg-3)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <I.Settings size={12}/> Preferences…
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const RowsGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="9" height="2.3" rx="0.6"/>
    <rect x="1.5" y="4.85" width="9" height="2.3" rx="0.6"/>
    <rect x="1.5" y="8.2" width="9" height="2.3" rx="0.6"/>
  </svg>
);
const ColumnsGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="1.5" y="1.5" width="2.3" height="9" rx="0.6"/>
    <rect x="4.85" y="1.5" width="2.3" height="9" rx="0.6"/>
    <rect x="8.2" y="1.5" width="2.3" height="9" rx="0.6"/>
  </svg>
);

export { ProjectScreen };
