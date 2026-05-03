import React from 'react';
import { I } from './icons.jsx';
import { Panel, StatusBadge, ContextDonut, formatK, formatCost } from './primitives.jsx';
import { useArtifact } from './useArtifact.js';
import { fmtRelativeAgo } from './timeUtils.js';

// Log column — renders formatted session log events.
// Layout: Response events render inline (always-open). All non-Response events
// in a turn collapse into a "streak" block; expanding the streak reveals
// per-category sub-groups; expanding a category reveals individual rows.

const LOG_FILTER_TYPES = [
  { kind: "user",           label: "User" },
  { kind: "assistant_text", label: "Agent" },
  { kind: "tool_use",       label: "Tool call" },
  { kind: "tool_result",    label: "Result" },
];

const CATEGORY_ORDER = ['user', 'thinking', 'tool', 'tool_result'];
const CATEGORY_LABEL = {
  user: 'User',
  thinking: 'Thinking',
  tool: 'Tool calls',
  tool_result: 'Results',
};

const LogColumn = ({ session, events, onClose, onExpand, collapsed, fixedWidth }) => {
  const [openEvents, setOpenEvents] = React.useState({});
  const [openStreaks, setOpenStreaks] = React.useState({});
  const [openCategories, setOpenCategories] = React.useState({});
  const toggleEvt = (id) => setOpenEvents(s => ({ ...s, [id]: !s[id] }));
  const toggleStreak = (k) => setOpenStreaks(s => ({ ...s, [k]: !s[k] }));
  const toggleCategory = (k) => setOpenCategories(s => ({ ...s, [k]: !s[k] }));

  const [enabled, setEnabled] = React.useState(
    () => Object.fromEntries(LOG_FILTER_TYPES.map(t => [t.kind, true]))
  );
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [popupPos, setPopupPos] = React.useState(null);
  const filterBtnRef = React.useRef(null);
  const popupRef = React.useRef(null);

  const [groupMode, setGroupMode] = React.useState('turn');

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Recompute popup position from button rect; clamp to viewport.
  const recalcPopup = React.useCallback(() => {
    const btn = filterBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const popupWidth = 200;
    const margin = 6;
    let left = rect.right - popupWidth;
    if (left < margin) left = margin;
    if (left + popupWidth > window.innerWidth - margin) {
      left = window.innerWidth - popupWidth - margin;
    }
    setPopupPos({ top: rect.bottom + 4, left });
  }, []);

  React.useEffect(() => {
    if (!filterOpen) return;
    recalcPopup();
    const onDoc = (e) => {
      const inBtn = filterBtnRef.current && filterBtnRef.current.contains(e.target);
      const inPop = popupRef.current && popupRef.current.contains(e.target);
      if (!inBtn && !inPop) setFilterOpen(false);
    };
    const onResize = () => recalcPopup();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [filterOpen, recalcPopup]);

  useArtifact('session.events', { sessionId: session?.id });

  if (!session) return null;

  const allSessionEvents = events
    .filter(e => e.sessionId === session.id)
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  const sessionEvents = allSessionEvents.filter(e => enabled[e.kind] !== false);
  const activeCount = LOG_FILTER_TYPES.filter(t => enabled[t.kind]).length;
  const filtersActive = activeCount < LOG_FILTER_TYPES.length;
  const turns = buildTurns(sessionEvents);

  // Pre-compute streak/category keys for expand-all.
  const allKeys = collectExpandableKeys(turns);

  const expandAll = () => {
    setOpenStreaks(Object.fromEntries(allKeys.streaks.map(k => [k, true])));
    setOpenCategories(Object.fromEntries(allKeys.categories.map(k => [k, true])));
    setOpenEvents(Object.fromEntries(allKeys.events.map(k => [k, true])));
  };
  const collapseAll = () => {
    setOpenStreaks({});
    setOpenCategories({});
    setOpenEvents({});
  };

  const style = fixedWidth
    ? { flex: `0 0 ${fixedWidth}px`, width: fixedWidth, minWidth: fixedWidth, maxWidth: fixedWidth }
    : { flex: "1 1 360px", minWidth: 300, maxWidth: 560 };

  const filterAction = (
    <>
      <button
        ref={filterBtnRef}
        className="icon-btn"
        onClick={() => setFilterOpen(o => !o)}
        title="Filter log types"
        style={{
          color: filtersActive ? "var(--accent)" : undefined,
          background: filterOpen ? "var(--bg-2)" : undefined,
          position: "relative",
        }}
      >
        <I.Filter size={12}/>
        {filtersActive && (
          <span style={{
            position: "absolute", top: 1, right: 1,
            width: 5, height: 5, borderRadius: 999,
            background: "var(--accent)",
            pointerEvents: "none",
          }}/>
        )}
      </button>
      {filterOpen && popupPos && (
        <div
          ref={popupRef}
          role="menu"
          style={{
            position: "fixed",
            top: popupPos.top,
            left: popupPos.left,
            background: "var(--bg-1)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--r-md)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
            padding: 4,
            width: 200,
            zIndex: 1000,
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
          <div style={{ height: 1, background: "var(--border-2)", margin: "6px 4px" }}/>
          <button
            onClick={() => setGroupMode(m => m === 'turn' ? 'flat' : 'turn')}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "6px 8px",
              background: "transparent", border: "none",
              borderRadius: "var(--r-sm)",
              cursor: "pointer", color: "var(--text-1)",
              fontSize: 12, textAlign: "left",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "var(--bg-2)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          >
            <span style={{
              width: 14, height: 14, borderRadius: 3,
              border: `1px solid ${groupMode === 'turn' ? "var(--accent)" : "var(--border-2)"}`,
              background: groupMode === 'turn' ? "var(--accent)" : "transparent",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              color: "#fff", flexShrink: 0,
            }}>
              {groupMode === 'turn' && <I.Check size={10}/>}
            </span>
            <span style={{ flex: 1 }}>Group by turn</span>
          </button>
        </div>
      )}
    </>
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
          <button className="icon-btn" onClick={expandAll} title="Expand all">
            <I.ChevronDn size={12}/>
          </button>
          <button className="icon-btn" onClick={collapseAll} title="Collapse all">
            <I.ChevronUp size={12}/>
          </button>
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
      <div className={"log-events" + (groupMode === 'flat' ? ' flat' : '')} style={{ padding: "8px 0" }}>
        {turns.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-4)", fontSize: 12 }}>
            {allSessionEvents.length === 0
              ? <>No events yet. Session {session.status}.</>
              : <>No events match the active filter.</>}
          </div>
        )}
        {turns.map((turn, i) => (
          <Turn
            key={i}
            turn={turn}
            index={i + 1}
            groupMode={groupMode}
            now={now}
            openEvents={openEvents}
            openStreaks={openStreaks}
            openCategories={openCategories}
            onToggleEvt={toggleEvt}
            onToggleStreak={toggleStreak}
            onToggleCategory={toggleCategory}
            showResult={enabled.tool_result !== false}
          />
        ))}
      </div>
    </Panel>
  );
};

// ---------------------------------------------------------------------------
// Turn grouping — pair tool_use with tool_result, group consecutive
// non-user events into an assistant turn.
// ---------------------------------------------------------------------------
function buildTurns(events) {
  const byId = {};
  for (const e of events) {
    if (e.kind === 'tool_use' && e.toolUseId) byId[e.toolUseId] = e;
  }
  const pairedResultIds = new Set();
  const resultByToolId = {};
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolUseId && byId[e.toolUseId]) {
      resultByToolId[e.toolUseId] = e;
      pairedResultIds.add(e.id);
    }
  }

  const turns = [];
  let cur = null;
  for (const e of events) {
    if (pairedResultIds.has(e.id)) continue;
    if (e.kind === 'user') {
      if (cur) { turns.push(cur); cur = null; }
      turns.push({ kind: 'user', events: [e], ts: e.ts });
      continue;
    }
    if (!cur) cur = { kind: 'assistant', events: [], ts: e.ts };
    cur.events.push(e);
  }
  if (cur) turns.push(cur);

  for (const t of turns) {
    t.endTs = t.events[t.events.length - 1]?.ts ?? t.ts;
  }
  return turns.map(t => ({ ...t, resultByToolId }));
}

