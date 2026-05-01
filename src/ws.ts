import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import type { Flow } from "./flow.js";
import { ClientCommandSchema, type ServerEvent } from "./wsProtocol.js";

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

  wss.on("connection", (socket) => {
    clients.add(socket);

    const sendToThis = (msg: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    };

    // 1) hello
    sendToThis({ type: "hello", version });

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
    });

    socket.on("error", () => {
      clients.delete(socket);
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
  const replyError = (message: string): void => {
    const payload: ServerEvent = { type: "error", message };
    if (requestId !== undefined) payload.requestId = requestId;
    reply(payload);
  };

  try {
    switch (cmd.type) {
      // --- project.* — v1 is single-project bound by the caller ------------
      case "project.list": {
        // Stub: we don't have a multi-project registry yet. Document this in
        // wsProtocol so the frontend knows to expect an empty list for now.
        reply({ type: "project.list", projects: [] });
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
      case "run.once": {
        void flow.runOnce().catch((err: Error) => {
          replyError(`run.once failed: ${err.message}`);
        });
        return;
      }
      case "run.allOnce": {
        const opts = cmd.limit !== undefined ? { limit: cmd.limit } : undefined;
        void flow.runAllOnce(opts).catch((err: Error) => {
          replyError(`run.allOnce failed: ${err.message}`);
        });
        return;
      }
      case "run.all": {
        const opts = cmd.limit !== undefined ? { limit: cmd.limit } : undefined;
        void flow.runAll(opts).catch((err: Error) => {
          replyError(`run.all failed: ${err.message}`);
        });
        return;
      }
      case "run.cancel": {
        try {
          flow.stop();
        } catch (err) {
          replyError(`run.cancel failed: ${(err as Error).message}`);
        }
        return;
      }

      // --- task.* ---------------------------------------------------------
      case "task.retry":
      case "task.resume": {
        // Fire-and-forget: clients observe progress via the event stream, not
        // the WS reply. Awaiting here would orphan the pipeline if the client
        // disconnects mid-run.
        void flow.retryTask(cmd.taskId).catch((err: Error) => {
          replyError(`task.retry failed: ${err.message}`);
        });
        return;
      }
      case "task.cancel": {
        await flow.cancelTask(cmd.taskId);
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
        } catch (err) {
          reply({
            type: "artifact.error",
            fetchId,
            kind,
            ids,
            message: (err as Error).message,
          });
        }
        return;
      }

      // --- notifications ---------------------------------------------------
      case "notification.ack": {
        await flow.ackNotification(cmd.id);
        return;
      }

      // --- config.* --------------------------------------------------------
      case "config.get": {
        reply({ type: "config", config: flow.getConfig() });
        return;
      }
      case "config.update": {
        const next = await flow.updateConfig(
          cmd.patch as Partial<import("./types.js").Config>,
        );
        // flow.updateConfig emits `config` on the bus which broadcasts to all
        // clients. No need for a direct reply — the broadcast is authoritative.
        void next;
        return;
      }
      case "config.stages.get": {
        const cfg = flow.getConfig();
        reply({ type: "config.stages", stages: cfg.stages ?? {} });
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
        return;
      }
    }
  } catch (err) {
    replyError((err as Error).message);
  }
}
