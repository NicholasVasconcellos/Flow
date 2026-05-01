# Incremental store population breaks `||` fallback defaults

**Symptom:** `TaskDetailsPanel` crashed at runtime with `TypeError: Cannot read properties of undefined (reading 'summary')` once any task artifact had streamed in. The error only surfaced after the artifact-streaming feature shipped, even though the rendering code hadn't changed.

**Root cause:** `task_details.jsx` built its `detail` view-model with the pattern

```js
const detail = TASK_DETAILS[taskId] || { description: { summary, acceptance, notes }, ... };
```

This works only while `TASK_DETAILS[taskId]` is fully `undefined`. Once `mergeTaskDetail` (in `web/src/store.js`) starts populating that entry incrementally — `summary`, `progress`, `learningsDraft`, `roundIssuesBodies`, … — the entry becomes truthy but does NOT include `description`. The fallback is skipped wholesale and `detail.description.summary` throws.

The bug was latent: the consumer wrote the fallback when the store either set the whole detail object or nothing. A later commit (`16a322a feat: stream all on-disk artifacts via artifact.fetch`) changed the store to populate fields piecemeal — and the consumer kept assuming all-or-nothing.

**Fix pattern:** layer defaults *under* the stored object and re-default the structured sub-fields the consumer reads:

```js
const stored = TASK_DETAILS[taskId] ?? {};
const detail = {
  ...defaults,         // every field the renderer reads has a value here
  ...stored,           // wire fields override defaults
  description: stored.description ?? defaults.description,  // re-default nested objects
};
```

The `description: stored.description ?? defaults.description` line is the non-obvious part: object spread is shallow, so a stored object that lacks `description` would otherwise leave `detail.description` undefined.

**Takeaway:** any view-model that defaults via `store[k] || {…defaults}` is a tripwire as soon as the store starts populating `store[k]` incrementally. Whenever a store key is populated by multiple writers (live frames, artifact chunks, project.state inlines), assume any individual field may be missing and merge defaults *per-field*, not at the object level. The same trap applies to `flags`, `description`, and any other nested object the consumer drills into.