// Within an assistant turn, split events into ordered segments.
// Response (assistant_text non-thinking) is its own segment; runs of
// non-Response events form streak segments.
function buildSegments(events) {
  const segs = [];
  let buf = null;
  for (const e of events) {
    const isResponse = e.kind === 'assistant_text' && !e.thinking;
    if (isResponse) {
      if (buf) { segs.push(buf); buf = null; }
      segs.push({ type: 'response', event: e });
    } else {
      if (!buf) buf = { type: 'streak', events: [] };
      buf.events.push(e);
    }
  }
  if (buf) segs.push(buf);
  return segs;
}

// Group streak events by category for the second-level reveal.
function categorize(events) {
  const groups = { user: [], thinking: [], tool: [], tool_result: [] };
  for (const e of events) {
    if (e.kind === 'user') groups.user.push(e);
    else if (e.kind === 'assistant_text' && e.thinking) groups.thinking.push(e);
    else if (e.kind === 'tool_use') groups.tool.push(e);
    else groups.tool_result.push(e);
  }
  return groups;
}

function collectExpandableKeys(turns) {
  const streaks = [];
  const categories = [];
  const events = [];
  turns.forEach((turn, ti) => {
    if (turn.kind !== 'assistant') return;
    const segs = buildSegments(turn.events);
    segs.forEach((seg, si) => {
      if (seg.type !== 'streak') return;
      const sk = `s:${ti}:${si}`;
      streaks.push(sk);
      const groups = categorize(seg.events);
      for (const cat of CATEGORY_ORDER) {
        if (!groups[cat].length) continue;
        categories.push(`${sk}:${cat}`);
        for (const ev of groups[cat]) events.push(ev.id);
      }
    });
  });
  return { streaks, categories, events };
}

