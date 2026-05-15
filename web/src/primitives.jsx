import React from 'react';
import { I } from './icons.jsx';

// Shared UI primitives used across the app

const Panel = ({ title, count, badge, actions, leftActions, children, collapsed: collapsedProp, onToggleCollapse, onClose, onExpand, onMinimize, icon, style, className = "", dragHandleProps, headerExtra, bodyStyle }) => {
  // If onToggleCollapse is provided, parent controls collapsed state.
  // Otherwise, the panel manages its own collapsed state via the +/- ribbon toggle.
  const [selfCollapsed, setSelfCollapsed] = React.useState(false);
  // Controlled if parent provides explicit collapsed prop OR a toggle handler.
  const isControlled = typeof collapsedProp === "boolean" || typeof onToggleCollapse === "function";
  const collapsed = isControlled ? !!collapsedProp : selfCollapsed;
  const toggleCollapse = typeof onToggleCollapse === "function"
    ? onToggleCollapse
    : () => setSelfCollapsed(c => !c);
  return (
  <div className={`panel ${collapsed ? "collapsed ribbon" : ""} ${className}`} style={style}>
    <div
      className="panel-header"
      {...(dragHandleProps || {})}
      style={dragHandleProps ? { cursor: "grab", userSelect: "none" } : undefined}
      title={dragHandleProps ? "Drag to rearrange" : undefined}
    >
      <button
        className="icon-btn panel-collapse-toggle"
        onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        draggable={false}
        title={collapsed ? "Expand" : "Collapse"}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        style={{ flexShrink: 0, marginRight: 2 }}
      >
        {collapsed ? <I.Plus size={12}/> : <I.Dash size={12}/>}
      </button>
      {leftActions && !collapsed && <div className="panel-actions panel-actions-left">{leftActions}</div>}
      {icon && !leftActions && <span className="ic-leader" style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>}
      <div className="panel-title">
        <span className="panel-title-text">{title}</span>
        {typeof count === "number" && <span className="count">{count}</span>}
        {badge}
      </div>
      {!collapsed && headerExtra}
      {!collapsed && (
        <div className="panel-actions">
          {actions}
          {onMinimize && (
            <button className="icon-btn" onClick={onMinimize} title="Minimize"><I.Dash size={14}/></button>
          )}
          {onExpand && (
            <button className="icon-btn" onClick={onExpand} title="Expand"><I.Maximize size={12}/></button>
          )}
          {onClose && (
            <button className="icon-btn" onClick={onClose} title="Close"><I.X size={14}/></button>
          )}
        </div>
      )}
    </div>
    {!collapsed && <div className="panel-body" style={bodyStyle}>{children}</div>}
  </div>
);
};

const StagePill = ({ stage }) => {
  const meta = window.FLOW_DATA.STAGES[stage];
  if (!meta) return null;
  return (
    <span className="badge" style={{
      color: meta.color,
      background: "transparent",
      borderColor: `${meta.color}55`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: meta.color, display: "inline-block" }} />
      {meta.label}
    </span>
  );
};

const StatusBadge = ({ status }) => {
  const meta = window.FLOW_DATA.STATUS_META[status];
  if (!meta) return null;
  const cls = { done: "ok", running: "accent", ready: "info", blocked: "err", queued: "" }[status] || "";
  return (
    <span className={`badge ${cls}`}>
      <span className={`dot ${meta.dot}`} />
      {meta.label}
    </span>
  );
};

// Donut chart for context usage
const ContextDonut = ({ used, max, size = 44, stroke = 4, autocompacted = false, showLabel = true }) => {
  const hasData = used != null && max != null && used > 0;
  const pct = hasData ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const color = pct >= 70 ? "var(--ctx-red)" : pct >= 30 ? "var(--ctx-yellow)" : "var(--ctx-green)";
  // Scale label so digits + "%" fit comfortably inside the donut on one line.
  const labelSize = size >= 56 ? 13 : size >= 44 ? 11 : size >= 36 ? 10 : 9;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={size/2} cy={size/2} r={r} stroke="var(--bg-3)" strokeWidth={stroke} fill="none"/>
          {hasData && (
            <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={stroke} fill="none"
                    strokeDasharray={`${dash} ${c}`} strokeLinecap="round"/>
          )}
        </svg>
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: labelSize, fontWeight: 600, color: hasData ? "var(--text-1)" : "var(--text-4)",
          fontFamily: "var(--font-mono)",
          lineHeight: 1,
          whiteSpace: "nowrap",
          letterSpacing: "-0.02em",
        }}>
          {hasData
            ? <>{pct}<span style={{ opacity: 0.7, marginLeft: 1 }}>%</span>{autocompacted && <span style={{ color: "var(--warn)", marginLeft: 1 }}>*</span>}</>
            : <span>—</span>}
        </div>
      </div>
      {showLabel && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)" }}>
          {hasData
            ? <>{formatK(used)}<span style={{ color: "var(--text-4)" }}>/{formatK(max)}</span></>
            : <span style={{ color: "var(--text-4)" }}>no data</span>}
        </div>
      )}
    </div>
  );
};

function formatK(n) {
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n/1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}
function formatCost(c) {
  if (typeof c !== "number" || !Number.isFinite(c) || c === 0) return "—";
  return "$" + c.toFixed(2);
}

export { Panel, StagePill, StatusBadge, ContextDonut, formatK, formatCost };
