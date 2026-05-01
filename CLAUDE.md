# Flow

Flow is an automated workflow orchestrator that drives multi-stage agent pipelines (spec → exec → review → commit → merge-resolve → docs) across task worktrees. It is the harness under test whenever Flow itself is run against a downstream project (e.g. `pkmn-t8`).

## Reading Codebase

before reading the codebase reference map.md for an index and summary of each file, use it to know where to find the relevant context.

## Issue tracking

All known issues live as one file per issue under `issues/<issue-name>.md`.

When you find a problem (in this codebase or surfaced at runtime by Flow driving a downstream project):

1. Add a file `issues/<short-kebab-name>.md`.
2. The file must contain:
   - A clear explanation of the symptom and the root cause if known.
   - The severity tag: `**Severity:** HIGH | MED | LOW`.
   - Reproduction steps or the session/task where it surfaced (when applicable).
   - Suggested fix direction if you have one.

**Log only — do not implement fixes when discovering an issue.** Record the proposed fix in the issue file. Fixes are applied later in a dedicated session. Except when the fix is truly trivial, then just do it.

If you have addressed an issue, verified the fix and commit the changes (only the files you worked on), **safely delete the file from `issues/`**.

git history is the audit trail of the project, use consise and clear summary and explanations as to why and what.

### Runtime issues from downstream projects

Flow is an automated workflow setup. When overseeing creation of other projects to test it (e.g. pkmn-t8), any in-production findings — driver hangs, stage signal misbehavior, orphaned sessions, agent loops, etc. — should be logged as new files under `issues/` here in the Flow repo. Reference the downstream task ID and session ULID(s) so the failure is reconstructible.

### Project-specific issues (not Flow bugs)

If a problem is specific to the downstream project itself — the agent is stuck on a project decision, doing the wrong thing for that codebase, or chasing the wrong approach — and the workflow harness is behaving correctly, do not log it here. Instead:

1. Append the correction to the project's learnings (.flow/learning/<task-name>)

Reserve `issues/` for things Flow itself should detect, prevent, or recover from.

## Learnings

Non-obvious gotchas and hard-won knowledge live as one file per topic under `learnings/<short-kebab-name>.md`.

When you hit a subtle bug, framework quirk, or constraint that wasn't obvious from the code or docs — and a future agent could plausibly trip on it again — write it down:

1. Add a file `learnings/<short-kebab-name>.md`.
2. The file should contain:
   - **Symptom:** the error message or observed behavior.
   - **Root cause:** why it happens.
   - **Fix pattern:** the shape of the fix (code snippet if useful).
   - **Takeaway:** the generalized rule, so the lesson transfers beyond the specific bug.

Unlike `issues/`, learnings are not deleted once resolved — they are reference material. Update them if your understanding sharpens, but don't churn the file over cosmetic edits.

Scope: things that would surprise a competent reader of the code. Not for general best practices, not for things already documented in framework docs, not for one-off project decisions.
