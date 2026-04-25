# Read-only stages (`exec_ui_check`, `code_review_ui_check`) pause despite valid `done` signal

**Severity:** HIGH

## Symptom

The symmetric advance rule introduced in `6ba7cd9` requires both `signal.status === "done"` AND `headMoved === true` to finalize a stage. UI-check stages are observational by design — the skill body explicitly forbids editing application code (uiCheck/SKILL.md L88: "Do not edit application code. uiCheck is observational"). When the agent correctly writes `stage.json` with `done` after a clean check, no commits exist on the worktree branch, so `headMoved` is false and the scheduler emits:

> Stage signal "done" but no commit was made on the worktree branch.

…then pauses the task at `bumpRetryOrPause` (`src/scheduler.ts:546-549`).

`code_review` and `documentation` can hit the same edge when there are no findings or doc changes to make.

## Surfaced

`implement-lan-server-discovery-with-udp-broadcast` exec_ui_check, 2026-04-25 ~13:50. Agent wrote `{"stage":"exec_ui_check","status":"done"}`, working tree clean (implementation already committed in the prior `exec` stage, `70e8a09`). Pipeline paused.

## Root cause

`runAgentStage` treats commit-presence as a universal proxy for "real work happened." Read-only stages legitimately produce zero commits.

## Suggested fix

Introduce `stageCommitsExpected(stage: AgentStage): boolean` (returns false for `exec_ui_check` and `code_review_ui_check`; true otherwise). In the symmetric advance rule, replace `headMoved` with `(headMoved || !stageCommitsExpected(stage))`. The error message at L546 should change accordingly — for read-only stages, signal=done alone is sufficient.

For `code_review` and `documentation`, defer for now (they may produce commits and the conservative behavior is acceptable). If they prove flaky in practice, add them to the read-only set.
