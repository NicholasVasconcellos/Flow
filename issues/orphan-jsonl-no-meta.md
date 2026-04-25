# Aborted sessions leave orphan `.jsonl` files with no `.meta.json`

**Severity:** LOW

## Symptom

When the driver crashes or a session aborts mid-stream, the `.jsonl` transcript survives but no `.meta.json` is written — meta is final-only. Forensic analysis of "what was this session doing when it died" then has to guess from the transcript alone (no `startedAt`, `stage`, or `taskId` recorded outside the filename).

Observed in three of four pkmn-t8 tasks (initialize-godot-project, create-pokemon-registry, create-natures) under the pre-`121c548` code, but the writer behavior hasn't changed — any future crash will leak the same way.

## Suggested fix

Stream a partial `.meta.json` at session start with `{ id, taskId, stage, startedAt }`. Update it to the final form on close. A crash mid-stream then leaves enough to reconstruct what the session was attempting.
