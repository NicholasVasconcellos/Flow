# Transient API stream timeout forfeits the entire stage + prompt cache

**Severity:** MED

## Symptom

A transient Anthropic API error (e.g. `Stream idle timeout - partial response received`) partway through an otherwise-progressing stage causes Flow to mark the stage `failed` and pause the task. On retry, the stage re-runs from scratch — every read, every tool result, and the full prompt-cache investment (often 30K+ cacheRead tokens) is forfeit.

## Surfaced

`configure-ios-export-preset` documentation stage, 2026-04-24 ~21:05. Agent had finished all reads and was about to make the `DOCS.md` edit when the stream timed out. Full re-run on retry.

## Suggested fix

1. Distinguish `transient_api_error` from `agent_logic_error` in `runAgentStage`. For transient errors, retry the same session (or a continuation that reuses cached context) before pausing the task.
2. Cap retries-on-transient at a small number (2–3) per stage to avoid loops.
3. Surface the cache-cost forfeit in session telemetry so the impact is observable.
