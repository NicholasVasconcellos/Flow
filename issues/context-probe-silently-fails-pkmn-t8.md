# Post-run `contextPercentage` probe silently yields nothing under pkmn-t8

**Severity:** LOW

## Symptom

The web UI's session "context donut" reads 0% (now `—` after the visual fix in `web/src/primitives.jsx:ContextDonut`) for every ended session in `pkmn-t8`. Source of the empty data: the post-run probe at `src/agent.ts:1318-1334` is set up to call `probeContextPercentage()` and persist the result onto `session.contextPercentage`, but in practice **0 of 6** `*.meta.json` files under `pkmn-t8/.flow/sessions/` carry the field. Persistence (the `writeJsonAtomic` at `agent.ts:1355-1358`) is fine — the probe itself is returning nothing.

The probe is wrapped in `try { … } catch { /* swallow */ }`, so any error mode (subcommand absent, schema drift, timeout, claude-cli not finding the session id, etc.) silently produces a session record without a probe value. The wire frame `session.updated` is then never re-emitted with a percentage, and the UI has nothing to render.

## Why it surfaced

While planning `plan-to-resolve-these-temporal-koala.md`, fixture vs. live data was inspected to explain why donuts read 0%. Two compounding causes were found: fixture is sparse (5 of 376 frames have `contextPercentage`), and live `pkmn-t8` data has none. The visual fix (dim `—`) hides the misread for users; this issue tracks fixing the missing-data root cause in the orchestrator.

## Suggested fix direction

Investigation first, code change second:

1. Surface the silent failure: temporarily replace the bare `catch {}` at `src/agent.ts:1327-1329` with a `console.warn`/log emit that captures the failure mode (error message, exit code if a child process is involved). Re-run a session against `pkmn-t8` and read what's actually breaking.
2. Likely culprits to check during step 1:
   - Whether `probeContextPercentage` shells out to `claude` and whether the binary in this environment supports the probe sub-command/format.
   - Whether the `claudeSessionId` argument is the right id at probe time (sessions get renamed mid-run in some flows).
   - Whether the model arg is recognized.
3. Once the failure mode is known, either fix the probe call site or downgrade the catch to log + persist `null` so the UI can distinguish "probed and got nothing back" from "never probed".

A separate, smaller win even before fixing the probe: include `contextPercentage` in the `session.updated` frames the orchestrator already emits during a run (not only post-run). The mid-run JSONL stream from claude-cli often carries usage info that could populate this without an extra probe.

## Severity rationale

LOW because:

- Donuts now display `—` instead of misleading 0% — no false signal.
- No correctness or recovery impact; purely cosmetic / observability.
- Persistence is wired; only the probe input is missing.
- The fix is gated on a 30-second `console.warn` experiment, not a structural change.
