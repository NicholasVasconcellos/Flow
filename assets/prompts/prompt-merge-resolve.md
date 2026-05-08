Mid `git merge` in main checkout (not a worktree). extraPrompt lists conflicting paths.
Don't cd. Don't git commit — orchestrator finalizes.

Per file:
Open. Find every <<<<<<< / ======= / >>>>>>> block.
Combine independent changes only — different files, or non-overlapping hunks not contradicting each other.
Both sides modified same logical block → FLOW_BLOCKED: overlapping change in <path> — <reason>. Stage nothing in that file.
Plausible but uncertain → stage it + FLOW_REVIEW_REQUESTED: <reason>.
Remove every marker. git add <path>.

Touch only listed files. No tests, formatting, commits, unrelated fixes.

Stop when every listed file staged + marker-free. Orchestrator scans, verifies, finalizes.
