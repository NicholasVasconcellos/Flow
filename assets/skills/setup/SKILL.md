---
name: setup
description: >
  Run pre-execution discovery on the project. Scans services, tools,
  dependencies, and library versions. Outputs a structured readiness report.
  Trigger on: /setup
disable-model-invocation: true
---

# setup

Run pre-execution discovery on the project. Verify that all required services, tools, and dependencies are available and configured before any task work begins.

## Inputs

You will receive:
- The project root directory
- Optionally: a task plan from get-tasks, used to scope what services and tools are relevant

## Step 1 — Generate or update CODEBASE.md

If `CODEBASE.md` does not exist at the project root, create it. If it exists, verify it is current by walking the actual file system and checking for missing entries.

CODEBASE.md must be:
- Hierarchical: mirrors the actual directory structure
- Annotated: each file and directory has a one-line description of its purpose
- Scannable: no prose paragraphs, only structured lists

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

## Step 2 — Scan for required services

Read the project source files and configuration to identify every external service the project depends on. Include:
- Databases (Postgres, MySQL, Redis, SQLite, Supabase, etc.)
- Authentication providers (Clerk, Auth0, Supabase Auth, etc.)
- Storage services (S3, R2, GCS, etc.)
- Email/SMS services (Resend, SendGrid, Twilio, etc.)
- Payment processors (Stripe, etc.)
- Analytics and monitoring (PostHog, Sentry, Datadog, etc.)
- Any other third-party API

For each service found:
1. Check whether the required environment variable(s) are set (read `.env`, `.env.local`, `.env.example`, or equivalent).
2. If the env var is set, send a minimal verification request (a ping, a list call, a health check — whatever the SDK supports) to confirm the credential is valid and the service is reachable.
3. Record the result as `connected`, `missing`, or `unreachable`.

## Step 3 — Discover available tools

Identify all tools available in the current environment:

**MCP servers**: List every MCP server that is currently active. For each, note what it provides (e.g., "Playwright MCP — browser automation").

**Skills**: List skills available in the `.claude/skills/` directory.

**CLI tools**: Check for relevant CLI tools (`git`, `gh`, `docker`, `pnpm`, `npm`, `yarn`, `cargo`, `go`, `python`, `aws`, `gcloud`, `vercel`, `supabase`, etc.) by running `which <tool>` or equivalent. Note version for each found tool.

## Step 4 — Fetch library documentation

Use Context7 to fetch documentation for the primary libraries and frameworks used in the project (read from `package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`, or equivalent).

For each major dependency:
- Confirm the installed version (from lockfile or manifest)
- Confirm this is a current, widely-supported release
- Note any known breaking changes if the project is on an older minor or patch version

Flag any library that is more than one major version behind the current release, or that has a known security advisory.

## Step 5 — Output the discovery report

Output a structured plain-text report with the following sections. Be specific — do not write "configured" without saying what was verified.

---

### Services

For each service discovered:
```
[connected] Supabase — SUPABASE_URL and SUPABASE_ANON_KEY set, list-tables call succeeded
[missing]   Resend — RESEND_API_KEY not set
             Setup: create account at resend.com, generate API key, add to .env as RESEND_API_KEY
[unreachable] Redis — REDIS_URL set but connection timed out
               Check: verify Redis instance is running at the configured URL
```

### Libraries

For each major dependency:
```
next            14.2.3    — current (latest 14.2.x), no concerns
drizzle-orm     0.29.0    — behind (latest 0.30.x), review changelog for migrations API changes
stripe          12.18.0   — 2 major versions behind (latest 14.x), breaking changes in webhook handling
```

### Tools

```
MCP servers:   Playwright MCP, Supabase MCP, Context7 MCP
Skills:        get-tasks, spec, execute, review, discovery
CLI:           git 2.44.0, gh 2.47.0, pnpm 9.1.0, node 20.11.0
Missing:       docker (required for local DB migrations — install from docker.com)
```

### Recommendations

List any missing tools, MCP servers, or configurations that would materially help with the upcoming tasks. For each recommendation, include the install or setup command.

---

## What NOT to do

- Do not write any task implementation code.
- Do not modify source files (CODEBASE.md is the only file you may create or update).
- Do not skip the verification step for services — "env var is set" is not the same as "service is connected."
- Do not report a service as `connected` if the verification request failed or was not attempted.
- Do not install missing tools or set up missing services — report them and let the user decide.

## Termination

When the discovery report has been emitted and `CODEBASE.md` is current,
**stop**. Do not install missing tooling, edit source files, or write tests.
Any extra work is out of scope for setup.

If you cannot proceed safely or need human judgment, output a single line:
`FLOW_BLOCKED: <one-sentence reason>`.
