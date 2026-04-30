# Overnight `needs-review` Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `flow overnight` from labeling `FLOW_REVIEW_REQUESTED` pauses as fatal: classify them into a third bucket and exit with a distinct `needs-review` outcome so the user sees an honest result line and a 0 exit code when the only blocker is human review.

**Architecture:** `runOvernight()` in `src/overnight.ts` partitions paused tasks into `transient` (rate-limit / API hiccups) and `fatal` (everything else). Add a third predicate that matches paused tasks whose latest `Session.reviewRequested` is set, route them to a new `OvernightOutcome` variant `kind: "needs-review"`, and reorder the dispatch so a real fatal still wins over a review pause but a clean review-only state does not get reported as `fatal`. The CLI returns exit 0 on `needs-review` (clean drain awaiting human).

**Tech Stack:** TypeScript (Node ≥20), `node:test` runner, no new deps. Touched files: `src/overnight.ts`, `src/cli.ts`, `test/overnight.test.ts`. Issue file `issues/overnight-review-requested-counted-as-fatal.md` is removed in the final commit per the repo's `CLAUDE.md` policy.

---

## File Structure

- **Modify** `src/overnight.ts` — add the predicate, the new outcome variant, the new bucket, and the logging.
- **Modify** `src/cli.ts:723-729` — handle the new `kind: "needs-review"` outcome (exit 0).
- **Modify** `test/overnight.test.ts` — three new scenarios.
- **Delete** `issues/overnight-review-requested-counted-as-fatal.md` — once the fix lands and tests pass.

`Session.reviewRequested` (already in `src/types.ts:200-202`, shape `{ reason: string }`) is the discriminator. No new fields required.

---

## Task 1: Test — paused review-requested task exits `needs-review`, not `fatal`

**Files:**
- Modify: `test/overnight.test.ts` (append after the existing `scenario` tests, around `test/overnight.test.ts:445`)

- [ ] **Step 1: Write the failing test**

Append to `test/overnight.test.ts`:

```ts
test("scenario E: paused with reviewRequested set exits needs-review (not fatal), no sleep", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const task = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const session = makeSession({
    id: "S1",
    taskId: "T1",
    status: "succeeded",
    transientError: false,
    reviewRequested: { reason: "haptic feedback timing looks off" },
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [task], sessions: [session] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "needs-review");
  if (result.kind === "needs-review") {
    assert.equal(result.reviewCount, 1);
    assert.equal(result.mergedCount, 0);
    assert.equal(result.cycles, 1);
  }
  assert.equal(fake.runAllCalls, 1);
  assert.equal(fake.resumeCalls, 0);
  // No sleep — review pauses do not get retried.
  assert.equal(clock.now(), startMs);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /cycle=1 result=needs_review review=1 merged=0/);
  assert.doesNotMatch(log, /result=fatal/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="scenario E"`
Expected: FAIL — either `result.kind` is `"fatal"` (current behavior) or TypeScript rejects `kind: "needs-review"` because the type doesn't exist yet.

- [ ] **Step 3: Commit the test alone** (so the failing test is preserved as the regression record)

```bash
git add test/overnight.test.ts
git commit -m "test(overnight): add failing scenario E for review-requested classifier"
```

---

## Task 2: Extend `OvernightOutcome` with the `needs-review` variant

**Files:**
- Modify: `src/overnight.ts:39-52`

- [ ] **Step 1: Add the third variant**

Replace lines `src/overnight.ts:39-52`:

