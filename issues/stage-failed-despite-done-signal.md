# Stage marked `failed` despite agent writing `done` stage signal + commit

**Severity:** MED

## Symptom

A stage agent: (1) implements the work, (2) runs `git commit`, (3) writes `.flow/tasks/<id>/stage.json` with `{"stage": "<stage>", "status": "done"}`, (4) then issues a non-essential trailing tool call (e.g. `echo learnings...`) that stalls. The stall watchdog SIGTERMs the session, the meta records `failed`, and the task pauses — even though the canonical stage signal already says `done` and the worktree has the commit.

## Surfaced

`implement-networkmanager-host-and-join-functions` exec, 2026-04-25 ~01:30. Commit `c55318d` was on the worktree branch; `stage.json` had `done`; recovery still required manual `state.json` patch + `flow retry`.

## Root cause

In `src/scheduler.ts` the post-session error path (`runAgentStage` rejection) calls `markPaused` without first checking `readStageSignal`. The success path consults `stage.json`; the error path does not.

## Suggested fix

When finalizing a session that ended via stall/SIGTERM/non-zero exit, read `stage.json` first. If `status === "done"` AND a fresh commit exists on the worktree branch since the session started, treat the stage as succeeded — the signal is the canonical "agent finished" event; trailing bash activity is bonus, not load-bearing.