// ---------------------------------------------------------------------------
// Turn renderer
// ---------------------------------------------------------------------------
function Turn({ turn, index, groupMode, now, openEvents, openStreaks, openCategories, onToggleEvt, onToggleStreak, onToggleCategory, showResult }) {
  if (turn.kind === 'user') {
    const ev = turn.events[0];
    return (
      <div className="turn user-turn">
        <UserMessage ev={ev} now={now} />
      </div>
    );
  }
  const segs = buildSegments(turn.events);
  const showDivider = groupMode === 'turn' && segs.length > 0;
  const turnIdx = index - 1;
  return (
    <>
      {showDivider && (
        <div className="turn-divider">
          <span>Turn {index}</span>
          <span className="line" />
          <span className="meta-time">{fmtTime(turn.ts)}</span>
        </div>
      )}
      <div className={"turn" + (groupMode === 'flat' ? " flat" : "")}>
        {segs.map((seg, si) => {
          if (seg.type === 'response') {
            return <ResponseSegment key={si} ev={seg.event} now={now} />;
          }
          const sk = `s:${turnIdx}:${si}`;
          return (
            <Streak
              key={si}
              streakKey={sk}
              events={seg.events}
              resultByToolId={turn.resultByToolId}
              open={!!openStreaks[sk]}
              openCategories={openCategories}
              openEvents={openEvents}
              onToggleStreak={onToggleStreak}
              onToggleCategory={onToggleCategory}
              onToggleEvt={onToggleEvt}
              now={now}
              showResult={showResult}
            />
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// User message — always inline (treated like Response: visible as prose).
// ---------------------------------------------------------------------------
function UserMessage({ ev, now }) {
  const { icon, color, label } = eventStyle(ev);
  return (
    <div className="log-row k-user inline-msg">
      <div className="log-row-icon"><div className="dot" style={{ color }}>{icon}</div></div>
      <div className="log-row-body">
        <div className="log-row-head inline-head">
          <span className="log-row-kind" style={{ color }}>{label}</span>
          <span className="log-row-meta">
            {ev.ts && <TimestampMeta ts={ev.ts} now={now} />}
          </span>
        </div>
        <div className="user-bubble">{ev.content}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Response — always inline (full content visible, no chevron, no collapse).
// ---------------------------------------------------------------------------
function ResponseSegment({ ev, now }) {
  const { icon, color, label } = eventStyle(ev);
  return (
    <div className="log-row k-text inline-msg">
      <div className="log-row-icon"><div className="dot" style={{ color }}>{icon}</div></div>
      <div className="log-row-body">
        <div className="log-row-head inline-head">
          <span className="log-row-kind" style={{ color }}>{label}</span>
          <span className="log-row-meta">
            {ev.ts && <TimestampMeta ts={ev.ts} now={now} />}
          </span>
        </div>
        <div className="response-body">{ev.content}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Streak — collapsible block of non-Response events.
// Header shows event-type breakdown chips. Open → category groups.
// ---------------------------------------------------------------------------
function Streak({ streakKey, events, resultByToolId, open, openCategories, openEvents, onToggleStreak, onToggleCategory, onToggleEvt, now, showResult }) {
  const groups = categorize(events);
  const presentCats = CATEGORY_ORDER.filter(c => groups[c].length > 0);
  const breakdown = presentCats.map(c => ({
    cat: c,
    n: groups[c].length,
    color: categoryColor(c),
  }));
  const total = events.length;

  return (
    <div className={"log-streak" + (open ? ' open' : '')}>
      <div className="log-row streak-head" onClick={() => onToggleStreak(streakKey)}>
        <div className="log-row-icon">
          <div className="dot" style={{ color: "var(--text-3)" }}>
            <I.More size={13}/>
          </div>
        </div>
        <div className="log-row-body">
          <div className="log-row-head">
            <I.ChevronRt size={10} className="chev"/>
            <span className="log-row-kind">Streak</span>
            <span className="log-row-summary">
              <span className="streak-count">{total} event{total === 1 ? '' : 's'}</span>
              <span className="streak-chips">
                {breakdown.map(b => (
                  <span key={b.cat} className="streak-chip" style={{ color: b.color }}>
                    {b.n} {CATEGORY_LABEL[b.cat].toLowerCase()}
                  </span>
                ))}
              </span>
            </span>
          </div>
        </div>
      </div>
      {open && (
        <div className="streak-body">
          {presentCats.map(cat => (
            <Category
              key={cat}
              catKey={`${streakKey}:${cat}`}
              kind={cat}
              events={groups[cat]}
              resultByToolId={resultByToolId}
              open={!!openCategories[`${streakKey}:${cat}`]}
              openEvents={openEvents}
              onToggleCategory={onToggleCategory}
              onToggleEvt={onToggleEvt}
              now={now}
              showResult={showResult}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category — collapsible group within a streak. Open → individual rows.
// ---------------------------------------------------------------------------
function Category({ catKey, kind, events, resultByToolId, open, openEvents, onToggleCategory, onToggleEvt, now, showResult }) {
  const color = categoryColor(kind);
  const icon = categoryIcon(kind);
  return (
    <div className={"log-category" + (open ? ' open' : '')}>
      <div className="log-row category-head" onClick={() => onToggleCategory(catKey)}>
        <div className="log-row-icon">
          <div className="dot" style={{ color }}>{icon}</div>
        </div>
        <div className="log-row-body">
          <div className="log-row-head">
            <I.ChevronRt size={10} className="chev"/>
            <span className="log-row-kind" style={{ color }}>{CATEGORY_LABEL[kind]}</span>
            <span className="log-row-summary">
              <span style={{ color: "var(--text-3)" }}>{events.length}</span>
            </span>
          </div>
        </div>
      </div>
      {open && (
        <div className="category-body">
          {events.map(ev => (
            <Row
              key={ev.id}
              ev={ev}
              result={ev.kind === 'tool_use' && ev.toolUseId ? resultByToolId[ev.toolUseId] : null}
              open={!!openEvents[ev.id]}
              onToggle={() => onToggleEvt(ev.id)}
              now={now}
              showResult={showResult}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row (single event)
// ---------------------------------------------------------------------------
function Row({ ev, result, open, onToggle, now, showResult }) {
  const { icon, color, label } = eventStyle(ev);
  const klass = kindClass(ev, result);
  const meta = rowMetaExtras(ev, result);
  return (
    <div className={`log-row ${klass} ${open ? 'open' : ''}`} onClick={onToggle}>
      <div className="log-row-icon">
        <div className="dot" style={{ color }}>{icon}</div>
      </div>
      <div className="log-row-body">
        <div className="log-row-head">
          <I.ChevronRt size={10} className="chev"/>
          <span className="log-row-kind" style={{ color }}>{label}</span>
          <span className="log-row-summary">{summaryFor(ev, result)}</span>
          <span className="log-row-meta">
            {meta.map((m, i) => <span key={i} className="meta-extra">{m}</span>)}
            {ev.ts && <TimestampMeta ts={ev.ts} now={now} />}
          </span>
        </div>
        {open && <RowDetail ev={ev} result={result} showResult={showResult} />}
      </div>
    </div>
  );
}

// Right-side row meta extras (duration, char count) — promoted from the
// removed inner detail-headers.
function rowMetaExtras(ev, result) {
  const out = [];
  if (ev.kind === 'tool_use') {
    const r = result;
    if (r && ev.ts && r.ts) {
      const dur = fmtDur(ev.ts, r.ts);
      if (dur) out.push(`Δ ${dur}`);
    }
    if (r && r.content != null) {
      const len = typeof r.content === 'string' ? r.content.length
                : JSON.stringify(r.content).length;
      out.push(`${len.toLocaleString()} ch`);
    }
  } else if (ev.kind === 'tool_result') {
    if (ev.content != null) {
      const len = typeof ev.content === 'string' ? ev.content.length
                : JSON.stringify(ev.content).length;
      out.push(`${len.toLocaleString()} ch`);
    }
  }
  return out;
}

// Detail body — no inner detail-headers; metadata moved to row meta.
function RowDetail({ ev, result, showResult }) {
  if (ev.kind === 'user') {
    return (
      <div className="log-detail">
        <div className="user-bubble">{ev.content}</div>
      </div>
    );
  }
  if (ev.kind === 'assistant_text') {
    const isThinking = !!ev.thinking;
    return (
      <div className="log-detail">
        <div className={"detail-body" + (isThinking ? " serif" : "")}>{ev.content}</div>
      </div>
    );
  }
  if (ev.kind === 'tool_use') {
    const r = result;
    const isErr = !!(r && (r.isError || r.result?.is_error));
    return (
      <div className="log-detail">
        <ToolInput name={ev.tool} input={ev.input} />
        {showResult && (
          <>
            <div className="detail-divider"/>
            <ToolResult name={ev.tool} result={r} isErr={isErr} />
          </>
        )}
      </div>
    );
  }
  if (ev.kind === 'tool_result') {
    const isErr = !!(ev.isError || ev.result?.is_error);
    return (
      <div className="log-detail">
        <ToolResult name="" result={ev} isErr={isErr} />
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Smart tool input renderers (per design)
// ---------------------------------------------------------------------------
function ToolInput({ name, input }) {
  if (!input) return <div className="detail-body" style={{ color: "var(--text-4)", fontStyle: "italic" }}>(no input)</div>;
  const n = (name || '').toLowerCase();

  if (n === 'bash') {
    return (
      <div className="kv">
        <div className="k">$</div>
        <div className="v cmd">{input.command}</div>
        {input.description && (<><div className="k">desc</div><div className="v">{input.description}</div></>)}
      </div>
    );
  }
  if (n === 'read') {
    return (
      <div className="kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        {input.offset != null && (<><div className="k">offset</div><div className="v">{input.offset}</div></>)}
        {input.limit != null && (<><div className="k">limit</div><div className="v">{input.limit}</div></>)}
      </div>
    );
  }
  if (n === 'glob') {
    return (
      <div className="kv">
        <div className="k">pattern</div>
        <div className="v pattern">{input.pattern}</div>
        {input.path && (<><div className="k">path</div><div className="v path">{input.path}</div></>)}
      </div>
    );
  }
  if (n === 'grep') {
    return (
      <div className="kv">
        <div className="k">pattern</div>
        <div className="v pattern">{input.pattern}</div>
        {input.path && (<><div className="k">path</div><div className="v path">{input.path}</div></>)}
        {input.output_mode && (<><div className="k">mode</div><div className="v">{input.output_mode}</div></>)}
      </div>
    );
  }
  if (n === 'write') {
    return (
      <div className="kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        {input.content != null && (
          <>
            <div className="k">content</div>
            <div className="v"><LongText content={String(input.content)} max={400} /></div>
          </>
        )}
      </div>
    );
  }
  if (n === 'edit') {
    return (
      <div className="kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        {input.old_string != null && (
          <>
            <div className="k">old</div>
            <div className="v"><LongText content={String(input.old_string)} max={300} /></div>
          </>
        )}
        {input.new_string != null && (
          <>
            <div className="k">new</div>
            <div className="v"><LongText content={String(input.new_string)} max={300} /></div>
          </>
        )}
      </div>
    );
  }
  return <pre className="code wrap">{JSON.stringify(input, null, 2)}</pre>;
}

// ---------------------------------------------------------------------------
// Smart tool result renderers (per design)
// ---------------------------------------------------------------------------
function ToolResult({ name, result, isErr }) {
  if (!result) return <div className="detail-body" style={{ color: "var(--text-4)", fontStyle: "italic" }}>awaiting result…</div>;

  const errorState = isErr ?? !!(result.isError || result.result?.is_error);
  const content = typeof result.content === 'string'
    ? result.content
    : result.content != null ? JSON.stringify(result.content, null, 2) : '';

  if (errorState) return <div className="err-body">{content || 'error'}</div>;

  const n = (name || '').toLowerCase();

  if (n === 'glob' || n === 'ls') {
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0 || content === 'No files found') {
      return <div className="filetree"><div className="empty">No files found</div></div>;
    }
    return (
      <div className="filetree">
        {lines.slice(0, 30).map((l, i) => {
          const isDir = l.endsWith('/');
          return (
            <div key={i} className={"line " + (isDir ? "dir" : "")}>
              {isDir ? <I.Folder size={12}/> : <I.File size={12}/>}
              <span className="name">{l}</span>
            </div>
          );
        })}
        {lines.length > 30 && <div className="more">{lines.length - 30} more…</div>}
      </div>
    );
  }

  if (n === 'bash') {
    return <pre className="code wrap">{content || <span style={{ color: "var(--text-4)" }}>(no output)</span>}</pre>;
  }

  if (n === 'grep') {
    const lines = content.split('\n').filter(Boolean);
    return (
      <div className="filetree">
        {lines.slice(0, 30).map((l, i) => (
          <div key={i} className="line">
            <I.File size={12}/>
            <span className="name" style={{ color: "var(--text-2)" }}>{l}</span>
          </div>
        ))}
        {lines.length > 30 && <div className="more">{lines.length - 30} more matches…</div>}
      </div>
    );
  }

  if (n === 'read') {
    return <LongText content={content} />;
  }

  if (n === 'write' || n === 'edit') {
    return <div className="detail-body" style={{ color: "var(--ok)" }}>✓ {content}</div>;
  }

  return <LongText content={content} />;
}

function LongText({ content, max = 800 }) {
  const [open, setOpen] = React.useState(false);
  if (!content) return null;
  const long = content.length > max;
  const shown = open || !long ? content : content.slice(0, max) + '…';
  return (
    <pre className="code wrap">
      {shown}
      {long && (
        <button className="trunc-btn" onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}>
          {open ? 'show less' : `show all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Row summary / icon / class / label helpers
// ---------------------------------------------------------------------------
function eventStyle(ev) {
  if (ev.kind === 'user') return { icon: <I.User size={13}/>, color: "var(--info)", label: "User" };
  if (ev.kind === 'assistant_text') {
    if (ev.thinking) return { icon: <I.Brain size={13}/>, color: "var(--purple)", label: "internal reasoning" };
    return { icon: <I.MessageSq size={13}/>, color: "var(--accent-muted)", label: "Response" };
  }
  if (ev.kind === 'tool_use') return { icon: toolIcon(ev.tool), color: "var(--ok)", label: ev.tool || "Tool" };
  if (ev.kind === 'tool_result') return { icon: <I.CheckCircle size={13}/>, color: "var(--ok)", label: "Result" };
  return { icon: <I.Dot size={13}/>, color: "var(--text-3)", label: ev.kind };
}

function toolIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('read')) return <I.File size={13}/>;
  if (n.includes('write') || n.includes('edit')) return <I.FileEdit size={13}/>;
  if (n.includes('bash') || n.includes('shell')) return <I.Terminal size={13}/>;
  if (n.includes('glob')) return <I.Folder size={13}/>;
  if (n.includes('grep') || n.includes('search')) return <I.Search size={13}/>;
  if (n.includes('web')) return <I.Globe size={13}/>;
  if (n.includes('todo') || n.includes('list')) return <I.List size={13}/>;
  return <I.Wrench size={13}/>;
}

function categoryColor(cat) {
  if (cat === 'user') return 'var(--info)';
  if (cat === 'thinking') return 'var(--purple)';
  if (cat === 'tool') return 'var(--ok)';
  if (cat === 'tool_result') return 'var(--ok)';
  return 'var(--text-3)';
}

function categoryIcon(cat) {
  if (cat === 'user') return <I.User size={13}/>;
  if (cat === 'thinking') return <I.Brain size={13}/>;
  if (cat === 'tool') return <I.Wrench size={13}/>;
  if (cat === 'tool_result') return <I.CheckCircle size={13}/>;
  return <I.Dot size={13}/>;
}

function kindClass(ev, result) {
  if (ev.kind === 'user') return 'k-user';
  if (ev.kind === 'assistant_text' && ev.thinking) return 'k-thinking';
  if (ev.kind === 'assistant_text') return 'k-text';
  if (ev.kind === 'tool_use') {
    const isErr = !!(result && (result.isError || result.result?.is_error));
    return 'k-tool' + (isErr ? ' err' : '');
  }
  if (ev.kind === 'tool_result') {
    const isErr = !!(ev.isError || ev.result?.is_error);
    return 'k-tool' + (isErr ? ' err' : '');
  }
  return '';
}

function summaryFor(ev, result) {
  if (ev.kind === 'user') return <>{truncate(ev.content, 180)}</>;
  if (ev.kind === 'assistant_text' && ev.thinking) return null;
  if (ev.kind === 'assistant_text') return <>{truncate(ev.content, 160)}</>;
  if (ev.kind === 'tool_use') {
    const input = ev.input || {};
    const n = (ev.tool || '').toLowerCase();
    let hint = '';
    if (n === 'bash') hint = input.command;
    else if (n === 'read' || n === 'write' || n === 'edit') hint = input.file_path;
    else if (n === 'glob' || n === 'grep') hint = input.pattern;
    else hint = Object.values(input)[0];
    const isErr = !!(result && (result.isError || result.result?.is_error));
    return (
      <>
        <strong>{ev.tool || 'tool'}</strong>
        {hint && <> · <code>{truncate(String(hint), 80)}</code></>}
        {isErr && <> · <span style={{ color: "var(--err)" }}>error</span></>}
      </>
    );
  }
  if (ev.kind === 'tool_result') {
    const isErr = !!(ev.isError || ev.result?.is_error);
    return <span style={{ color: isErr ? "var(--err)" : undefined }}>{truncate(typeof ev.content === 'string' ? ev.content : '', 120)}</span>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Time formatting — relative · date · time
// ---------------------------------------------------------------------------
function TimestampMeta({ ts, now }) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const rel = fmtRelativeAgo(d.getTime(), now);
  const date = fmtDate(d);
  const time = fmtTime(ts);
  return (
    <span className="ts-meta" title={d.toISOString()}>
      <span className="ts-rel">{rel}</span>
      <span className="ts-sep">·</span>
      <span className="ts-date">{date}</span>
      <span className="ts-sep">·</span>
      <span className="ts-time">{time}</span>
    </span>
  );
}

function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDur(a, b) {
  const ms = new Date(b) - new Date(a);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function truncate(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export { LogColumn };
