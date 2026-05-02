import React from 'react';
import { I } from './icons.jsx';
import { StagePill, ContextDonut, formatK, formatCost } from './primitives.jsx';
import { useFlowData } from './FlowDataContext.jsx';
import { useArtifact } from './useArtifact.js';

// Context Charts, Learnings, Notifications panels

const ContextChartsPanel = () => {
  const { TASKS, SESSIONS } = useFlowData();
  const rows = TASKS.filter(t => SESSIONS.some(s => s.taskId === t.id)).slice(0, 6);
  // include all tasks with sessions; augment others with fake sessions for demo richness
  const allRows = TASKS.slice(0, 8).map(t => {
    let sessions = SESSIONS.filter(s => s.taskId === t.id);
    if (sessions.length === 0) {
      // synthesize light demo session data
      const seed = t.id.charCodeAt(1) * 13 + t.id.length * 7;
      const n = 1 + (seed % 3);
      sessions = Array.from({ length: n }).map((_, i) => ({
        id: `${t.id}-demo-${i}`,
        name: `${t.stage}:run-${i+1}`,
        model: "sonnet-4.5",
        contextUsed: 20_000 + ((seed * (i+1)) % 160_000),
        contextMax: 200_000,
        tokens: { input: 8000 + ((seed*i)%40_000), output: 2000 + ((seed+i)%12_000), cacheRead: 30_000 + ((seed*i)%80_000), cacheWrite: 4000 },
        cost: 0.10 + ((seed*(i+1))%120)/100,
        autocompacted: seed % 5 === 0 && i === n-1,
      }));
    }
    return { task: t, sessions };
  });

  // Totals
  const totals = allRows.reduce((acc, r) => {
    r.sessions.forEach(s => {
      acc.input += s.tokens.input;
      acc.output += s.tokens.output;
      acc.cacheRead += s.tokens.cacheRead;
      acc.cacheWrite += s.tokens.cacheWrite;
      acc.cost += (s.costUsd ?? s.cost ?? 0);
    });
    return acc;
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

  return (
    <div style={{ padding: 0 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
        <thead>
          <tr style={{ background: "var(--bg-2)", color: "var(--text-3)", fontWeight: 500, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <th style={{ textAlign: "left", padding: "8px 12px", borderBottom: "1px solid var(--border-1)" }}>Task</th>
            <th style={{ textAlign: "left", padding: "8px 8px", borderBottom: "1px solid var(--border-1)" }}>Context per session</th>
            <th style={{ textAlign: "right", padding: "8px 8px", borderBottom: "1px solid var(--border-1)" }}>Tokens</th>
            <th style={{ textAlign: "right", padding: "8px 12px", borderBottom: "1px solid var(--border-1)" }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {allRows.map(({ task, sessions }) => {
            const tokTotal = sessions.reduce((a, s) => a + s.tokens.input + s.tokens.output, 0);
            const cacheTotal = sessions.reduce((a, s) => a + s.tokens.cacheRead + s.tokens.cacheWrite, 0);
            const costTotal = sessions.reduce((a, s) => a + (s.costUsd ?? s.cost ?? 0), 0);
            return (
              <tr key={task.id} style={{ borderBottom: "1px solid var(--border-1)" }}>
                <td style={{ padding: "10px 12px", verticalAlign: "middle" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StagePill stage={task.stage}/>
                    <div>
                      <div style={{ color: "var(--text-1)", fontSize: 12 }}>{task.title}</div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{task.id}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "10px 8px" }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sessions.map(s => (
                      <div key={s.id} title={`${s.name} — ${Math.round(s.contextUsed/s.contextMax*100)}%`}>
                        <ContextDonut used={s.contextUsed} max={s.contextMax} size={34} stroke={4} showLabel={false} autocompacted={s.autocompacted}/>
                      </div>
                    ))}
                  </div>
                </td>
                <td style={{ padding: "10px 8px", textAlign: "right", verticalAlign: "middle" }}>
                  <div className="mono" style={{ color: "var(--text-1)", fontSize: 12 }}>{formatK(tokTotal)}</div>
                  <div className="mono" style={{ color: "var(--text-4)", fontSize: 10 }}>+{formatK(cacheTotal)} cache</div>
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right", verticalAlign: "middle" }}>
                  <span className="mono" style={{ color: "var(--text-1)", fontSize: 12 }}>{formatCost(costTotal)}</span>
                </td>
              </tr>
            );
          })}
          {/* Total row */}
          <tr style={{ background: "var(--bg-2)" }}>
            <td style={{ padding: "10px 12px", fontWeight: 600, color: "var(--text-1)", fontSize: 11.5 }}>
              Σ All tasks
            </td>
            <td style={{ padding: "10px 8px", color: "var(--text-3)", fontSize: 11 }}>—</td>
            <td style={{ padding: "10px 8px", textAlign: "right" }}>
              <div className="mono" style={{ color: "var(--text-1)", fontSize: 12, fontWeight: 600 }}>{formatK(totals.input + totals.output)}</div>
              <div className="mono" style={{ color: "var(--text-4)", fontSize: 10 }}>
                in {formatK(totals.input)} · out {formatK(totals.output)} · cache {formatK(totals.cacheRead + totals.cacheWrite)}
              </div>
            </td>
            <td style={{ padding: "10px 12px", textAlign: "right" }}>
              <span className="mono" style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600 }}>{formatCost(totals.cost)}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

const LearningsPanel = () => {
  const { LEARNINGS, TASKS } = useFlowData();
  const [open, setOpen] = React.useState({ [LEARNINGS[0]?.taskId]: true });
  const byTask = {};
  LEARNINGS.forEach(l => (byTask[l.taskId] ||= []).push(l));
  return (
    <div style={{ padding: "8px 0" }}>
      {Object.entries(byTask).map(([taskId, items]) => {
        const task = TASKS.find(t => t.id === taskId);
        const isOpen = open[taskId];
        return (
          <div key={taskId} style={{ marginBottom: 4 }}>
            <button onClick={() => setOpen(s => ({ ...s, [taskId]: !s[taskId] }))}
              style={{
                width: "100%", textAlign: "left",
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 12px",
                color: "var(--text-2)", fontSize: 11.5,
              }}>
              {isOpen ? <I.Chevron size={11}/> : <I.ChevronRt size={11}/>}
              <StagePill stage={task?.stage || "exec"}/>
              <span style={{ color: "var(--text-1)", fontWeight: 500 }}>{task?.title || taskId}</span>
              <span className="count" style={{ marginLeft: "auto", background: "var(--bg-3)", padding: "1px 6px", borderRadius: 999, fontSize: 10 }}>{items.length}</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 12px 8px 32px" }}>
                {items.map(l => (
                  <div key={l.id} style={{
                    padding: "8px 10px",
                    background: "var(--bg-2)",
                    border: "1px solid var(--border-1)",
                    borderLeft: "2px solid var(--warn)",
                    borderRadius: "var(--r-sm)",
                    marginBottom: 4,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <I.Lightbulb size={12} className="ic" />
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-1)" }}>{l.title}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-4)" }}>{l.when}</span>
                    </div>
                    <div style={{ color: "var(--text-2)", lineHeight: 1.5, fontSize: 11.5 }}>{l.body}</div>
                    <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                      {l.tags.map(t => <span key={t} className="badge" style={{ fontSize: 10 }}>#{t}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const NotificationsPanel = () => {
  const { NOTIFICATIONS, NOTIFICATIONS_TRUNCATED, TASKS, sendCommand } = useFlowData();
  const [loadOlder, setLoadOlder] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const onClearAll = React.useCallback(() => {
    sendCommand({ type: 'notification.clearAll' });
    setConfirming(false);
  }, [sendCommand]);
  // Mounting LoadOlderTrigger fires the artifact.fetch via useArtifact at render
  // time (declarative). The button just toggles the trigger into the tree.
  return (
    <div style={{ padding: "8px 10px" }}>
      {NOTIFICATIONS.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {NOTIFICATIONS.length} {NOTIFICATIONS.length === 1 ? "notification" : "notifications"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {confirming ? (
              <>
                <button className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
                <button className="btn sm primary" onClick={onClearAll}>Confirm clear</button>
              </>
            ) : (
              <button className="btn sm" onClick={() => setConfirming(true)}>Clear all</button>
            )}
          </div>
        </div>
      )}
      {NOTIFICATIONS.length === 0 && (
        <div style={{ padding: 20, textAlign: "center", color: "var(--text-4)", fontSize: 12 }}>
          No notifications — all sessions running smoothly.
        </div>
      )}
      {NOTIFICATIONS.map(n => {
        const task = TASKS.find(t => t.id === n.taskId);
        const sev = n.severity;
        const accent = sev === "blocked" ? "var(--err)"
                     : sev === "review-requested" ? "var(--purple)"
                     : sev === "transient" ? "var(--info)"
                     : "var(--warn)";
        const Icon = sev === "blocked" ? I.AlertCirc
                   : sev === "review-requested" ? I.Lightbulb
                   : sev === "transient" ? I.Info
                   : I.AlertTri;
        return (
          <div key={n.id} style={{
            padding: "10px 12px",
            background: "var(--bg-2)",
            border: "1px solid var(--border-1)",
            borderLeft: `2px solid ${accent}`,
            borderRadius: "var(--r-sm)",
            marginBottom: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ color: accent, display: "inline-flex" }}><Icon size={13}/></span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-1)" }}>{n.title}</span>
              {n.kind && <span className="mono" style={{ fontSize: 9.5, color: "var(--text-4)", padding: "1px 5px", border: "1px solid var(--border-1)", borderRadius: 3 }}>{n.kind}</span>}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-4)" }}>{n.when}</span>
            </div>
            <div style={{ color: "var(--text-2)", lineHeight: 1.5, fontSize: 11.5, marginBottom: 8 }}>{n.body}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{n.taskId} · {task?.title}</span>
              {!n.auto && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <button className="btn sm">Dismiss</button>
                  <button className="btn sm primary">Resolve</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {NOTIFICATIONS_TRUNCATED && (
        <div style={{ padding: "8px 10px", textAlign: "center" }}>
          {!loadOlder ? (
            <button className="btn sm" onClick={() => setLoadOlder(true)}>
              Load older notifications
            </button>
          ) : (
            <LoadOlderNotificationsTrigger/>
          )}
        </div>
      )}
    </div>
  );
};

const LoadOlderNotificationsTrigger = () => {
  const entry = useArtifact('project.notifications', {});
  if (!entry || entry.status === 'loading') {
    return <span style={{ color: "var(--text-4)", fontSize: 11 }}>Loading older notifications…</span>;
  }
  if (entry.status === 'error') {
    return <span style={{ color: "var(--err)", fontSize: 11 }}>Error: {entry.error}</span>;
  }
  return null;
};

export { ContextChartsPanel, LearningsPanel, NotificationsPanel };
