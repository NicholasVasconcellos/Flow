// Frontend-owned display metadata lifted from data.jsx.
// Also shims window.FLOW_DATA so components that read STAGES/STATUS_META/PHASES
// as globals continue to work without modification.

export const STAGES = {
  root:        { label: "Root",        color: "#d97757" },
  spec:        { label: "Spec",        color: "#7aa7e0" },
  exec:        { label: "Execute",     color: "#d97757" },
  execute:     { label: "Execute",     color: "#d97757" },
  test:        { label: "Test",        color: "#e3b341" },
  review:      { label: "Review",      color: "#b788e0" },
  "ui-review": { label: "UI Review",   color: "#b788e0" },
  merge:       { label: "Merge",       color: "#9aa3b2" },
  merged:      { label: "Merged",      color: "#7cc47f" },
  document:    { label: "Document",    color: "#7cc47f" },
  "update-learning": { label: "Learning", color: "#7cc47f" },
  setup:       { label: "Setup",       color: "#9aa3b2" },
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

// Legacy alias: old code accessed STAGES under PHASES.
export const PHASES = STAGES;

export const HOME_DIRECTORIES = ["~/code", "~/workspaces", "~/Documents/projects", "~/dev"];

// Shim for components that read these constants off window.FLOW_DATA.
// Constants don't change at runtime so this is safe.
if (typeof window !== 'undefined') {
  window.FLOW_DATA = {
    ...window.FLOW_DATA,
    STAGES,
    STATUS_META,
    PHASES,
    HOME_DIRECTORIES,
  };
}
