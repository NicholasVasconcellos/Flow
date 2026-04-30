# React: rendering objects as children

**Symptom:** `Uncaught Error: Objects are not valid as a React child (found: object with keys {stage, message, at})` when clicking a DAG node whose task carried a structured `lastError`.

**Root cause:** `task_details.jsx` rendered `{runtime.lastError}` directly. The payload schema for `lastError` is an object `{ stage, message, at }` (see `examples/flow-ui-payload.js`), not a string. The crash only became reachable when fixture tasks with object-shaped `lastError` were added.

**Fix pattern:** never render a value of unknown shape. Branch on type and pull a known-string field:

```jsx
{typeof runtime.lastError === "string"
  ? runtime.lastError
  : (runtime.lastError?.message ?? JSON.stringify(runtime.lastError))}
```

`title={...}` attributes don't crash on objects but stringify to `"[object Object]"` — same defensive pattern applies (`dag_view.jsx` node tooltip).

**Takeaway:** any field sourced from the payload that *might* be an object — `lastError`, `transientError`, anything with a `.message` shape — needs a renderer that handles both forms. Treat the payload schema as semi-trusted input.
