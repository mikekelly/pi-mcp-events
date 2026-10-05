import { randomUUID } from "node:crypto";
import type { Client, Transport } from "@modelcontextprotocol/client";
import * as z from "zod/v4";

export interface Lease {
  client: Client;
  transport: Transport;
  transportKind: "stdio" | "http" | "socket";
  signal: AbortSignal;
  release(): void;
}
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
  status: "opening" | "active" | "stopped" | "failed";
  error?: string;
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

/** Draft Events demultiplexer on the adapter's existing transport. Other traffic is untouched. */
export class EventConnection {
  private streams = new Map<
    string,
    {
      sub: Subscription;
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
  private previousMessage: Transport["onmessage"];
  private handler: NonNullable<Transport["onmessage"]>;
  constructor(
    readonly server: string,
    private lease: Lease,
    private onEvent: (sub: Subscription, event: EventData) => void,
    private onStatus: (sub: Subscription) => void = () => {},
    private onGap: (sub: Subscription) => void = () => {},
    private timeoutMs = 15000,
  ) {
    this.previousMessage = lease.transport.onmessage;
    this.handler = (message, extra) => {
      if (!this.consume(message)) this.previousMessage?.(message, extra);
    };
    lease.transport.onmessage = this.handler;
    lease.signal.addEventListener("abort", this.disconnected, { once: true });
    if (lease.signal.aborted) this.disconnected();
  }
  private disconnected = () =>
    this.close("MCP connection ended; subscribe again to resume.");
  async catalog() {
    const events: z.infer<typeof catalogSchema>["events"] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.lease.client.request(
        { method: "events/list", params: cursor ? { cursor } : {} },
        catalogSchema,
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
  private meta() {
    return this.lease.client.getProtocolEra() === "modern"
      ? {
          _meta: {
            "io.modelcontextprotocol/protocolVersion":
              this.lease.client.getNegotiatedProtocolVersion(),
            "io.modelcontextprotocol/clientInfo": {
              name: "pi-mcp-events",
              version: "0.1.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : {};
  }
  async subscribe(
    name: string,
    args: Record<string, unknown>,
    cursor: string | null = null,
  ): Promise<Subscription> {
    if (this.closed) throw new Error("MCP connection closed");
    this.opening++;
    let entry;
    try {
      entry = (await this.catalog()).find((e) => e.name === name);
    } finally {
      this.opening--;
    }
    if (!entry) throw new Error(`Unknown MCP event: ${name}`);
    if (!entry.delivery.includes("push"))
      throw new Error("This event does not advertise draft push delivery");
    if (this.closed) throw new Error("MCP connection closed");
    const sub: Subscription = {
      id: `pi-mcp-events-${randomUUID()}`,
      server: this.server,
      name,
      arguments: args,
      cursor,
      status: "opening",
    };
    const active = new Promise<void>((ready, fail) => {
      const timer = setTimeout(() => {
        void this.cancel(sub.id, "Event stream activation timed out");
      }, this.timeoutMs);
      this.streams.set(sub.id, { sub, ready, fail, timer, seen: new Set() });
    });
    // Attach rejection handling before send: a synchronous server error can arrive during send.
    const sent = this.lease.transport.send({
      jsonrpc: "2.0",
      id: sub.id,
      method: "events/stream",
      params: { name, arguments: args, cursor, ...this.meta() },
    });
    try {
      await Promise.all([sent, active]);
      return sub;
    } catch (error) {
      await this.cancel(
        sub.id,
        error instanceof Error ? error.message : "Subscription failed",
      );
      throw error;
    }
  }
  private consume(message: unknown): boolean {
    if (!record(message)) return false;
    const id =
      typeof message.id === "string"
        ? message.id
        : record(message.params) && record(message.params._meta)
          ? message.params._meta["io.modelcontextprotocol/subscriptionId"]
          : undefined;
    if (typeof id !== "string" || !id.startsWith("pi-mcp-events-"))
      return false;
    const item = this.streams.get(id);
    // Consume late frames from our cancelled requests rather than raising an SDK unknown-id error.
    if (!item) return true;
    const { sub } = item;
    if ("error" in message || "result" in message) {
      this.finish(
        id,
        record(message.error) && typeof message.error.message === "string"
          ? message.error.message
          : "Event stream ended",
      );
      return true;
    }
    const p = message.params;
    if (!record(p)) return true;
    if (message.method === "notifications/events/active") {
      clearTimeout(item.timer);
      sub.status = "active";
      if (typeof p.cursor === "string") sub.cursor = p.cursor;
      if (p.truncated) this.onGap(sub);
      item.ready();
      this.onStatus(sub);
    } else if (message.method === "notifications/events/event") {
      if (
        sub.status !== "active" ||
        typeof p.eventId !== "string" ||
        p.name !== sub.name ||
        typeof p.timestamp !== "string" ||
        !("data" in p)
      )
        return true;
      if (
        p.eventId.length > 1024 ||
        p.name.length > 256 ||
        p.timestamp.length > 80
      )
        return true;
      if (item.seen.has(p.eventId)) return true;
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
    } else if (message.method === "notifications/events/error") {
      sub.error =
        record(p.error) && typeof p.error.message === "string"
          ? p.error.message
          : "Upstream event error";
      this.onStatus(sub);
    }
    return true;
  }
  private finish(id: string, error?: string) {
    const item = this.streams.get(id);
    if (!item) return;
    this.streams.delete(id);
    clearTimeout(item.timer);
    item.sub.status = error ? "failed" : "stopped";
    item.sub.error = error;
    item.fail(new Error(error ?? "Subscription cancelled"));
    this.onStatus(item.sub);
  }
  async cancel(id: string, error?: string) {
    if (!this.streams.has(id)) return;
    this.finish(id, error);
    if (!this.closed)
      await this.lease.client
        .notification({
          method: "notifications/cancelled",
          params: { requestId: id },
        })
        .catch(() => {});
  }
  close(error?: string) {
    if (this.closed) return;
    // Send cancellations before releasing the lease; the adapter keeps owning the process.
    for (const id of [...this.streams.keys()]) void this.cancel(id, error);
    this.closed = true;
    this.lease.signal.removeEventListener("abort", this.disconnected);
    if (this.lease.transport.onmessage === this.handler)
      this.lease.transport.onmessage = this.previousMessage;
    this.lease.release();
  }
}
