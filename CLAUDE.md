# Flow

Flow is an automated workflow orchestrator that drives multi-stage agent pipelines (spec → exec → review → commit → mergeResolve → docs) across task worktrees. It is the harness under test whenever Flow itself is run against a downstream project (e.g. `pkmn-t8`).

## Issue tracking

All known issues live as one file per issue under `issues/<issue-name>.md`. 

When you find a problem (in this codebase or surfaced at runtime by Flow driving a downstream project):

1. Add a file `issues/<short-kebab-name>.md`.
2. The file must contain:
   - A clear explanation of the symptom and the root cause if known.
   - The severity tag: `**Severity:** HIGH | MED | LOW`.
   - Reproduction steps or the session/task where it surfaced (when applicable).
   - Suggested fix direction if you have one.

**Log only — do not implement fixes when discovering an issue.** Record the proposed fix in the issue file. Fixes are applied later in a dedicated session.

If you have addressed an issue, verified the fix and commit the changes, **delete the file from `issues/`** in the same commit (or the immediately following one). The directory should reflect only what is currently open. Don't leave "FIXED" markers or historical entries — git history is the audit trail.

### Runtime issues from downstream projects

Flow is an automated workflow setup. When overseeing creation of other projects to test it (e.g. pkmn-t8), any in-production findings — driver hangs, stage signal misbehavior, orphaned sessions, agent loops, etc. — should be logged as new files under `issues/` here in the Flow repo. Reference the downstream task ID and session ULID(s) so the failure is reconstructible.

### Project-specific issues (not Flow bugs)

If a problem is specific to the downstream project itself — the agent is stuck on a project decision, doing the wrong thing for that codebase, or chasing the wrong approach — and the workflow harness is behaving correctly, do not log it here. Instead:

1. Nudge the agent in-place by sending a message in the project session. (project's claude.md or relevant internal section)
2. Append the correction to the project's learnings (.flow/learning/<task-name>)

Reserve `issues/` for things Flow itself should detect, prevent, or recover from.
