import React from 'react';
import { I } from './icons.jsx';
import { StagePill, StatusBadge, ContextDonut, formatK, formatCost } from './primitives.jsx';
import { useFlowData } from './FlowDataContext.jsx';

// Task Details Panel — shown when a node is selected
const TaskDetailsPanel = ({ taskId, openLog, openLogIds = [] }) => {
  const flowData = useFlowData();
  const { TASKS, TASK_DETAILS, SESSIONS, SESSIONS_HYDRATED } = flowData;
  const task = TASKS.find(t => t.id === taskId);
  if (!task) {
    return (
      <div style={{ padding: 24, color: "var(--text-3)", fontSize: 12, textAlign: "center" }}>
        <I.Info size={20}/>
        <div style={{ marginTop: 8 }}>Select a task node to see details</div>
      </div>
    );
  }
  const stageMeta = window.FLOW_DATA.STAGES[task.stage] || { label: task.stage };
  const detail = TASK_DETAILS[taskId] || {
    id: task.id, title: task.title, stage: task.stage, status: task.status,
    description: {
      summary: `This task is part of the **${stageMeta.label}** stage. Full spec not loaded — click into its session to see logs.`,
      acceptance: ["Placeholder acceptance criteria."],
      notes: "No additional notes.",
    },
    artifacts: [],
    depsMet: task.requires || task.deps || [],
    blocks: [],
    assignee: "—",
    branch: task.branchName || "—",
    worktreePath: task.worktreePath,
    priority: "—", estimate: "—",
    startedAt: "—", updatedAt: "—",
    retries: task.retries, transientRetries: task.transientRetries, uiReviewRound: task.uiReviewRound,
    flags: { hasUI: task.hasUI, hasSpec: task.hasSpec, hasCodeReview: task.hasCodeReview },
  };
  const taskSessions = SESSIONS.filter(s => s.taskId === taskId);
  // Bring in runtime fields from the task even if TASK_DETAILS exists
  const runtime = {
    retries: detail.retries ?? task.retries ?? 0,
    transientRetries: detail.transientRetries ?? task.transientRetries ?? 0,
    uiReviewRound: detail.uiReviewRound ?? task.uiReviewRound ?? 0,
    worktreePath: detail.worktreePath ?? task.worktreePath,
    branchName: task.branchName,
    currentSessionId: task.currentSessionId,
    lastError: task.lastError,
    flags: detail.flags || { hasUI: task.hasUI, hasSpec: task.hasSpec, hasCodeReview: task.hasCodeReview },
  };

  return (
    <div style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--text-2)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <StagePill stage={task.stage}/>
            <StatusBadge status={task.status}/>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-4)", alignSelf: "center" }}>{task.id}</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)", letterSpacing: "-0.01em" }}>
            {task.title}
          </div>
        </div>
      </div>

      {/* Capability flags */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        <FlagChip on={runtime.flags.hasSpec} label="Spec"/>
        <FlagChip on={runtime.flags.hasUI} label="UI"/>
        <FlagChip on={runtime.flags.hasCodeReview} label="Review"/>
        {runtime.uiReviewRound > 0 && (
          <span className="badge purple" style={{ fontSize: 10 }}>UI review · round {runtime.uiReviewRound}</span>
        )}
        {(runtime.retries > 0) && (
          <span className="badge warn" style={{ fontSize: 10 }}>{runtime.retries} retr{runtime.retries === 1 ? "y" : "ies"}</span>
        )}
        {(runtime.transientRetries > 0) && (
          <span className="badge" style={{ fontSize: 10, color: "var(--warn)", borderColor: "rgba(227,179,65,0.22)" }} title="Transient retries (rate limits / network blips)">
            ↻ {runtime.transientRetries} transient
          </span>
        )}
      </div>

      {/* Metadata grid */}
      <div style={{
        display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 14px",
        padding: "10px 12px", background: "var(--bg-2)",
        borderRadius: "var(--r-md)", border: "1px solid var(--border-1)",
        marginBottom: 14, fontSize: 11.5
      }}>
        <Meta label="Assignee" value={detail.assignee} mono/>
        <Meta label="Branch" value={runtime.branchName || detail.branch} mono icon={<I.Git size={11}/>}/>
        {runtime.worktreePath && <Meta label="Worktree" value={runtime.worktreePath} mono/>}
        <Meta label="Priority" value={detail.priority}/>
        <Meta label="Estimate" value={detail.estimate}/>
        <Meta label="Started" value={detail.startedAt}/>
        <Meta label="Updated" value={detail.updatedAt}/>
        {runtime.currentSessionId && <Meta label="Active session" value={runtime.currentSessionId} mono/>}
      </div>

      {runtime.lastError && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: "var(--err-bg)",
          border: "1px solid rgba(229,128,107,0.22)",
          borderLeft: "2px solid var(--err)",
          borderRadius: "var(--r-sm)",
          fontSize: 11.5, color: "var(--text-2)", lineHeight: 1.5,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, color: "var(--err)", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <I.AlertCirc size={12}/> Last error
            {typeof runtime.lastError === "object" && runtime.lastError?.stage && (
              <span className="mono" style={{ marginLeft: "auto", color: "var(--text-4)", fontWeight: 400, fontSize: 10, letterSpacing: 0, textTransform: "none" }}>{runtime.lastError.stage}</span>
            )}
          </div>
          {typeof runtime.lastError === "string"
            ? runtime.lastError
            : (runtime.lastError?.message ?? JSON.stringify(runtime.lastError))}
        </div>
      )}

      {/* Description */}
      <SectionH>Description</SectionH>
      <div style={{ color: "var(--text-2)", lineHeight: 1.6, marginBottom: 12 }}>
        <RichText text={detail.description.summary}/>
      </div>

      <SectionH>Acceptance criteria</SectionH>
      <ul style={{ margin: "0 0 12px 0", padding: 0, listStyle: "none" }}>
        {detail.description.acceptance.map((a, i) => (
          <li key={i} style={{ display: "flex", gap: 8, padding: "4px 0", color: "var(--text-2)" }}>
            <I.CheckCircle size={13} className="ic" />
            <span><RichText text={a}/></span>
          </li>
        ))}
      </ul>

      {detail.description.notes && (
        <>
          <SectionH>Notes</SectionH>
          <div style={{ color: "var(--text-3)", lineHeight: 1.6, marginBottom: 12, fontStyle: "italic" }}>
            {detail.description.notes}
          </div>
        </>
      )}

      {/* Artifacts */}
      {detail.artifacts && detail.artifacts.length > 0 && (
        <>
          <SectionH>Artifacts</SectionH>
          <div style={{ marginBottom: 12 }}>
            {detail.artifacts.map((a, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", background: "var(--bg-2)",
                border: "1px solid var(--border-1)", borderRadius: "var(--r-sm)",
                marginBottom: 4, fontSize: 11.5,
              }}>
                {a.type === "test" ? <I.Test size={12}/> : <I.File size={12}/>}
                <span className="mono" style={{ color: "var(--text-1)" }}>{a.path}</span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)" }}>{a.change}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Sessions */}
      {!SESSIONS_HYDRATED && taskSessions.length === 0 && (
        <>
          <SectionH>Sessions</SectionH>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "10px 12px", marginBottom: 12,
            background: "var(--bg-2)", border: "1px solid var(--border-1)",
            borderRadius: "var(--r-sm)", color: "var(--text-3)", fontSize: 11.5,
          }}>
            <span className="flow-spinner" aria-hidden="true" />
            <span>Loading sessions…</span>
          </div>
        </>
      )}
      {taskSessions.length > 0 && (
        <>
          <SectionH>Sessions ({taskSessions.length})</SectionH>
          <div style={{ marginBottom: 12 }}>
            {taskSessions.map(s => {
              const isOpen = openLogIds.includes(s.id);
              return (
                <div
                  key={s.id}
                  onClick={() => { if (openLog) openLog(s.id); }}
                  title={isOpen ? "Focus this session in the log panel" : "Open this session in the log panel"}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px", background: "var(--bg-2)",
                    border: "1px solid var(--border-1)", borderRadius: "var(--r-sm)",
                    marginBottom: 4,
                    cursor: "pointer",
                    transition: "background 120ms, border-color 120ms",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-3)"; e.currentTarget.style.borderColor = "var(--border-2)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-2)"; e.currentTarget.style.borderColor = "var(--border-1)"; }}
                >
                  <ContextDonut used={s.contextUsed} max={s.contextMax} size={40} stroke={3.5} showLabel={false} autocompacted={s.autocompacted}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11.5, color: "var(--text-1)", display: "flex", alignItems: "center", gap: 6 }}>
                      {s.name}
                      {s.reviewRequested && <span title="FLOW_REVIEW_REQUESTED" style={{ fontSize: 9, color: "var(--warn)", padding: "0 4px", border: "1px solid rgba(227,179,65,0.3)", borderRadius: 3, letterSpacing: "0.04em" }}>REVIEW</span>}
                      {s.transientError && <span title={s.transientError.message} style={{ fontSize: 10, color: "var(--warn)" }}>↻</span>}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--text-3)", display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span>{s.model.split("-").slice(0,3).join("-")}</span>
                      {s.effort && <span style={{ color: "var(--text-4)" }}>· {s.effort}</span>}
                      {s.thinkingMode && s.thinkingMode !== "auto" && <span style={{ color: "var(--text-4)" }}>· {s.thinkingMode}</span>}
                      <span style={{ color: "var(--text-4)" }}>· {formatK(s.tokens.input + s.tokens.output)} tok · {formatCost(s.costUsd ?? s.cost)}</span>
                    </div>
                  </div>
                  <span style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 10, fontWeight: 500,
                    color: isOpen ? "var(--text-4)" : "var(--text-3)",
                    letterSpacing: isOpen ? "0.06em" : "normal",
                    textTransform: isOpen ? "uppercase" : "none",
                  }}>
                    {isOpen ? "Open" : (<><I.Plus size={10}/> Open</>)}
                  </span>
                  <StatusBadge status={s.status}/>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Dependencies */}
      <SectionH>Dependencies</SectionH>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {detail.depsMet && detail.depsMet.length > 0 ? detail.depsMet.map(d => (
          <span key={d} className="badge ok"><I.Check size={10}/><span className="mono">{d}</span></span>
        )) : <span style={{ color: "var(--text-4)", fontSize: 11 }}>No upstream dependencies</span>}
      </div>
      {detail.blocks && detail.blocks.length > 0 && (
        <>
          <SectionH style={{ marginTop: 10 }}>Blocks</SectionH>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {detail.blocks.map(d => (
              <span key={d} className="badge"><I.Arrow size={10}/><span className="mono">{d}</span></span>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const FlagChip = ({ on, label }) => (
  <span style={{
    fontSize: 10, padding: "1px 6px", borderRadius: 999,
    background: on ? "var(--bg-3)" : "transparent",
    color: on ? "var(--text-1)" : "var(--text-4)",
    border: `1px solid ${on ? "var(--border-2)" : "var(--border-1)"}`,
    display: "inline-flex", alignItems: "center", gap: 4,
    textDecoration: on ? "none" : "line-through",
    opacity: on ? 1 : 0.6,
  }}>
    {on ? <I.Check size={9}/> : <I.X size={9}/>}{label}
  </span>
);

const Meta = ({ label, value, mono, icon }) => (
  <>
    <div style={{ color: "var(--text-3)" }}>{label}</div>
    <div className={mono ? "mono" : ""} style={{ color: "var(--text-1)", display: "inline-flex", alignItems: "center", gap: 5 }}>
      {icon}{value}
    </div>
  </>
);

const SectionH = ({ children, style }) => (
  <div style={{
    fontSize: 10, fontWeight: 600, letterSpacing: "0.08em",
    color: "var(--text-3)", textTransform: "uppercase",
    marginBottom: 6, ...style,
  }}>{children}</div>
);

// Minimal inline markdown: **bold** and `code`
const RichText = ({ text }) => {
  const parts = [];
  let i = 0; let key = 0;
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let m;
  let last = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={key++} style={{ color: "var(--text-1)" }}>{tok.slice(2,-2)}</strong>);
    else parts.push(<code key={key++} style={{ fontFamily: "var(--font-mono)", fontSize: "0.92em", background: "var(--bg-3)", padding: "1px 5px", borderRadius: 3, color: "var(--accent)" }}>{tok.slice(1,-1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return <>{parts}</>;
};

export { TaskDetailsPanel };
