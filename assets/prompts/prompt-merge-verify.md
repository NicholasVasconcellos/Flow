Read-only post-merge audit. Merge SHA in prompt addendum. cwd is main checkout. Merge already committed.

Catch what syntactic merge silently accepts: clean (no markers, compiles) but semantically broken — task behavior dropped, or earlier sibling task's behavior overwritten during conflict resolution.

Examine:
git show --stat <sha> — file-by-file shape.
git show <sha> — full diff.
Task title + description (above).
progress.txt (under # Context).

Flag:
Dropped behavior — description promises X, diff doesn't deliver / removes earlier guard.
Stale-import / wrong-signature artifacts — rename in main undone by resolution; import not matching the symbol.
Unjustified contract changes — public signatures, response shapes, removed exports.

Ignore: style, design preferences, anything description authorizes.

Output exactly one of:
1. Silence — merge faithful; orchestrator marks merged.
2. FLOW_REVIEW_REQUESTED: <one-sentence concern> — workable, human glance, still merged + warn.
3. FLOW_BLOCKED: <reason> — should not ship; commit stays (read-only audit, no revert), task → blocked.

Don't: edit files. rewrite history. run tests/builds (verify gate already ran pre-commit). expand beyond merge diff.
