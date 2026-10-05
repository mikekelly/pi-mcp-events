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
  status:
    | "opening"
    | "active"
    | "reconnecting"
    | "stopped"
    | "ended"
    | "failed";
  maxAgeMs?: number;
  truncated?: boolean;
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

interface Item {
  sub: Subscription;
  stream?: ProtocolStream;
  ready: () => void;
  fail: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  seen: Set<string>;
  activated: boolean;
  attempts: number;
  outage: boolean;
}
export interface PushOptions {
  reconnect?: () => Promise<ProtocolSession>;
  onClose?: () => void;
  heartbeatTimeoutMs?: number;
  retryBaseMs?: number;
  maxRetries?: number;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One logical subscription survives replacement of its underlying push stream. */
export class EventConnection {
  private streams = new Map<string, Item>();
  private closed = false;
  private opening = 0;
  private reconnecting?: Promise<ProtocolSession>;
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
    private options: PushOptions = {},
  ) {
    session.signal.addEventListener("abort", this.disconnected, { once: true });
    if (session.signal.aborted) this.disconnected();
  }
  private disconnected = () => {
    for (const item of [...this.streams.values()]) {
      if (item.sub.status !== "reconnecting")
        this.interrupted(item, {
          reason: "disconnected",
          error: "MCP connection ended",
        });
    }
  };
  private async availableSession() {
    if (this.closed) throw new Error("MCP connection closed");
    if (!this.session.signal.aborted) return this.session;
    if (!this.options.reconnect) throw new Error("MCP connection closed");
    if (!this.reconnecting) {
      this.reconnecting = this.options
        .reconnect()
        .then((session) => {
          if (this.closed) {
            session.close();
            throw new Error("MCP connection closed");
          }
          if (session.signal.aborted) {
            session.close();
            throw new Error("MCP connection is unavailable");
          }
          this.session.signal.removeEventListener("abort", this.disconnected);
          this.session = session;
          session.signal.addEventListener("abort", this.disconnected, {
            once: true,
          });
          return session;
        })
        .finally(() => {
          this.reconnecting = undefined;
        });
    }
    return this.reconnecting;
  }
  async catalog(signal?: AbortSignal) {
    const session = await this.availableSession();
    const events: z.infer<typeof catalogSchema>["events"] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = catalogSchema.parse(
        await session.request("events/list", cursor ? { cursor } : {}, signal),
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
    maxAgeMs?: number,
  ): Promise<Subscription> {
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.closed) throw new Error("MCP connection closed");
    if (
      maxAgeMs !== undefined &&
      (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)
    )
      throw new Error("max_age_ms must be a nonnegative integer");
    this.opening++;
    let entry;
    try {
      entry = (await this.catalog(signal)).find((e) => e.name === name);
    } finally {
      this.opening--;
    }
    if (!entry) throw new Error(`Unknown MCP event: ${name}`);
    if (!entry.delivery.includes("push"))
      throw new Error(
        "This event does not advertise draft push delivery; polling and webhooks are not supported",
      );
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.closed) throw new Error("MCP connection closed");
    const sub: Subscription = {
      id: "",
      server: this.server,
      name,
      arguments: structuredClone(args),
      cursor,
      status: "opening",
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    };
    let ready!: () => void, fail!: (e: Error) => void;
    const active = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    const item: Item = {
      sub,
      ready,
      fail,
      seen: new Set(),
      activated: false,
      attempts: 0,
      outage: false,
    };
    this.open(item);
    const cancelled = () => {
      void this.cancel(sub.id);
    };
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    try {
      await active;
      if (sub.status !== "active")
        throw new Error(
          sub.error ?? "Event stream ended before subscription completed",
        );
      return sub;
    } finally {
      signal?.removeEventListener("abort", cancelled);
    }
  }
  private open(item: Item) {
    const { sub } = item;
    const stream = this.session.openStream(
      "events/stream",
      {
        name: sub.name,
        arguments: sub.arguments,
        cursor: sub.cursor,
        ...(sub.maxAgeMs === undefined ? {} : { maxAgeMs: sub.maxAgeMs }),
      },
      (method, params) => {
        if (item.stream === stream && this.streams.get(sub.id) === item)
          this.consume(item, method, params);
      },
    );
    sub.id ||= stream.id;
    item.stream = stream;
    this.streams.set(sub.id, item);
    clearTimeout(item.timer);
    item.timer = setTimeout(
      () =>
        this.interrupted(item, {
          reason: "disconnected",
          error: "Event stream activation timed out",
        }),
      this.timeoutMs,
    );
    void stream.sent.catch((error) => {
      if (item.stream === stream)
        this.interrupted(item, { reason: "error", error: errorText(error) });
    });
    void stream.closed.then((end) => {
      if (item.stream === stream) this.interrupted(item, end);
    });
  }
  private heartbeat(item: Item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(
      () =>
        this.interrupted(item, {
          reason: "disconnected",
          error: "Event stream heartbeat timed out",
        }),
      this.options.heartbeatTimeoutMs ?? 65000,
    );
    item.timer.unref?.();
  }
  private consume(item: Item, method: string, p: Record<string, unknown>) {
    const { sub } = item;
    if (!record(p)) return;
    if (method === "notifications/events/active") {
      const alreadyActive = item.activated;
      sub.cursor = typeof p.cursor === "string" ? p.cursor : null;
      const wasTruncated = sub.truncated;
      const gap = p.truncated === true && sub.cursor !== null;
      sub.truncated = item.outage ? !!sub.truncated || gap : gap;
      sub.status = "active";
      sub.error = undefined;
      sub.endReason = undefined;
      item.activated = true;
      // A valid heartbeat/event resets retries, so repeated ack-then-drop cannot loop forever.
      this.heartbeat(item);
      if (gap && (!item.outage || !wasTruncated)) this.onGap(sub);
      item.ready();
      this.onStatus(sub, alreadyActive && sub.truncated && !item.outage);
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
      sub.cursor = typeof p.cursor === "string" ? p.cursor : null;
      item.attempts = 0;
      item.outage = false;
      this.heartbeat(item);
      if (item.seen.has(p.eventId)) {
        this.onStatus(sub, false);
        return;
      }
      item.seen.add(p.eventId);
      if (item.seen.size > 10000)
        item.seen.delete(item.seen.values().next().value!);
      sub.error = undefined;
      this.onEvent(sub, {
        eventId: p.eventId,
        name: p.name,
        timestamp: p.timestamp,
        cursor: sub.cursor,
        data: p.data,
      });
    } else if (
      method === "notifications/events/heartbeat" &&
      sub.status === "active"
    ) {
      sub.cursor = typeof p.cursor === "string" ? p.cursor : null;
      item.attempts = 0;
      const recovered = item.outage;
      item.outage = false;
      sub.error = undefined;
      this.heartbeat(item);
      this.onStatus(sub, recovered);
    } else if (method === "notifications/events/error") {
      const error =
        record(p.error) && typeof p.error.message === "string"
          ? p.error.message
          : "Upstream event error";
      if (sub.error !== error) {
        sub.error = error;
        this.onStatus(sub, sub.status === "active");
      }
    } else if (method === "notifications/events/terminated") {
      this.finish(item, {
        reason: "error",
        error:
          record(p.error) && typeof p.error.message === "string"
            ? p.error.message
            : "Event subscription terminated",
      });
    }
  }
  private interrupted(item: Item, end: ProtocolEnd) {
    if (this.streams.get(item.sub.id) !== item) return;
    const stream = item.stream;
    item.stream = undefined;
    clearTimeout(item.timer);
    void stream?.cancel();
    // Explicit RPC errors/termination and deliberate completion are terminal.
    if (
      !item.activated ||
      !this.options.reconnect ||
      end.reason === "ended" ||
      end.reason === "cancelled" ||
      end.protocolError ||
      this.closed
    ) {
      this.finish(item, end);
      return;
    }
    const wasRecovering = item.outage;
    item.outage = true;
    if (item.attempts >= (this.options.maxRetries ?? 5)) {
      this.finish(item, {
        reason: "error",
        error: `Reconnect attempts exhausted: ${end.error ?? "stream interrupted"}`,
      });
      return;
    }
    item.sub.status = "reconnecting";
    item.sub.error = end.error ?? "Event stream interrupted";
    item.sub.endReason = end.reason;
    if (!wasRecovering) this.onStatus(item.sub, true);
    const delay = Math.min(
      30000,
      (this.options.retryBaseMs ?? 1000) * 2 ** item.attempts++,
    );
    item.timer = setTimeout(() => {
      void (async () => {
        try {
          await this.availableSession();
          if (this.closed || this.streams.get(item.sub.id) !== item) return;
          this.open(item);
        } catch (error) {
          this.interrupted(item, { reason: "error", error: errorText(error) });
        }
      })();
    }, delay);
    item.timer.unref?.();
  }
  private finish(item: Item, end: ProtocolEnd) {
    if (this.streams.get(item.sub.id) !== item) return;
    this.streams.delete(item.sub.id);
    clearTimeout(item.timer);
    const stream = item.stream;
    item.stream = undefined;
    void stream?.cancel();
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
    this.onStatus(item.sub, item.activated && end.reason !== "cancelled");
  }
  async cancel(id: string, error?: string) {
    const item = this.streams.get(id);
    if (!item) return;
    const stream = item.stream;
    this.finish(
      item,
      error ? { reason: "error", error } : { reason: "cancelled" },
    );
    await stream?.cancel();
  }
  close(error?: string) {
    if (this.closed) return;
    this.closed = true;
    for (const item of [...this.streams.values()])
      this.finish(
        item,
        error ? { reason: "disconnected", error } : { reason: "cancelled" },
      );
    this.session.signal.removeEventListener("abort", this.disconnected);
    this.session.close();
    this.options.onClose?.();
  }
}
