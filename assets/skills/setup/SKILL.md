---
name: setup
description: >
  Gatekeeper for project readiness. Reads the plan, verifies every declared
  MCP / service / credential / library end-to-end, refreshes CODEBASE.md,
  derives per-tool skills, and hard-blocks if anything is missing.
  Trigger on: /setup
disable-model-invocation: true
---

# setup

You are the environment gatekeeper. Nothing else proceeds until you confirm
the project's tooling is present and working.


## Inputs

`plan.md` is loaded into your prompt as a context file. Read it first and
extract:

- **MCPs** the project intends to use (any name the author wrote — UI
  drivers, database connectors, engine integrations, etc.).
- **Services** the project depends on (databases, auth, storage,
  email/SMS, payments, analytics, third-party APIs).
- **Libraries / frameworks** the project uses or will use.
- **CLI tools** the project requires.

## Step 1 — Refresh `CODEBASE.md`

Create `CODEBASE.md` at the project root if missing. If present, walk
the actual filesystem and update it so it reflects the current tree.

`CODEBASE.md` must be:
- **Hierarchical** — mirrors the actual directory structure
- **Annotated** — one-line description per file/dir
- **Scannable** — structured lists, no prose paragraphs
- **Accurate** — based on the real filesystem

Format:

```
src/
  server/
    index.ts          — Express entry point, registers all routes
    middleware/
      auth.ts         — JWT verification middleware
  db/
    schema.ts         — Drizzle ORM schema definitions
    migrations/       — Migration files (auto-generated, do not edit)
tests/
  server/
    auth.test.ts      — Auth route integration tests
```

## Step 2 — Verify services

For every service declared in `plan.md`:

