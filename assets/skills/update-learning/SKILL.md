---
name: update-learning
description: >
  End-of-task reasoning stage. Read what happened across the whole task,
  reason about the bigger picture (including patterns spanning prior tasks),
  consolidate per-stage learning drafts with augmented "why" reasoning, and
  promote durable lessons into project-level Claude Code skills under
  `.claude/skills/`. No code changes; the only writes are to
  `learnings-draft.md` and to project skill files.
disable-model-invocation: true
---

# update-learning

Last stage before merge. Earlier stages drafted scratch notes from their own
slice. **You see the whole task and the whole prior corpus**, and have the
budget to think carefully. Your output is what survives long-term.

**You do not commit.** You do not modify application code, tests, configs, or
task docs. The only writes allowed are to `learnings-draft.md` and to files
under `<worktree>/.claude/skills/`. Newly created/edited skill files travel
with the next merge — the merge stage stages them.

## Inputs

Paths are given in the prompt's **Runtime paths** block. Read all that exist
before writing.

For _this_ task:

- `learnings-draft.md` — what previous stages appended (raw input; Part A's
  output overwrites this).
- `progress.txt` — per-stage coordination log; check for genuine learnings
  that slipped through and for cross-stage patterns.
- `summary.md` — task summary.
- `git log main..HEAD` and `git diff main..HEAD` — what actually shipped.
  Run these to ground yourself.

For prior context (read all that exist):

- All `*.md` under `.flow/learnings/` — distilled learnings from prior
  tasks. Use to spot recurrence and decide what to promote.
- All `*/SKILL.md` under `<worktree>/.claude/skills/` — existing project
  skills, so you can edit one rather than create a duplicate.

For skill-format reference (read once if you'll write skills):

- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/skills/skill-creator/SKILL.md`
  and its `references/`. Read for **format and convention only** — you have
  no human in the loop and are not running its eval workflow.

If `learnings-draft.md` is empty/missing AND nothing else warrants a learning
or skill, write nothing and emit the stage signal. Empty output is valid.

---

## Part A — Consolidate `learnings-draft.md`

Synthesize, don't just reduce.

1. **Read everything first.** Draft, progress, summary, diff, and at least
   skim `.flow/learnings/*.md`.
2. **Verify against the diff.** Drop draft entries that don't match what
   shipped or that read as stage-summaries.
3. **Cross-reference prior corpus.** If the prior corpus already covers it
   well → drop. If this _extends_ prior framing with a new wrinkle → write
   the wrinkle and reference the prior entry. If it's the same bite for the
   third time → say so explicitly; that's a strong promotion candidate.
4. **Surface what individual stages missed.** You see across stages. Look
   for: two unrelated failures with the same root cause; a workaround that
   matches one in a prior task; a stage that "succeeded" only because an
   earlier stage's drift made the check trivial.
5. **Augment with reasoning.** For each entry add the _why_ and the _rule
   of thumb_ a future agent should apply. The bullet is cheap; the
   reasoning is the value.
6. **Drop progress noise.** Stage summaries, test counts, file lists, "X
   complete" sentences, anything visible in the diff.

### Output format

Overwrite `learnings-draft.md`:

    ## <tool or topic>
    - <one-sentence lesson>: <one-sentence why/how, with reasoning>
    - <related sub-point if it genuinely helps>

    ## <next topic>
    - …

One H2 per topic. No preamble, no closing summary, no other headings. If no
genuine learnings remain, delete the file (or write empty).

---

## Part B — Promote durable lessons into project skills

A _learning_ is a fact a future agent should know. A _skill_ loads itself
into context when its description matches and gives instructions to follow.
Skills are how a learning actually prevents the next repeat.

Promote a consolidated learning **only if all three hold**:

- **Recurrence** — likely to come up again, not a one-off. Prior-corpus
  repeats are a strong signal.
- **Trigger condition** — there's a clear cue a future agent could match
  (file types, tool names, commands, error patterns). If you can't write
  the trigger in one sentence, the bar isn't met.
- **Actionable** — concrete enough to encode as instructions. "Always pass
  `--path` before any other arg to Godot" is actionable; "Godot is finicky"
  is not.

When in doubt, **don't promote**. Skills are durable surface area; raise
the bar. Zero promotions per task is normal.

### Where to write

`<worktree>/.claude/skills/<kebab-topic>/SKILL.md`. One topic per skill.

**Prefer editing an existing skill over creating a new one.** Scan
`<worktree>/.claude/skills/*/SKILL.md` for topical overlap first. If you
find one, make a narrow additive edit — don't rewrite or restructure it.

### When the existing skill's scope would balloon

If the new lesson fits the existing skill's _trigger_ but adding the full
detail to the body would push it past ~500 lines or muddy its focus, move
the detail into a subdirectory and reference it from the body. Use the
canonical layout:

```
existing-skill/
├── SKILL.md            # add a one-line pointer in the relevant section
├── references/         # docs loaded on demand (most learnings go here)
│   └── <new-topic>.md
├── scripts/            # only if encoding executable steps
└── assets/             # only if shipping templates/fixtures
```

Body addition looks like:

> When <trigger>, see `references/<new-topic>.md` for <one-line summary>.

This keeps the SKILL.md scannable while letting the detail live somewhere
durable. Don't subdirectory-ify a skill that's still small — only when the
body would otherwise lose focus.

### Skill file format

Follow the canonical Claude Code skill format. Minimum structure:

```md
---
name: <kebab-topic>
description: >
  <One- to two-sentence statement saying BOTH what the skill does AND
  when it should trigger. Include concrete cues — file types, tool
  names, commands, error patterns. This is what Claude Code matches
  against to decide auto-invocation.>
---

# <kebab-topic>

<Imperative, concrete instructions. Include the _why_ in one or two
sentences so a future reader can judge edge cases. Show example
commands or snippets when they make the rule unambiguous.>
```

Frontmatter rules:

- `name` matches the directory name, kebab-case.
- `description` is the highest-leverage field — it gates whether the skill
  loads at all. Write it so that a future agent reading only the prompt
  could recognize "this is the situation that skill is for".
- Body uses the imperative. Prefer "why → rule → example" over musty MUSTs.

**Bad descriptions:**

- "Helpful tips for the project." — no trigger.
- "Use when working on the codebase." — fires always.
- "How to do migrations." — no detectable cue.

**Good descriptions** name the cue: file types, commands, tool names, error
message patterns, task verbs.

---

## Guardrails

- **No code changes.** Only `learnings-draft.md` and files under
  `<worktree>/.claude/skills/`.
- **No git commit.** The orchestrator advances on the stage signal alone.
- **Don't fabricate.** Every entry and skill must trace to draft, progress,
  summary, diff, prior corpus, or existing skills.
- **Don't pad.** Empty Part A and zero promotions in Part B are both common
  and correct outcomes.

## Stage signal

When done, write the signal exactly once:

```
echo '{"stage":"update-learning","status":"done"}' > <stage signal path from prompt>
```

If genuinely blocked, write
`{"stage":"update-learning","status":"blocked","reason":"…"}` and exit. The
orchestrator only advances when this file is present.
