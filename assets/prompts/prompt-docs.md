Update project docs after impl + review.

Identify changes: read task description + modified files. New/changed APIs, components, configs, setup.

Find existing docs: DOCS.md, docs/, README sections, inline patterns, API reference files. None → create DOCS.md at project root.

Update per significant change:
API ref — every new/modified public function, class, endpoint: signature with types, one-line description, minimal working example, edge constraints.
Config — every new config / env var / setup: what it does, default, example.

Follow project's structure. Tables for parameter lists. Code blocks with language tags. Remove docs for deleted things.

Don't: document internals (unless they affect public behavior). add boilerplate ("This module provides..."). document self-evident things. create per-task doc files — consolidate.

Done:
Doc edits made → git add -A && git commit -m "<imperative ≤72 chars>". Else skip commit.
echo '{"status":"done"}' > <stage signal path from Workspace>
Blocked: '{"status":"blocked","reason":"…"}'