1. Check whether the required environment variable(s) are set (read
   `.env`, `.env.local`, `.env.example`, or the project's equivalent).
2. If the env var is set, send a minimal verification request (a ping,
   list call, health check — whatever the SDK supports) to confirm the
   credential is valid and the service is reachable.
3. Classify the result as `connected`, `missing`, or `unreachable`.

**`env-set` is not the same as `connected`.** A service is only
`connected` if a verification call actually succeeded.

## Step 3 — Verify MCPs / Plugins / Skills

For every MCP, plugin, skill declared in `plan.md`:

1. Confirm the MCP is currently loaded in the environment.
2. Run a representative call that proves it actually works:
   - **UI MCPs** (browser, simulator, engine drivers) must successfully
     launch the target surface and capture evidence (navigate +
     screenshot, or equivalent).
   - **Other MCPs** run a representative read call appropriate to their
     function (list, query, fetch, status).
3. Record evidence (response excerpt, timing, screenshot path) in the
   setup report.

## Step 4 — Derive per-tool skills

For each verified MCP / tool, downstream agents need actionable usage
instructions. **Always check the global skills directory first:**
`~/.claude/skills/<tool>/SKILL.md`.

| Global skill | Action |
| --- | --- |
| **Exists** | Do not duplicate at the project level. If verification surfaced an improvement (a quirk, flag, version constraint, or workaround the global skill doesn't mention), log it as a Flow issue at `issues/<tool>-skill-improvement.md` with severity, symptom, and suggested fix. The improvement gets manually promoted to the global skill in a separate session — **never edit the global skill directly from here**. |
| **Missing** | Write a project-level skill at `<projectRoot>/.claude/skills/<tool>/SKILL.md` with the verified usage tips (entry points, common flags, viewport defaults, auth-state behavior, etc.). On subsequent setup runs, edit this project-level skill **directly** when new issues surface — don't open a Flow issue, just update the skill in place. |

In `.flow/setup-report.md`, list each tool with the path to its
authoritative skill so downstream agents (`ui-check`, `review`) can find
it.

## Step 5 — Verify CLI tools and project skills

Enumerate the CLI tools declared in `plan.md` (or implied by the
project's package manifests) and capture versions via `which <tool>`
and the appropriate version flag. Note skills already present in
`<projectRoot>/.claude/skills/`.

## Step 6 — Fetch library documentation

For each library/framework declared in `plan.md` (or pinned in the
project manifest — `package.json`, `go.mod`, `requirements.txt`,
`Cargo.toml`, etc.):

1. Confirm the installed version matches a current, widely-supported
   release.
2. Use Context7 to fetch documentation. Place it under
   `docs/<lib>/...`, grouped by library and use case, with current
   function syntax and references downstream agents will need.

Flag any library that is more than one major version behind the current
release, or that has a known security advisory.

## Step 7 — Generate `.env.example`

For every service detected in Step 2, write the exact environment
variable name(s) the project needs into `.env.example`. For each missing
key, include step-by-step acquisition instructions inline as comments.
Example:

```
# Stripe — go to dashboard.stripe.com → Developers → API keys → copy
# the test secret key starting with `sk_test_...`
STRIPE_SECRET_KEY=

# Resend — create an account at resend.com → API Keys → New API Key
RESEND_API_KEY=
```

## Step 8 - Setup git ignore
Write the git ignore based on the file structure and project context.


## Step 8 — Write the setup report

Output `.flow/setup-report.md` with these sections. Be specific — never
write "configured" without saying what was verified.

```markdown
## Services

[connected]   <name> — <env vars set>, <verification call> succeeded
[missing]     <name> — <env vars> not set
              Setup: <where to acquire credential, env var name>
[unreachable] <name> — <env vars> set but <verification call> failed
              Check: <likely cause>

## Libraries

<name>          <version>    — current / behind / N major versions behind
                               <concerns or "no concerns">

## Tools

MCPs:           <name1>, <name2>, ...
Skills:         <name1>, <name2>, ...
CLI:            git X.Y.Z, gh X.Y.Z, ...
Missing:        <name> (<why required — install command>)

## MCP verification

<mcp-name>
  Skill:    ~/.claude/skills/<tool>/SKILL.md  OR  .claude/skills/<tool>/SKILL.md
  Verified: <call made, evidence — screenshot path, response excerpt, timing>
  Notes:    <any quirks observed>

## Recommendations

<every missing or stale item with the specific install/setup command>
```

Downstream skills (`ui-check`, `review`) read this file at runtime to
discover which tools to use. The "MCP verification" section is the
contract — every entry must point at a real skill path.

## Step 9 — Block on missing required items

If any required service are `missing` or `unreachable`,and you where not able to set them up here in this session, any required MCP
failed verification, or any required CLI tool is absent, end with a
single line:

```
FLOW_BLOCKED: <one-sentence reason>
```

Project status flips to `blocked`. The user fixes the gap and re-runs
`/setup`. 

**Preffer solvign issues yourself instead of blocking for user**

## Allowed write paths

- `CODEBASE.md`
- `docs/...`
- `.gitignore`
- `.env.example`
- `.flow/setup-report.md`
- `<projectRoot>/.claude/skills/<tool>/SKILL.md` — only when no global
  skill exists for that tool
- `issues/<tool>-skill-improvement.md` — only when a global skill exists
  and verification surfaced an improvement

## What NOT to do

- Do not write any task implementation code.
- Do not modify source files (only the allowed paths above).
- Do not write to `~/.claude/skills/` (the global skills directory).
  Improvements to global skills go through `issues/` for human review.
- Do not skip the verification step for services — "env var is set" is
  not the same as "service is connected."
- Do not report a service or MCP as `connected` / `verified` if the
  verification call failed or was not attempted.
- Do not install missing tools or set up missing services — report them
  in the recommendations and emit `FLOW_BLOCKED`.
- Do not hardcode tool names in the report's structure — every entry is
  derived from what `plan.md` declared.

## Termination

When the report is written, `CODEBASE.md` is current, `docs/` is
populated, `.env.example` exists with all detected services, and every
declared tool has been verified and skilled, **stop**.

If anything is missing or unverifiable, output:

```
FLOW_BLOCKED: <one-sentence reason>
```
