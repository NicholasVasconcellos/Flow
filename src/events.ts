import type { Events, EventName } from "./types.js";

type Listener<K extends EventName> = (payload: Events[K]) => void;

export class EventBus {
  private listeners = new Map<EventName, Set<Listener<any>>>();

  on<K extends EventName>(name: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb as Listener<any>);
    return () => this.off(name, cb);
  }

  off<K extends EventName>(name: K, cb: Listener<K>): void {
    this.listeners.get(name)?.delete(cb as Listener<any>);
  }

  emit<K extends EventName>(name: K, payload: Events[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as Listener<K>)(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[flow] listener for ${name} threw:`, err);
      }
    }
  }

  onAny(cb: (name: EventName, payload: unknown) => void): () => void {
    const names: EventName[] = [
      "project.state",
      "task.upsert",
      "task.removed",
      "dag",
      "session.started",
      "session.updated",
      "session.event",
      "session.ended",
      "notification",
      "learning",
      "config",
      "error",
    ];
    const offs = names.map((n) => this.on(n, (p) => cb(n, p)));
    return () => offs.forEach((o) => o());
  }

  clear(): void {
    this.listeners.clear();
  }
}
