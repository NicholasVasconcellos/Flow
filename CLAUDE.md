# Flow

Automated workflow orchestrator. Drives multi-stage agent pipelines (spec → exec → review → commit → merge-resolve → docs) across task worktrees. Harness under test when run against downstream projects (e.g. `pkmn-t8`).

## Reading codebase

Check `map.md` first — file index and summaries.

## Issues

One file per issue: `issues/<kebab-name>.md`.

When you find a problem (here or surfaced at runtime via Flow driving a downstream project):

1. Create `issues/<kebab-name>.md` containing:
   - Symptom + root cause (if known)
   - `**Severity:** HIGH | MED | LOW`
   - Repro steps / session or task where surfaced
   - Suggested fix direction (if any)

Log only — unless fix is trivial.

### Closing

After fix verified + committed (only files you worked on), delete the issue file. Git history is the audit trail — use clear, concise commit messages explaining what and why.

### Downstream runtime issues

Failures from Flow driving test projects (driver hangs, stage signal bugs, orphaned sessions, agent loops) → log under `issues/` here. Reference downstream task ID + session ULID(s).

### Project-specific (not Flow bugs)

Agent stuck on project decisions / wrong approach for that codebase, harness fine → don't log here. Append to `.flow/learning/<task-name>` instead.

`issues/` is reserved for things Flow itself should detect, prevent, or recover from.

## Learnings

One file per topic: `learnings/<kebab-name>.md`. For non-obvious gotchas a future agent could trip on.

Contents:

- **Symptom:** error / observed behavior
- **Root cause:** why
- **Fix pattern:** shape of fix (snippet if useful)
- **Takeaway:** generalized rule

Never delete. Update when understanding sharpens — no cosmetic churn.

Scope: things that would surprise a competent reader. Not best practices, not framework-documented behavior, not one-off project decisions.

## Plans

Extremely concise. Sacrifice grammar for concision. End with a list of unresolved questions, if any.

## skills

skill use is reccomended

## Subagents

Use subagents for parallel tasks or to save context.

## Output

All output is extremely concise, plain language. Sacrifice grammar for concision.

## Explanations

Explain in a clear logical flow where every point follows naturally from the one before it.

if explanining code. Use a bullet list with nested bullets for explaining code step by step.
