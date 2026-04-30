import React from 'react';
import { I } from './icons.jsx';

// DAG View — hierarchical top-to-bottom graph of tasks

const DAGView = ({ tasks, selectedId, onSelect, hoveredId, onHover, showAll, onToggleShowAll }) => {
  // Layout the DAG by phase (rows) and distribute x
  const phaseOrder = ["root", "spec", "execute", "test", "review", "document"];
  const byPhase = {};
  phaseOrder.forEach(p => byPhase[p] = []);
  tasks.forEach(t => (byPhase[t.phase] ||= []).push(t));

  // Filter if not showAll: only "ready" + running + their immediate deps for context
  const visibleIds = new Set();
  if (showAll) {
    tasks.forEach(t => visibleIds.add(t.id));
  } else {
    tasks.forEach(t => {
      if (t.status === "ready" || t.status === "running") {
        visibleIds.add(t.id);
        t.deps.forEach(d => visibleIds.add(d));
      }
    });
    if (visibleIds.size === 0) tasks.forEach(t => visibleIds.add(t.id));
  }

  // Compute layout positions
  const ROW_H = 110;
  const COL_W = 230;
  const PAD_X = 60;
  const PAD_Y = 40;

  // Assign x within phase by index, relative to 0
  const positions = {};
  phaseOrder.forEach((phase, rowIdx) => {
    const items = byPhase[phase].filter(t => visibleIds.has(t.id));
    items.sort((a, b) => a.x - b.x);
    const total = items.length;
    items.forEach((t, i) => {
      const offset = total === 1 ? 0 : (i - (total - 1) / 2);
      positions[t.id] = {
        x: offset * COL_W,
        y: PAD_Y + rowIdx * ROW_H,
      };
    });
  });

  // Compute bbox and shift everything so layout starts at PAD_X (accounting for node half-width 90)
  const xs = Object.values(positions).map(p => p.x);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 0;
  const NODE_HALF = 100;
  const shift = PAD_X + NODE_HALF - minX;
  Object.values(positions).forEach(p => { p.x += shift; });

  const W = Math.max(720, (maxX - minX) + (PAD_X + NODE_HALF) * 2);
  const H = PAD_Y + phaseOrder.length * ROW_H + 40;

  const visibleTasks = tasks.filter(t => visibleIds.has(t.id));

  // Center scroll on mount
  const scrollRef = React.useRef(null);
  const innerRef = React.useRef(null);
  const [zoom, setZoom] = React.useState(1);
  // Per-node drag offsets, keyed by task id: {dx, dy}
  const [offsets, setOffsets] = React.useState(() => {
    try {
      const raw = localStorage.getItem("flow.dag.layout");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [justSaved, setJustSaved] = React.useState(false);
  const [hoveredBtn, setHoveredBtn] = React.useState(null); // 'save' | 'realign' | null
  const dragState = React.useRef(null);
  const hasOffsets = Object.keys(offsets).length > 0;
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 2;
  const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  }, [showAll]);

  // Zoom around a focal point (client coords); keeps the point under the cursor stable
  const zoomAt = React.useCallback((nextZoom, clientX, clientY) => {
    const el = scrollRef.current;
    if (!el) return;
    const z0 = zoom;
    const z1 = clampZoom(nextZoom);
    if (z1 === z0) return;
    const rect = el.getBoundingClientRect();
    // If no focal point, use viewport center
    const cx = clientX == null ? rect.left + rect.width / 2 : clientX;
    const cy = clientY == null ? rect.top + rect.height / 2 : clientY;
    // Content point (in unscaled coords) under the cursor
    const contentX = (el.scrollLeft + (cx - rect.left)) / z0;
    const contentY = (el.scrollTop + (cy - rect.top)) / z0;
    setZoom(z1);
    // After the transform applies, restore so that the same content point sits under cursor
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (!el2) return;
      el2.scrollLeft = contentX * z1 - (cx - rect.left);
      el2.scrollTop = contentY * z1 - (cy - rect.top);
    });
  }, [zoom]);

  // Ctrl/Cmd + wheel → zoom; plain wheel → scroll normally
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = Math.pow(1.0015, -e.deltaY);
    zoomAt(zoom * factor, e.clientX, e.clientY);
  };

  // Keyboard shortcuts: Cmd/Ctrl + / - / 0 when the DAG is focused/hovered
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Only act if cursor is within the DAG area
      if (!el.matches(":hover")) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomAt(zoom * 1.2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAt(zoom / 1.2);
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, zoomAt]);

  // Click-and-drag panning on empty canvas
  const panState = React.useRef(null);
  const onPanDown = (e) => {
    // only start pan if target is the canvas background (not a node or button)
    if (e.target.closest("[data-dag-node], button, a")) return;
    const el = scrollRef.current;
    if (!el) return;
    panState.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false };
    el.style.cursor = "grabbing";
    e.preventDefault();
  };
  React.useEffect(() => {
    const onMove = (e) => {
      if (panState.current) {
        const el = scrollRef.current;
        if (!el) return;
        const dx = e.clientX - panState.current.x;
        const dy = e.clientY - panState.current.y;
        if (!panState.current.moved && Math.hypot(dx, dy) > 3) {
          panState.current.moved = true;
        }
        el.scrollLeft = panState.current.sl - dx;
        el.scrollTop = panState.current.st - dy;
        return;
      }
      if (dragState.current) {
        const { id, startX, startY, baseDx, baseDy, moved } = dragState.current;
        const ddx = (e.clientX - startX) / zoom;
        const ddy = (e.clientY - startY) / zoom;
        if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) > 3) {
          dragState.current.moved = true;
        }
        setOffsets(prev => ({ ...prev, [id]: { dx: baseDx + ddx, dy: baseDy + ddy } }));
      }
    };
    const onUp = (e) => {
      if (panState.current) {
        if (scrollRef.current) scrollRef.current.style.cursor = "";
        // Background click without drag → deselect
        if (!panState.current.moved) {
          onSelect(null);
        }
        panState.current = null;
      }
      if (dragState.current) {
        // If we never moved past threshold, treat as click → select
        if (!dragState.current.moved && dragState.current.id) {
          onSelect(dragState.current.id);
        }
        dragState.current = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [zoom, onSelect]);

  // Edges
  const edges = [];
  visibleTasks.forEach(t => {
    t.deps.forEach(d => {
      if (visibleIds.has(d) && positions[d] && positions[t.id]) {
        edges.push({ from: d, to: t.id });
      }
    });
  });

  return (
    <div ref={scrollRef} onMouseDown={onPanDown} onWheel={onWheel} style={{ position: "relative", width: "100%", height: "100%", overflow: "auto", background: "var(--bg-0)", cursor: "grab", overscrollBehavior: "contain" }}>
      {/* Controls */}
      <div style={{
        position: "sticky", top: 0, left: 0, right: 0,
        zIndex: 5,
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10,
        background: "linear-gradient(to bottom, var(--bg-0) 70%, transparent)",
        pointerEvents: "none",
      }}>
        {/* Save layout + Realign — saves or resets node positions */}
        <div style={{ pointerEvents: "auto", display: "inline-flex", gap: 4 }}>
          {[
            {
              key: "save",
              label: justSaved ? "Saved" : "Save Layout",
              icon: justSaved ? <I.Check size={11}/> : <I.Save size={11}/>,
              active: justSaved,
              onClick: () => {
                try { localStorage.setItem("flow.dag.layout", JSON.stringify(offsets)); } catch {}
                setJustSaved(true);
                setTimeout(() => setJustSaved(false), 1400);
              },
            },
            {
              key: "realign",
              label: "Realign",
              icon: <I.Recenter size={11}/>,
              active: false,
              onClick: () => {
                setOffsets({});
                try { localStorage.removeItem("flow.dag.layout"); } catch {}
              },
            },
          ].map(b => {
            const isHov = hoveredBtn === b.key;
            const lit = isHov || b.active;
            return (
              <div key={b.key} style={{ position: "relative" }}>
                <button
                  onClick={b.onClick}
                  onMouseEnter={() => setHoveredBtn(b.key)}
                  onMouseLeave={() => setHoveredBtn(prev => prev === b.key ? null : prev)}
                  aria-label={b.label}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22,
                    background: b.active ? "var(--bg-2)" : "transparent",
                    border: "1px solid",
                    borderColor: lit ? "var(--border-2)" : "var(--border-1)",
                    borderRadius: "var(--r-sm, 4px)",
                    color: lit ? "var(--text-1)" : "var(--text-3)",
                    cursor: "pointer",
                    opacity: hasOffsets || lit ? 1 : 0.55,
                    transition: "color 120ms, background 120ms, border-color 120ms, opacity 120ms",
                  }}>
                  {b.icon}
                </button>
                {isHov && (
                  <div style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "var(--bg-3, #2a2a2a)",
                    color: "var(--text-1)",
                    fontSize: 11,
                    lineHeight: 1,
                    padding: "5px 7px",
                    borderRadius: 4,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                    border: "1px solid var(--border-1)",
                    zIndex: 10,
                  }}>
                    {b.label}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "inline-flex", pointerEvents: "auto", background: "var(--bg-1)", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", padding: 2 }}>
          <button className="btn sm" onClick={() => onToggleShowAll(false)}
            title="Ready only"
            style={{
              background: !showAll ? "var(--bg-3)" : "transparent",
              border: "none", color: !showAll ? "var(--text-1)" : "var(--text-3)",
              borderRadius: 4, padding: "4px 7px", fontSize: 11.5,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}>
            <I.Zap size={11}/> Ready
          </button>
          <button className="btn sm" onClick={() => onToggleShowAll(true)}
            title="All tasks"
            style={{
              background: showAll ? "var(--bg-3)" : "transparent",
              border: "none", color: showAll ? "var(--text-1)" : "var(--text-3)",
              borderRadius: 4, padding: "4px 7px", fontSize: 11.5,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}>
            <I.List size={11}/> All
          </button>
        </div>
        <div style={{ pointerEvents: "auto", fontSize: 11.5, color: "var(--text-3)" }}>
          {visibleTasks.length} of {tasks.length} tasks
        </div>
        <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10, pointerEvents: "auto" }}>
          <div style={{ display: "inline-flex", alignItems: "center", background: "var(--bg-1)", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", padding: 2 }}>
            <button
              onClick={() => zoomAt(zoom / 1.2)}
              disabled={zoom <= MIN_ZOOM + 0.001}
              title="Zoom out (⌘/Ctrl + scroll)"
              style={{
                background: "transparent", border: "none",
                color: zoom <= MIN_ZOOM + 0.001 ? "var(--text-4)" : "var(--text-2)",
                borderRadius: 4, padding: "4px 6px", cursor: zoom <= MIN_ZOOM + 0.001 ? "default" : "pointer",
                display: "inline-flex", alignItems: "center",
              }}>
              <I.Dash size={12}/>
            </button>
            <button
              onClick={() => setZoom(1)}
              title="Reset zoom"
              className="mono"
              style={{
                background: "transparent", border: "none",
                color: "var(--text-3)", fontSize: 10.5,
                minWidth: 38, padding: "4px 2px", cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
              }}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => zoomAt(zoom * 1.2)}
              disabled={zoom >= MAX_ZOOM - 0.001}
              title="Zoom in (⌘/Ctrl + scroll)"
              style={{
                background: "transparent", border: "none",
                color: zoom >= MAX_ZOOM - 0.001 ? "var(--text-4)" : "var(--text-2)",
                borderRadius: 4, padding: "4px 6px", cursor: zoom >= MAX_ZOOM - 0.001 ? "default" : "pointer",
                display: "inline-flex", alignItems: "center",
              }}>
              <I.Plus size={12}/>
            </button>
          </div>
          <div style={{ display: "inline-flex", gap: 10, fontSize: 11, color: "var(--text-3)" }}>
            <span style={{display:"inline-flex", alignItems:"center", gap:4}}><span className="dot ok"/>done</span>
            <span style={{display:"inline-flex", alignItems:"center", gap:4}}><span className="dot" style={{background:"var(--accent)"}}/>running</span>
            <span style={{display:"inline-flex", alignItems:"center", gap:4}}><span className="dot info"/>ready</span>
            <span style={{display:"inline-flex", alignItems:"center", gap:4}}><span className="dot err"/>blocked</span>
            <span style={{display:"inline-flex", alignItems:"center", gap:4}}><span className="dot idle"/>queued</span>
          </div>
        </div>
      </div>

      <div ref={innerRef} style={{
        width: W * zoom,
        height: H * zoom,
        position: "relative",
        margin: "0 auto",
      }}>
        <div style={{
          width: W, height: H, position: "absolute",
          top: 0, left: 0,
          transform: `scale(${zoom})`,
          transformOrigin: "0 0",
        }}>
        {/* Phase row dividers */}
        {phaseOrder.map((p, i) => (
          <div key={`row-${p}`} style={{
            position: "absolute",
            left: 0, right: 0,
            top: PAD_Y + i * ROW_H - 2,
            borderTop: "1px dashed var(--border-1)",
            opacity: 0.6,
          }}/>
        ))}

        {/* SVG edges */}
        <svg width={W} height={H} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--border-3)"/>
            </marker>
            <marker id="arrow-accent" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L10,5 L0,10 Z" fill="var(--accent)"/>
            </marker>
          </defs>
          {edges.map(e => {
            const a = positions[e.from];
            const b = positions[e.to];
            const aOff = offsets[e.from] || { dx: 0, dy: 0 };
            const bOff = offsets[e.to] || { dx: 0, dy: 0 };
            const active = selectedId && (e.from === selectedId || e.to === selectedId);
            const x1 = a.x + aOff.dx, y1 = a.y + aOff.dy + 28;
            const x2 = b.x + bOff.dx, y2 = b.y + bOff.dy - 28;
            const mid = (y1 + y2) / 2;
            const d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
            return (
              <path key={`${e.from}-${e.to}`} d={d}
                stroke={active ? "var(--accent)" : "var(--border-3)"}
                strokeWidth={active ? 1.6 : 1.2}
                fill="none"
                markerEnd={active ? "url(#arrow-accent)" : "url(#arrow)"}
                opacity={active ? 1 : 0.75}/>
            );
          })}
        </svg>

        {/* Nodes */}
        {visibleTasks.map(t => {
          const pos = positions[t.id];
          if (!pos) return null;
          const meta = window.FLOW_DATA.STATUS_META[t.status] || { label: t.status || "unknown", color: "var(--text-3)", dot: "idle" };
          const phaseMeta = window.FLOW_DATA.PHASES[t.phase] || { label: t.phase || "unknown", color: "var(--text-3)" };
          const isSel = selectedId === t.id;
          const isHov = hoveredId === t.id;
          const off = offsets[t.id] || { dx: 0, dy: 0 };
          const isDragging = dragState.current && dragState.current.id === t.id && dragState.current.moved;
          const onNodeDown = (e) => {
            // Don't start drag from action buttons inside node, if any
            if (e.button !== 0) return;
            dragState.current = {
              id: t.id,
              startX: e.clientX, startY: e.clientY,
              baseDx: off.dx, baseDy: off.dy,
              moved: false,
            };
            e.stopPropagation();
            e.preventDefault();
          };
          return (
            <div key={t.id}
              data-dag-node=""
              onMouseDown={onNodeDown}
              onMouseEnter={() => onHover(t.id)}
              onMouseLeave={() => onHover(null)}
              style={{
                position: "absolute",
                left: pos.x - 100 + off.dx, top: pos.y - 32 + off.dy,
                width: 200, minHeight: 64,
                background: isSel ? "var(--bg-3)" : "var(--bg-1)",
                border: `1px solid ${isSel ? phaseMeta.color : isHov ? "var(--border-3)" : "var(--border-2)"}`,
                borderLeft: `3px solid ${phaseMeta.color}`,
                borderRadius: "var(--r-md)",
                boxShadow: isDragging ? "var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.35))" : isSel ? `0 0 0 3px ${phaseMeta.color}22, var(--shadow-md)` : isHov ? "var(--shadow-md)" : "none",
                cursor: isDragging ? "grabbing" : "grab",
                padding: "8px 10px",
                display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 6,
                transition: isDragging ? "none" : "box-shadow 0.12s, border-color 0.12s, background 0.12s",
                userSelect: "none",
                zIndex: isDragging ? 10 : isSel ? 2 : 1,
              }}>
              <div style={{
                fontSize: 12, fontWeight: 500, color: "var(--text-1)",
                lineHeight: 1.35,
                wordBreak: "break-word",
              }}>{t.title}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                {t.retries > 0 && (
                  <span title={`${t.retries} retries`} style={{ fontSize: 9.5, padding: "0 4px", borderRadius: 3, background: "var(--warn-bg)", color: "var(--warn)", border: "1px solid rgba(227,179,65,0.22)", fontFamily: "var(--font-mono)" }}>↻{t.retries}</span>
                )}
                {t.transientRetries > 0 && (
                  <span title={`${t.transientRetries} transient retries`} style={{ fontSize: 9.5, padding: "0 4px", borderRadius: 3, color: "var(--text-4)", border: "1px solid var(--border-2)", fontFamily: "var(--font-mono)" }}>~{t.transientRetries}</span>
                )}
                {t.uiReviewRound > 0 && (
                  <span title={`UI review round ${t.uiReviewRound}`} style={{ fontSize: 9.5, padding: "0 4px", borderRadius: 3, background: "var(--purple-bg)", color: "var(--purple)", border: "1px solid rgba(183,136,224,0.22)", fontFamily: "var(--font-mono)" }}>UI·{t.uiReviewRound}</span>
                )}
                {t.lastError && (
                  <span title={t.lastError} style={{ color: "var(--err)", display: "inline-flex" }}><I.AlertCirc size={10}/></span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{t.id}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: meta.color }}>
                  <span className={`dot ${meta.dot}`}/>
                  {t.status === "running" && <span className="mono" style={{ fontSize: 10 }}>running</span>}
                  {t.status !== "running" && meta.label.toLowerCase()}
                </span>
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
};

export { DAGView };