```ts
export type OvernightOutcome =
  | {
      kind: "done";
      cycles: number;
      mergedCount: number;
      elapsedMs: number;
    }
  | {
      kind: "fatal";
      cycles: number;
      fatalCount: number;
      mergedCount: number;
      elapsedMs: number;
    }
  | {
      kind: "needs-review";
      cycles: number;
      reviewCount: number;
      mergedCount: number;
      elapsedMs: number;
    };
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no callers of `OvernightOutcome` reach into a `kind: "needs-review"` field yet (the `cli.ts` consumer only checks `result.kind === "fatal"`), so the discriminated union is sound.

---

## Task 3: Add the `isReviewRequestedPaused` predicate and the new bucket

**Files:**
- Modify: `src/overnight.ts:161-203`

- [ ] **Step 1: Update the classifier and dispatch**

Replace the block from `src/overnight.ts:161` through the `if (transient.length === 0)` stalled branch ending at `src/overnight.ts:203`. The full replacement:

```ts
    const latestSession = (t: TaskRuntime): Session | undefined => {
      const sid =
        t.currentSessionId ?? t.sessionIds[t.sessionIds.length - 1] ?? null;
      return sid ? sessionsById.get(sid) : undefined;
    };
    const isTransientPaused = (t: TaskRuntime): boolean =>
      t.status === "paused" && latestSession(t)?.transientError === true;
    const isReviewRequestedPaused = (t: TaskRuntime): boolean =>
      t.status === "paused" && latestSession(t)?.reviewRequested != null;

    const transient = tasks.filter(isTransientPaused);
    const reviewRequested = tasks.filter(isReviewRequestedPaused);
    const fatal = tasks.filter(
      (t) =>
        (t.status === "paused" &&
          !isTransientPaused(t) &&
          !isReviewRequestedPaused(t)) ||
        t.status === "blocked",
    );

    if (fatal.length > 0) {
      const elapsedMs = now() - startedAt;
      await log(
        `[${new Date(now()).toISOString()}] cycle=${cycle} result=fatal merged=${mergedCount} fatal=${fatal.length} review=${reviewRequested.length} transient=${transient.length} cycles=${cycle} elapsed=${formatElapsed(elapsedMs)}`,
      );
      return {
        kind: "fatal",
        cycles: cycle,
        fatalCount: fatal.length,
        mergedCount,
        elapsedMs,
      };
    }

    if (transient.length === 0) {
      if (reviewRequested.length > 0) {
        const elapsedMs = now() - startedAt;
        await log(
          `[${new Date(now()).toISOString()}] cycle=${cycle} result=needs_review review=${reviewRequested.length} merged=${mergedCount} cycles=${cycle} elapsed=${formatElapsed(elapsedMs)}`,
        );
        return {
          kind: "needs-review",
          cycles: cycle,
          reviewCount: reviewRequested.length,
          mergedCount,
          elapsedMs,
        };
      }
      // No work to do but DAG isn't drained — treat as fatal so we don't spin.
      const elapsedMs = now() - startedAt;
      await log(
        `[${new Date(now()).toISOString()}] cycle=${cycle} result=fatal merged=${mergedCount} fatal=0 cycles=${cycle} elapsed=${formatElapsed(elapsedMs)} reason=stalled-no-runnable-tasks`,
      );
      return {
        kind: "fatal",
        cycles: cycle,
        fatalCount: 0,
        mergedCount,
        elapsedMs,
      };
    }
