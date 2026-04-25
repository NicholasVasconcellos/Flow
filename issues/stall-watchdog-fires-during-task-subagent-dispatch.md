# Stall watchdog kills parent agent while a `Task()` subagent is in flight

**Severity:** HIGH

## Symptom

Agent stages legitimately spawn `Task()` subagents (Claude Code's `Task` tool, surfacing as `system.subtype=task_progress` events in the stream). While a subagent runs, the parent's stream emits no `text_delta`, no `thinking_delta`, and no `tool_use` start events — the parent appears completely silent from the watchdog's perspective. After 180s the wall-clock stall watchdog (`5993d80`, `src/agent.ts:719-740`) SIGTERMs the parent, which kills the subagent tree as well, even though work was actively progressing inside the subagent.

The session ends with `exitCode: 143`, `error: "Stall: no assistant progress for 180000ms"`, and the stage is paused.

## Surfaced

`flow run-all-once` at concurrency 3 against pkmn-t8 on 2026-04-25 ~14:18-14:29 PHX. Four consecutive stalls, all matching the same fingerprint:

| task | stage | task_progress events (Task subagent) | rate_limit_event | exit | model | thinking |
|---|---|---|---|---|---|---|
| `create-game-camera-with-smooth-follow` | exec | **31** | 1 | 143 | sonnet | megathink |
| `create-encounter-transition-animation` | spec | **25** | 1 | 143 | sonnet | think |
| `implement-player-info-exchange-and-ready-state-rpcs` | exec | 9 | 1 | 143 | sonnet | megathink |
| `create-battle-event-system` | spec | 1 | 1 | 143 | sonnet | think |

In every case, the last event before SIGTERM was a `tool_result` (subagent input) or `task_progress` (subagent dispatch); nothing further until the kill.

## Root cause

`runAgentStage` watches the parent's CLI stdout stream for `text_delta` / non-empty `tool_result` to refresh the staleness timer (`src/agent.ts:719-740`, comment: *"Tool_use and thinking frames don't count as progress"*). A `Task` subagent has its own stream, captured by Claude Code internally — only summary `system.task_progress` / `system.task_updated` events surface to the parent stream, and those don't qualify as "assistant progress" under the current rule. So a subagent that runs longer than `stallTimeoutMs` always trips the watchdog, regardless of whether real work is happening.

The 5-hour rate-limit window had `overageStatus: "rejected"` (`org_level_disabled_until`) at the time of the run, which makes Sonnet noticeably slower — every subagent sat closer to the watchdog threshold than usual, but the underlying mechanism is independent of throttling. Even on a fast day, a long subagent (data generation, multi-file refactor, big test pass) exceeds 180s.

## Why the LAN smoke test passed despite the same pattern

`implement-lan-server-discovery-with-udp-broadcast` had `rate_limit_event` and `task_progress` events too, but its subagents happened to return inside 180s on the runs that completed. It's a flake-by-luck — the watchdog was always armed; subagent length is the Russian-roulette variable.

## Suggested fixes (any one or a combination)

### Option A — Treat `system.task_progress` / `system.task_updated` as activity (preferred)

In `agent.ts:744`-ish, where the watchdog refresh logic inspects each frame, add a branch: if the frame is `{ type: "system", subtype: "task_progress" | "task_updated" }`, refresh `stallTimer` exactly like a non-empty `tool_result` would. The semantic is correct — those events *are* progress signals from the subagent. Cheap, surgical, no config knob.

### Option B — Pause the watchdog while a `Task` is in flight

Track outstanding `Task` tool_use/tool_result pairs. While at least one is unresolved, suspend the wall-clock timer. Resume only after all subagents have returned. This is more invasive (need to match tool_use_id ↔ tool_result) but handles the case where a subagent goes truly silent for thinking-heavy work.

### Option C — Per-stage overrides + raise default for thinking-heavy stages

`stallTimeoutMs` is already per-stage configurable. Bump `exec` (megathink) to e.g. 480s and `spec` to 360s. Cheapest patch but doesn't address the root mechanism — still fails at the new threshold.

### Option D — Classify rate-limit-adjacent stalls as transient

If a `rate_limit_event` occurred in the session and the run ends in `Stall:`, mark `transientError: true` so the new transient-retry path (`6ba7cd9`) absorbs it without consuming the regular retry budget. Doesn't *prevent* the stall but stops it from sticking the task.

### Recommended combination

A + D: surface `task_progress` as activity (fixes the false-positive root cause), and classify rate-limit-context stalls as transient (catches any residual cases). C is a stopgap if A is non-trivial.

## Reproduction

```
cd ~/Developer/pkmn-t8
node ~/Developer/Flow/dist/cli.js run-all-once   # at concurrency 3 with sonnet during a slow API window
# expect ~half of stages spawning Task subagents to stall at ~3:00 elapsed
```

The stalled session jsonls are diagnostic — every one shows `task_progress` events but no `text_delta` after the last `tool_result` (the moment the subagent took over).
