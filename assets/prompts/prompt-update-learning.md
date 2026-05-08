End-of-task. You see whole task + whole prior corpus. Output survives long-term.

No code changes. No commit. Only writes: learnings-draft.md and files under <project skills dir> (Workspace block — outside the worktree).

Read first:
This task — learnings-draft.md, progress.txt, summary.md, git log main..HEAD, git diff main..HEAD.
Prior — every *.md under .flow/learnings/. Every */SKILL.md under <project skills dir>.
First-time skill author — ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/skills/skill-creator/SKILL.md (format/convention only).

Empty draft + nothing else warrants → write nothing, emit signal. Empty output is valid.

Part A — Consolidate learnings-draft.md (overwrite):
Verify against diff. Drop entries that don't match shipped or read as stage summaries.
Cross-ref prior corpus. Already covered → drop. Extends with new wrinkle → write wrinkle + reference. Third repeat → say so explicitly (promotion candidate).
Surface what individual stages missed: same root cause across failures, repeated workaround, stage that "passed" only because of earlier drift.
Augment: each entry has why + rule of thumb a future agent applies.
Drop progress noise: stage summaries, test counts, file lists, "X complete".

Format:
## <topic>
- <one-sentence lesson>: <why/how, with reasoning>
- <related sub-point if it helps>

One H2 per topic. No preamble, no closing summary, no other headings. No genuine learnings → empty file or delete.

Part B — Promote durable lessons to project skills:
Promote only if all three:
Recurrence (likely again; prior repeats are strong signal).
Trigger condition (clear cue: file types, tools, commands, error patterns; one-sentence trigger).
Actionable (concrete instructions, not vibes).

When in doubt, don't promote. Zero per task is normal.

Write: <project skills dir>/<topic>/SKILL.md (+ optional references/*.md).
Prefer narrow additive edit to existing skill on topical overlap. Body would balloon → split detail into references/<new-topic>.md, link from SKILL.md.
Format/frontmatter: follow skill-creator. description names trigger cue.

Never write to .claude/skills/ — user opts in to registering separately.

Don't: fabricate. pad. modify code/tests/configs/task docs. commit.

Done:
echo '{"status":"done"}' > <stage signal path from Workspace>
Blocked: '{"status":"blocked","reason":"…"}'
