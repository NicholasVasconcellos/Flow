# Repeat-tool-call cap kills healthy sessions on benign re-issues

**Severity:** MED

## Symptom

A session is killed with `looped_on_blocked_tool: agent re-issued the same Bash command N times: …` (non-retryable, `src/agent.ts:957-964`) when the agent has issued the same Bash `command` string `repeatToolCallCap` times (default `3`) over the *entire session* — even when each invocation was legitimate and produced useful output. The cap is meant to catch infinite-loop behavior on a blocked tool, but the implementation cannot distinguish "stuck retrying a failing command" from "deliberately re-checking state."

## Root cause

`src/agent.ts:857-879` keys the counter on the full command string and increments session-globally:

```ts
const key = `${block.name}:${cmd}`;             // exact match, full command
const next = (bashCallCounts.get(key) ?? 0) + 1;
bashCallCounts.set(key, next);
if (next >= repeatToolCallCap) { /* SIGTERM */ }
```

Properties of the current rule:
- **Cumulative, not consecutive.** Different commands interleaved between repeats do *not* reset the counter.
- **Exact-string match.** `git status` and `git status -s` are different keys, but two identical `git status` calls share one.
- **No exclusions** for read-only / safe commands (`git status`, `ls`, `cat`, `grep`, `pwd`, `tail`).
- **Outcome-blind.** A command that previously *succeeded* counts the same as one that previously errored or returned empty — the watchdog can't tell that a re-issue is intentional.
- **Non-retryable error.** When the cap fires, `transientError` is not set, so the normal retry budget doesn't absorb it.

## Realistic false-positive scenarios

1. **Sanity-check `git status`** — agent runs it after `git add`, after `git commit`, and once more before handing off → 3 invocations → killed on the third.
2. **Test re-verify loop** — `npm test` (baseline) → fix code → `npm test` (verify) → small follow-up → `npm test` (final) → killed.
3. **Polling a long build/log** — repeated `tail -n 50 build.log` or `grep -q ready dev.log` while waiting → trivially exceeds 3.
4. **Exploratory grep** — agent runs the same `grep -r "FooService" src/` twice during investigation, then once more after editing → killed.

The watchdog as built assumes "if you ran it more than twice, you're stuck." That heuristic is too aggressive for any session involving iterative validation.

## Surfaced

Identified by code reading during a Flow self-review session on 2026-04-26 (no production trip recorded yet — this is preventive). The mechanism is independent of the recently-fixed stall watchdog (`5ee0cf4`) but shares the same family of "watchdog kills healthy work" failure mode.

## Suggested fixes

### Option A — Make the cap consecutive, not cumulative (preferred)

Reset the counter for a given command key whenever a *different* tool call occurs. Captures genuine "stuck issuing X over and over with nothing in between" loops, while letting interleaved healthy re-issues through. One-line change to the increment logic in `src/agent.ts:857-879`.

### Option B — Only count re-issues whose prior result was empty/error

Track the last `tool_result` for each command key. If the previous run produced a non-empty, non-error result, treat the next invocation as a *new* legitimate call and reset the counter. A command that *worked* and is being re-run is almost always intentional; a command that *failed* and is being re-run unchanged is the actual loop signal.

### Option C — Exempt a small allowlist of read-only commands

Skip counting for `git status`, `git diff`, `ls`, `pwd`, `cat`, `grep`, `find`, `tail`, `head`, `which`, `node --version`, etc. Cheap stopgap, doesn't fix the underlying logic but cuts off the most common false positives. (Less principled than A or B; introduces an arbitrary list to maintain.)

### Option D — Raise the default cap

Bump from `3` to e.g. `6` or `8`. Buys headroom but doesn't fix the mechanism — a polling loop still trips it eventually, just later.

### Recommended combination

**A + B.** Consecutive-only catches most legitimate use, and outcome-aware suppression catches the remainder (e.g. `npm test` re-runs after a fix). Together they preserve the original intent — kill genuinely-stuck loops — without punishing healthy iterative work. C and D are stopgaps if A/B are deferred.

## Reproduction

Trigger any stage where the agent legitimately re-issues an identical Bash command three times. Example: a `code_review` stage that runs `npm test` for baseline, runs it again after a fix, then once more for final verification — the third invocation will SIGTERM the session with `looped_on_blocked_tool`.
