# Session `.meta.json` records `id: null` for project-level stages

**Severity:** LOW

## Symptom

For project-level stages (`setup`, `getTasks`), the session `.meta.json` file's `id` field is `null`. The ULID in the filename is the actual session id and is the source of truth, but the meta's null id is misleading when grepping or auditing forensically.

## Suggested fix

When writing `.meta.json` for project-level stages, populate `id` with the session ULID from the filename. One-line fix in the session writer.