```

The remaining transient-handling block (`let waitUntilMs = 0; …` through `lastResumedCount = resumed.length;`) is unchanged; it still applies when `transient.length > 0`, even if `reviewRequested.length > 0` alongside it (review pauses ride the rate-limit wait at no extra cost — they will surface on the next pass once transients drain).

- [ ] **Step 2: Run scenario E to verify it now passes**

Run: `npm test -- --test-name-pattern="scenario E"`
Expected: PASS.

- [ ] **Step 3: Run the full overnight test file to verify no regressions**

Run: `npm test -- --test-name-pattern="overnight|nextOccurrence|invalid HH"`
Expected: All pass (existing scenarios A/B/C/D + the new E).

- [ ] **Step 4: Commit**

```bash
git add src/overnight.ts
git commit -m "fix(overnight): classify review-requested pauses as needs-review, not fatal"
```

---

## Task 4: Test — review-requested + transient coexist; loop drains transient, then exits needs-review

**Files:**
- Modify: `test/overnight.test.ts` (append after scenario E)

- [ ] **Step 1: Write the test**

```ts
test("scenario F: transient pause resolves, then surviving review pause exits needs-review", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const resetsAtSec = Math.floor(startMs / 1000) + 60;
  const clock = makeFakeClock(startMs);

  // Cycle 1: T1 transient-paused, T2 review-paused.
  const t1Pre = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const t2Pre = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });
  const s1 = makeSession({
    id: "S1",
    taskId: "T1",
    transientError: true,
    rateLimitResetsAt: resetsAtSec,
  });
  const s2 = makeSession({
    id: "S2",
    taskId: "T2",
    status: "succeeded",
    reviewRequested: { reason: "double-check tile collision" },
  });

  // Cycle 2: T1 merged, T2 still review-paused.
  const t1Post = makeTask({
    id: "T1",
    status: "merged",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });

  const fake = makeFakeFlow({
    snapshots: [
      { tasks: [t1Pre, t2Pre], sessions: [s1, s2] },
      { tasks: [t1Post, t2Pre], sessions: [s1, s2] },
    ],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "needs-review");
  if (result.kind === "needs-review") {
    assert.equal(result.reviewCount, 1);
    assert.equal(result.mergedCount, 1);
    assert.equal(result.cycles, 2);
  }
  assert.equal(fake.runAllCalls, 2);
  // Slept exactly once (cycle 1 transient wait), then one resume.
  assert.equal(fake.resumeCalls, 1);
  assert.equal(clock.now(), resetsAtSec * 1000 + 30_000);
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /cycle=1 result=rate_limited/);
  assert.match(log, /cycle=2 result=needs_review review=1 merged=1/);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern="scenario F"`
Expected: PASS.

Note: `makeFakeFlow.resumePausedTasks` flips every `paused` task back to `ready`. In cycle 2 the snapshot re-asserts `T2` as `paused`, so the test remains accurate without needing to teach the fake about review-vs-transient resume semantics.

- [ ] **Step 3: Commit**

```bash
git add test/overnight.test.ts
git commit -m "test(overnight): scenario F covering transient+review-pause interaction"
```

---

## Task 5: Test — real fatal still wins over review-requested in the same cycle

**Files:**
- Modify: `test/overnight.test.ts` (append after scenario F)

- [ ] **Step 1: Write the test**

```ts
test("scenario G: real fatal coexisting with review pause still exits fatal, count excludes reviews", async () => {
  const dir = await mkTmp();
  const startMs = new Date("2026-04-29T22:00:00.000Z").getTime();
  const clock = makeFakeClock(startMs);

  const tFatal = makeTask({
    id: "T1",
    status: "paused",
    currentSessionId: "S1",
    sessionIds: ["S1"],
  });
  const tReview = makeTask({
    id: "T2",
    status: "paused",
    currentSessionId: "S2",
    sessionIds: ["S2"],
  });
  const sFatal = makeSession({
    id: "S1",
    taskId: "T1",
    status: "failed",
    transientError: false,
    error: "agent crashed",
  });
  const sReview = makeSession({
    id: "S2",
    taskId: "T2",
    status: "succeeded",
    reviewRequested: { reason: "verify XP curve" },
  });

  const fake = makeFakeFlow({
    snapshots: [{ tasks: [tFatal, tReview], sessions: [sFatal, sReview] }],
  });

  const result = await runOvernight(
    {
      flow: fake.flow,
      logFilePath: path.join(dir, "overnight.log"),
      print: () => {},
      now: clock.now,
      sleep: clock.sleep,
    },
    {},
  );

  assert.equal(result.kind, "fatal");
  if (result.kind === "fatal") {
    // Fatal count must NOT include the review-pause.
    assert.equal(result.fatalCount, 1);
  }
  assert.equal(fake.runAllCalls, 1);
  assert.equal(clock.now(), startMs); // no sleep
  const log = await fs.readFile(path.join(dir, "overnight.log"), "utf8");
  assert.match(log, /result=fatal merged=0 fatal=1 review=1 transient=0/);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern="scenario G"`
Expected: PASS.

- [ ] **Step 3: Run the full overnight test file**

Run: `npm test -- --test-name-pattern="overnight|nextOccurrence|invalid HH|scenario"`
Expected: All overnight tests pass (A, B, C, D, E, F, G + the fallback test).

- [ ] **Step 4: Commit**

```bash
git add test/overnight.test.ts
git commit -m "test(overnight): scenario G — real fatal wins over review pause"
```

---

## Task 6: Update the CLI to exit 0 on `needs-review`

**Files:**
- Modify: `src/cli.ts:727-729`

- [ ] **Step 1: Replace the exit-code branch**

In `src/cli.ts`, the existing block is:

```ts
      if (result.kind === "fatal") {
        process.exitCode = 1;
      }
```

Replace it with:

```ts
      if (result.kind === "fatal") {
        process.exitCode = 1;
      }
      // result.kind === "needs-review" exits 0: the run drained cleanly,
      // remaining work is parked behind human review, not a failure.
```

(Leaving the comment as a single line is intentional — the surrounding file has similar inline rationales and the rule is non-obvious.)

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "fix(cli): treat overnight needs-review as exit 0 (not a failure)"
```

---

## Task 7: Remove the issue file and verify the tree is clean

**Files:**
- Delete: `issues/overnight-review-requested-counted-as-fatal.md`

- [ ] **Step 1: Delete the issue file**

```bash
git rm issues/overnight-review-requested-counted-as-fatal.md
```

- [ ] **Step 2: Final verification — typecheck + full tests**

Run: `npm run typecheck && npm test`
Expected: All green.

- [ ] **Step 3: Commit the deletion**

```bash
git commit -m "chore(issues): drop overnight-review-requested-counted-as-fatal (fixed)"
```

Per `CLAUDE.md`: the directory should reflect only currently-open issues. Git history is the audit trail.

---

## Self-review

**Spec coverage**

- Symptom (review pauses reported as fatal): fixed in Task 3 by adding `isReviewRequestedPaused` and routing those into a separate bucket. Verified by Task 1's scenario E (`result=needs_review`, no `result=fatal` in log) and Task 5's scenario G (fatal count excludes reviews).
- Root cause (`src/overnight.ts:166-188` 2-bucket partition): replaced with a 3-bucket partition in Task 3.
- Reproduction (mid-DAG task emits `FLOW_REVIEW_REQUESTED`): mirrored by scenarios E/F/G — paused task with `session.reviewRequested = { reason }` set.
- Suggested fix Option A (`kind: "needs-review"` plus `result=needs_review` log): adopted in Tasks 2 and 3.
- Log columns split (review/fatal/transient visible at a glance): implemented in Task 3's fatal log line (`fatal=… review=… transient=…`).

**Placeholder scan**

- No "TBD", "implement later", "handle edge cases", or "similar to Task N". Each task contains exact code or exact commands.
- Each test step has the full code body and the expected outcome of `npm test --test-name-pattern=...`.
- Commit messages are spelled out.

**Type consistency**

- `OvernightOutcome` field name is `reviewCount` everywhere it appears (Task 2 type definition, Task 3 return statement, Task 1 test assertion, Task 4 test assertion). Matches the existing `fatalCount` / `mergedCount` style.
- Log key uses `needs_review` (snake) consistent with existing `rate_limited` log key. Outcome `kind` uses `needs-review` (kebab) consistent with existing `fatal` / `done` lowercase. Both forms are intentional and asserted in the tests.
- `isReviewRequestedPaused` reads `latestSession(t)?.reviewRequested` (a `{ reason: string } | undefined`); the `!= null` check matches how `transientError === true` is shaped just above. `Session.reviewRequested` is verified present in `src/types.ts:200-202`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-overnight-needs-review-classifier.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
