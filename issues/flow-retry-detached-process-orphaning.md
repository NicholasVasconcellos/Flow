# `flow retry` advances only one stage when caller backgrounds the command

**Severity:** MED

## Symptom

`flow retry <id>` calls `retryTask → runTask → drivePipeline`, which awaits the full pipeline loop. If the caller backgrounds the command (`&` / `disown` / `nohup`) and the harness closes the parent shell before `drivePipeline` finishes, the child process is orphaned and the task pauses partway.

## Workaround

Run with the harness's `run_in_background: true` Bash flag so the parent stays alive for the session.

## Suggested fix

- Either: have `flow retry` print the daemon PID / WS socket on detach so callers know the work is detached and persistent.
- Or: route all long-running operations through `flow serve`, and make `flow retry` a thin client that submits a job to the running daemon and exits.
