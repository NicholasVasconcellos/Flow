import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import type { Flow } from "./flow.js";
import {
  ClientCommandSchema,
  CLIENT_COMMAND_TYPES,
  type ServerEvent,
} from "./wsProtocol.js";

export interface WsServerOpts {
  port?: number; // default opts.flow.getConfig().ws.port or 7777
  host?: string; // default 127.0.0.1
  flow: Flow;
  version: string;
}

export interface WsServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Start a WebSocket server bound to a Flow. The server does not own the Flow
 * lifecycle — callers are responsible for constructing the Flow and calling
 * `flow.stop()` when appropriate.
 *
 * Protocol: plan.md §14.
 */
export async function startWsServer(opts: WsServerOpts): Promise<WsServer> {
  const { flow, version } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? flow.getConfig().ws.port ?? 7777;

  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ host, port });

  // -------------------------------------------------------------------------
  // Broadcast wiring — subscribe once per server, not per client.
  // -------------------------------------------------------------------------

  const broadcast = (msg: ServerEvent): void => {
    const frame = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(frame);
        } catch {
          /* ignore individual send failures */
        }
      }
    }
  };

  const bus = flow.getEventBus();
  const offs: Array<() => void> = [];
  offs.push(bus.on("task.upsert", ({ task }) => broadcast({ type: "task.upsert", task })));
  offs.push(bus.on("task.removed", ({ taskId }) => broadcast({ type: "task.removed", taskId })));
  offs.push(bus.on("dag", (dag) => broadcast({ type: "dag", nodes: dag.nodes, edges: dag.edges })));
  offs.push(bus.on("session.started", ({ session }) => broadcast({ type: "session.started", session })));
  offs.push(bus.on("session.updated", ({ session }) => broadcast({ type: "session.updated", session })));
  offs.push(bus.on("session.event", ({ event }) => broadcast({ type: "session.event", event })));
  offs.push(bus.on("session.ended", ({ session }) => broadcast({ type: "session.ended", session })));
  offs.push(
    bus.on("notification", ({ notification }) =>
      broadcast({ type: "notification", notification }),
    ),
  );
  offs.push(
    bus.on("notifications.cleared", () =>
      broadcast({ type: "notifications.cleared" }),
    ),
  );
  offs.push(
    bus.on("learning", ({ taskId, path, markdown }) =>
      broadcast({ type: "learning", taskId, path, markdown }),
    ),
  );
  offs.push(bus.on("config", ({ config }) => broadcast({ type: "config", config })));
  offs.push(
    bus.on("error", (err) => {
      const payload: ServerEvent = { type: "error", message: err.message };
      if (err.requestId !== undefined) payload.requestId = err.requestId;
      broadcast(payload);
    }),
  );
  offs.push(bus.on("project.state", ({ project }) => broadcast({ type: "project.state", project })));

  // -------------------------------------------------------------------------
  // Run cancellation tracking — `run.cancel` stops any in-progress run.*.
  // -------------------------------------------------------------------------

  // Flow.stop() is idempotent and cancels the scheduler, so we just call it
  // whenever the client issues run.cancel. The scheduler honors the flag for
  // the remainder of runAll / runAllOnce; further invocations of run.* after a
  // cancel are effectively no-ops until the Flow is restarted.

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  // Disk-mtime poll for read-only servers. When a sibling driver
  // (`run-all`, `overnight`) mutates state.json, re-load and re-emit
  // `task.upsert` so connected clients see the change without the in-memory
  // copy going stale. Loop is started/stopped with the connected-client
  // count to avoid burning a 2s timer on an idle server.
  const READ_ONLY_POLL_MS = 2_000;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const startPolling = (): void => {
    if (pollTimer || !flow.isReadOnly()) return;
    pollTimer = setInterval(() => {
      void flow.refreshFromDisk().catch(() => {
        /* swallow — best-effort */
      });
    }, READ_ONLY_POLL_MS);
    pollTimer.unref?.();
  };
  const stopPolling = (): void => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  wss.on("connection", (socket) => {
    clients.add(socket);
    startPolling();

    const sendToThis = (msg: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    };

    // 1) hello
    sendToThis({
      type: "hello",
      version,
      capabilities: {
        readOnly: flow.isReadOnly(),
        supportedCommands: [...CLIENT_COMMAND_TYPES],
      },
    });

    // 2) project.state if a project is open
    void (async () => {
      try {
        const project = await flow.getProject();
        if (project) sendToThis({ type: "project.state", project });
      } catch {
        /* flow not bound to a project — skip */
      }
    })();

    // 3) config
    try {
      sendToThis({ type: "config", config: flow.getConfig() });
    } catch {
      /* ignore */
    }

    socket.on("message", (raw) => {
      let requestId: string | undefined;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && "requestId" in parsed) {
          const candidate = (parsed as { requestId?: unknown }).requestId;
          if (typeof candidate === "string") requestId = candidate;
        }
        const cmd = ClientCommandSchema.parse(parsed);
        void handleCommand(cmd, socket, sendToThis, flow);
      } catch (err) {
        const payload: ServerEvent = {
          type: "error",
          message: (err as Error).message,
        };
        if (requestId !== undefined) payload.requestId = requestId;
        sendToThis(payload);
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      if (clients.size === 0) stopPolling();
    });

    socket.on("error", () => {
      clients.delete(socket);
      if (clients.size === 0) stopPolling();
    });
  });

  // -------------------------------------------------------------------------
  // Wait for listening — `ws` uses the node http server under the hood.
  // -------------------------------------------------------------------------

  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      wss.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      wss.off("listening", onListening);
      reject(err);
    };
    wss.once("listening", onListening);
    wss.once("error", onError);
  });

  const address = wss.address() as AddressInfo | string | null;
  const resolvedPort =
    typeof address === "object" && address !== null ? address.port : port;

  const close = async (): Promise<void> => {
    stopPolling();
    // Stop accepting connections and unsubscribe.
    for (const off of offs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    // Terminate all sockets.
    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return { port: resolvedPort, close };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function handleCommand(
  cmd: import("./wsProtocol.js").ClientCommand,
  _socket: WebSocket,
  reply: (msg: ServerEvent) => void,
  flow: Flow,
): Promise<void> {
  const requestId = cmd.requestId;

  // Single-shot result emitter. Every command yields exactly one
  // `command.result` (when a requestId is set) — `replySuccess` and
  // `replyFailure` are gated by `resolved` so duplicate calls (e.g. fire-
  // and-forget paths whose async tail rejects after we've already accepted)
  // are silently dropped. Falls back to the legacy `error` frame when no
  // requestId is available.
  let resolved = false;
  const replySuccess = (data?: unknown): void => {
    if (resolved) return;
    resolved = true;
    if (requestId === undefined) return;
    const payload: ServerEvent = {
      type: "command.result",
      requestId,
      ok: true,
    };
    if (data !== undefined) payload.data = data;
    reply(payload);
  };
  const replyError = (message: string): void => {
    if (resolved) return;
    resolved = true;
    if (requestId !== undefined) {
      reply({ type: "command.result", requestId, ok: false, message });
    } else {
      reply({ type: "error", message });
    }
  };

  // notification.clearAll is intentionally absent: clearing notifications is UI
  // state (truncates .flow/notifications.jsonl + broadcasts notifications.cleared),
  // not scheduler state — Flow.clearNotifications skips guardWritable.
  const MUTATING_COMMANDS = new Set([
    "run.once",
    "run.allOnce",
    "run.all",
    "run.cancel",
    "task.retry",
    "task.resume",
    "task.cancel",
    "notification.ack",
    "config.update",
    "config.stages.update",
  ]);
  if (flow.isReadOnly() && MUTATING_COMMANDS.has(cmd.type)) {
    replyError(
      `${cmd.type} is not permitted: serve runs read-only. Run a sibling driver (flow run-all / overnight) to drive tasks.`,
    );
    return;
  }

  try {
    switch (cmd.type) {
      // --- project.* — v1 is single-project bound by the caller ------------
      case "project.list": {
        // Stub: we don't have a multi-project registry yet. Document this in
        // wsProtocol so the frontend knows to expect an empty list for now.
        reply({ type: "project.list", projects: [] });
        replySuccess();
        return;
      }
      case "project.open": {
        const current = await flow.getProject();
        if (current.path !== cmd.path) {
          replyError(
            "project.open not supported — server bound to single project",
          );
          return;
        }
        reply({ type: "project.state", project: current });
        replySuccess();
        return;
      }
      case "project.create": {
        replyError("project.create not supported in v1");
        return;
      }
      case "project.close": {
        replyError("project.close not supported in v1");
        return;
      }

      // --- run.* — fire-and-forget; events drive the UI -------------------
      // Acceptance is the result we report. Late failures from the runner
      // surface via session events / notifications, not the WS reply.
      case "run.once": {
        void flow.runOnce().catch(() => {
          /* tail-error surfaces via events */
        });
        replySuccess();
        return;
      }
      case "run.allOnce": {
        const opts = cmd.limit !== undefined ? { limit: cmd.limit } : undefined;
        void flow.runAllOnce(opts).catch(() => {
          /* tail-error surfaces via events */
        });
        replySuccess();
        return;
      }
      case "run.all": {
        const opts = cmd.limit !== undefined ? { limit: cmd.limit } : undefined;
        void flow.runAll(opts).catch(() => {
          /* tail-error surfaces via events */
        });
        replySuccess();
        return;
      }
      case "run.cancel": {
        try {
          flow.stop();
        } catch (err) {
          replyError(`run.cancel failed: ${(err as Error).message}`);
          return;
        }
        replySuccess();
        return;
      }

      // --- task.* ---------------------------------------------------------
      case "task.retry":
      case "task.resume": {
        // Fire-and-forget: clients observe progress via the event stream, not
        // the WS reply. Awaiting here would orphan the pipeline if the client
        // disconnects mid-run.
        void flow.retryTask(cmd.taskId).catch(() => {
          /* tail-error surfaces via events */
        });
        replySuccess();
        return;
      }
      case "task.cancel": {
        await flow.cancelTask(cmd.taskId);
        replySuccess();
        return;
      }

      // --- artifact.fetch — stream any on-disk artifact via ProjectArtifacts
      case "artifact.fetch": {
        const { fetchId, kind, ids } = cmd;
        try {
          const it = flow.getArtifacts().fetch(
            kind as Parameters<
              ReturnType<Flow["getArtifacts"]>["fetch"]
            >[0],
            ids,
          );
          for await (const chunk of it) {
            reply({
              type: "artifact.chunk",
              fetchId,
              kind: chunk.kind,
              ids: chunk.ids,
              payload: chunk.payload,
            });
          }
          reply({ type: "artifact.end", fetchId, kind, ids });
          // Result is bound to the terminal frame, not the chunks.
          replySuccess();
        } catch (err) {
          reply({
            type: "artifact.error",
            fetchId,
            kind,
            ids,
            message: (err as Error).message,
          });
          replyError(`artifact.fetch failed: ${(err as Error).message}`);
        }
        return;
      }

      // --- notifications ---------------------------------------------------
      case "notification.ack": {
        await flow.ackNotification(cmd.id);
        replySuccess();
        return;
      }
      case "notification.clearAll": {
        await flow.clearNotifications();
        replySuccess();
        return;
      }

      // --- config.* --------------------------------------------------------
      case "config.get": {
        reply({ type: "config", config: flow.getConfig() });
        replySuccess();
        return;
      }
      case "config.update": {
        const next = await flow.updateConfig(
          cmd.patch as Partial<import("./types.js").Config>,
        );
        // flow.updateConfig emits `config` on the bus which broadcasts to all
        // clients. No need for a direct reply — the broadcast is authoritative.
        void next;
        replySuccess();
        return;
      }
      case "config.stages.get": {
        const cfg = flow.getConfig();
        reply({ type: "config.stages", stages: cfg.stages ?? {} });
        replySuccess();
        return;
      }
      case "config.stages.update": {
        const cfg = flow.getConfig();
        const merged = { ...(cfg.stages ?? {}) };
        for (const [k, v] of Object.entries(cmd.stages)) {
          merged[k as keyof typeof merged] = {
            ...(merged[k as keyof typeof merged] ?? {}),
            ...v,
          };
        }
        await flow.updateConfig({ stages: merged });
        const after = flow.getConfig();
        reply({ type: "config.stages", stages: after.stages ?? {} });
        replySuccess();
        return;
      }
    }
  } catch (err) {
    replyError((err as Error).message);
  }
}
