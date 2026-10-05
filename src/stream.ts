import * as z from "zod/v4";
import type {
  ProtocolSession,
  ProtocolStream,
  ProtocolEnd,
} from "./protocol.js";

export interface EventData {
  eventId: string;
  name: string;
  timestamp: string;
  cursor?: string | null;
  data: unknown;
}
export interface Subscription {
  id: string;
  server: string;
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  status: "opening" | "active" | "stopped" | "ended" | "failed";
  error?: string;
  endReason?: ProtocolEnd["reason"];
}
const record = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const catalogSchema = z.object({
  events: z.array(
    z
      .object({
        name: z.string(),
        delivery: z.array(z.string()),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        description: z.string().optional(),
      })
      .passthrough(),
  ),
  nextCursor: z.string().optional(),
});

/** Events protocol semantics over the adapter's mediated protocol API. */
export class EventConnection {
  private streams = new Map<
    string,
    {
      sub: Subscription;
      stream: ProtocolStream;
      ready: () => void;
      fail: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      seen: Set<string>;
    }
  >();
  private closed = false;
  private opening = 0;
  get idle() {
    return this.opening === 0 && this.streams.size === 0;
  }
  constructor(
    readonly server: string,
    private session: ProtocolSession,
    private onEvent: (sub: Subscription, event: EventData) => void,
    private onStatus: (
      sub: Subscription,
      unexpected: boolean,
    ) => void = () => {},
    private onGap: (sub: Subscription) => void = () => {},
    private timeoutMs = 15000,
  ) {
    session.signal.addEventListener("abort", this.disconnected, { once: true });
    if (session.signal.aborted) this.disconnected();
  }
  private disconnected = () =>
    this.close("MCP connection ended; subscribe again to resume.");
  async catalog(signal?: AbortSignal) {
    const events: z.infer<typeof catalogSchema>["events"] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = catalogSchema.parse(
        await this.session.request(
          "events/list",
          cursor ? { cursor } : {},
          signal,
        ),
      );
      events.push(...page.events);
      cursor = page.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 100)
          throw new Error("Invalid or excessive event catalog pagination");
        seen.add(cursor);
      }
    } while (cursor);
    return events;
  }
  async subscribe(
    name: string,
    args: Record<string, unknown>,
    cursor: string | null = null,
    signal?: AbortSignal,
  ): Promise<Subscription> {
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.closed) throw new Error("MCP connection closed");
    this.opening++;
    let entry;
    try {
      entry = (await this.catalog(signal)).find((e) => e.name === name);
    } finally {
      this.opening--;
    }
    if (!entry) throw new Error(`Unknown MCP event: ${name}`);
    if (!entry.delivery.includes("push"))
      throw new Error("This event does not advertise draft push delivery");
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.closed) throw new Error("MCP connection closed");
    const sub: Subscription = {
      id: "",
      server: this.server,
      name,
      arguments: args,
      cursor,
      status: "opening",
    };
    const stream = this.session.openStream(
      "events/stream",
      { name, arguments: args, cursor },
      (method, params) => this.consume(sub.id, method, params),
    );
    sub.id = stream.id;
    const active = new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => {
        void this.cancel(sub.id, "Event stream activation timed out");
      }, this.timeoutMs);
      this.streams.set(sub.id, {
        sub,
        stream,
        ready,
        fail,
        timer,
        seen: new Set(),
      });
    });
    const cancelled = () => {
      void this.cancel(sub.id);
    };
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    void stream.closed.then((end) => this.finish(sub.id, end));
    try {
      await Promise.all([stream.sent, active]);
      if (sub.status !== "active")
        throw new Error(
          sub.error ?? "Event stream ended before subscription completed",
        );
      return sub;
    } catch (error) {
      await this.cancel(
        sub.id,
        error instanceof Error ? error.message : "Subscription failed",
      );
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelled);
    }
  }
  private consume(
    id: string,
    method: string,
    p: Record<string, unknown>,
  ): void {
    const item = this.streams.get(id);
    if (!item) return;
    const { sub } = item;
    if (!record(p)) return;
    if (method === "notifications/events/active") {
      if (sub.status !== "opening") return;
      clearTimeout(item.timer);
      sub.status = "active";
      if (typeof p.cursor === "string") sub.cursor = p.cursor;
      if (p.truncated) this.onGap(sub);
      item.ready();
      this.onStatus(sub, false);
    } else if (method === "notifications/events/event") {
      if (
        sub.status !== "active" ||
        typeof p.eventId !== "string" ||
        p.name !== sub.name ||
        typeof p.timestamp !== "string" ||
        !("data" in p)
      )
        return;
      if (
        p.eventId.length > 1024 ||
        p.name.length > 256 ||
        p.timestamp.length > 80
      )
        return;
      if (item.seen.has(p.eventId)) return;
      item.seen.add(p.eventId);
      if (item.seen.size > 10000)
        item.seen.delete(item.seen.values().next().value!);
      if (typeof p.cursor === "string") sub.cursor = p.cursor;
      sub.error = undefined;
      this.onEvent(sub, {
        eventId: p.eventId,
        name: p.name,
        timestamp: p.timestamp,
        cursor: typeof p.cursor === "string" ? p.cursor : undefined,
        data: p.data,
      });
    } else if (method === "notifications/events/heartbeat") {
      if (typeof p.cursor === "string") sub.cursor = p.cursor;
    } else if (method === "notifications/events/error") {
      const error =
        record(p.error) && typeof p.error.message === "string"
          ? p.error.message
          : "Upstream event error";
      if (sub.error !== error) {
        sub.error = error;
        this.onStatus(sub, sub.status === "active");
      }
    }
    return;
  }
  private finish(id: string, end: ProtocolEnd) {
    const item = this.streams.get(id);
    if (!item) return;
    const wasActive = item.sub.status === "active";
    this.streams.delete(id);
    clearTimeout(item.timer);
    item.sub.status =
      end.reason === "cancelled"
        ? "stopped"
        : end.reason === "ended"
          ? "ended"
          : "failed";
    item.sub.endReason = end.reason;
    item.sub.error = end.error;
    item.fail(
      new Error(
        end.error ??
          (end.reason === "cancelled"
            ? "Subscription cancelled"
            : "Event stream ended"),
      ),
    );
    this.onStatus(item.sub, wasActive && end.reason !== "cancelled");
  }
  async cancel(id: string, error?: string) {
    const item = this.streams.get(id);
    if (!item) return;
    this.finish(
      id,
      error ? { reason: "error", error } : { reason: "cancelled" },
    );
    await item.stream.cancel();
  }
  close(error?: string) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, item] of this.streams) {
      this.finish(
        id,
        error ? { reason: "disconnected", error } : { reason: "cancelled" },
      );
      void item.stream.cancel();
    }
    this.session.signal.removeEventListener("abort", this.disconnected);
    this.session.close();
  }
}
