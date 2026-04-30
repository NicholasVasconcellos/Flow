// Frontend-owned display metadata.
// Shims window.FLOW_DATA so components that read STAGES/STATUS_META as globals
// continue to work without modification.

// Keys mirror src/types.ts → TaskStageSchema (9) ∪ SessionStageSchema extras (6).
// Keep this exhaustive: any stage on the wire that isn't here renders grey.
export const STAGES = {
  // TaskStage
  spec:                   { label: "Spec",            color: "#7aa7e0" },
  exec:                   { label: "Execute",         color: "#d97757" },
  exec_ui_check:          { label: "UI Check",        color: "#b788e0" },
  code_review:            { label: "Review",          color: "#b788e0" },
  code_review_ui_check:   { label: "Review · UI",     color: "#b788e0" },
  documentation:          { label: "Document",        color: "#7cc47f" },
  "update-learning":      { label: "Learning",        color: "#7cc47f" },
  done:                   { label: "Done",            color: "#7cc47f" },
  merged:                 { label: "Merged",          color: "#7cc47f" },
  // SessionStage extras (harness-internal stages that launch sessions but aren't
  // task-level stages).
  setup:                  { label: "Setup",           color: "#9aa3b2" },
  "get-tasks":            { label: "Get Tasks",       color: "#9aa3b2" },
  commit:                 { label: "Commit",          color: "#9aa3b2" },
  commit_recovery:        { label: "Commit · Recover", color: "#e3b341" },
  "merge-resolve":        { label: "Merge: resolve",  color: "#9aa3b2" },
  "merge-verify":         { label: "Merge: verify",   color: "#9aa3b2" },
};

export const STATUS_META = {
  done:              { label: "Done",              color: "var(--ok)",     dot: "ok"   },
  succeeded:         { label: "Succeeded",         color: "var(--ok)",     dot: "ok"   },
  running:           { label: "Running",           color: "var(--accent)", dot: "info" },
  ready:             { label: "Ready",             color: "var(--info)",   dot: "info" },
  blocked:           { label: "Blocked",           color: "var(--err)",    dot: "err"  },
  paused:            { label: "Paused",            color: "var(--warn)",   dot: "warn" },
  queued:            { label: "Queued",            color: "var(--text-3)", dot: "idle" },
  failed:            { label: "Failed",            color: "var(--err)",    dot: "err"  },
  merged:            { label: "Merged",            color: "var(--ok)",     dot: "ok"   },
  pending:           { label: "Pending",           color: "var(--text-3)", dot: "idle" },
  "merge-resolve":   { label: "Merge: resolve",    color: "var(--warn)",   dot: "warn" },
  "merge-verify":    { label: "Merge: verify",     color: "var(--info)",   dot: "info" },
  "commit-recovery": { label: "Recovering commit", color: "var(--warn)",   dot: "warn" },
  "rate-limited":    { label: "Rate-limited",      color: "var(--warn)",   dot: "warn" },
  idle:              { label: "Idle",              color: "var(--text-3)", dot: "idle" },
};

export const HOME_DIRECTORIES = ["~/code", "~/workspaces", "~/Documents/projects", "~/dev"];

if (typeof window !== 'undefined') {
  window.FLOW_DATA = {
    ...window.FLOW_DATA,
    STAGES,
    STATUS_META,
    HOME_DIRECTORIES,
  };
}
