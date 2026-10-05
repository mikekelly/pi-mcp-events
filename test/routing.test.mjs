import test from "node:test";
import assert from "node:assert/strict";
import { EventConnection } from "../dist/stream.js";
const tick = () => new Promise((r) => setTimeout(r, 0));
function fixture(timeout = 30) {
  const sent = [],
    received = [],
    forwarded = [],
    statuses = [],
    controller = new AbortController();
  let released = 0;
  const transport = {
    onmessage: (m) => forwarded.push(m),
    async send(m) {
      sent.push(m);
    },
  };
  const client = {
    getProtocolEra: () => "legacy",
    request: async () => ({
      events: [
        { name: "comment.created", delivery: ["push"] },
        { name: "comment.edited", delivery: ["push"] },
        { name: "remote", delivery: ["webhook"] },
      ],
    }),
    async notification(m) {
      sent.push(m);
    },
  };
  const conn = new EventConnection(
    "test",
    {
      client,
      transport,
      signal: controller.signal,
      release() {
        released++;
      },
    },
    (sub, event) => received.push({ id: sub.id, event }),
    (sub) => statuses.push({ ...sub }),
    () => {},
    timeout,
  );
  const notify = (id, kind, data = {}) =>
    transport.onmessage({
      jsonrpc: "2.0",
      method: `notifications/events/${kind}`,
      params: {
        ...data,
        _meta: { "io.modelcontextprotocol/subscriptionId": id },
      },
    });
  return {
    conn,
    sent,
    received,
    forwarded,
    statuses,
    controller,
    notify,
    transport,
    released: () => released,
  };
}
test("routes by stream ID, ignores heartbeats and wrong types, deduplicates and strips transport metadata", async () => {
  const f = fixture();
  const first = f.conn.subscribe("comment.created", {});
  await tick();
  const a = f.sent[0].id;
  f.notify(a, "active", { cursor: "baseline" });
  await first;
  const second = f.conn.subscribe("comment.edited", {});
  await tick();
  const b = f.sent[1].id;
  f.notify(b, "active");
  await second;
  f.notify(a, "heartbeat");
  f.notify(a, "event", {
    eventId: "x",
    name: "comment.edited",
    timestamp: "now",
    data: {},
  });
  const e = {
    eventId: "x",
    name: "comment.created",
    timestamp: "now",
    cursor: "next",
    data: { text: "test" },
    extra: "omit",
  };
  f.notify(a, "event", e);
  f.notify(a, "event", e);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].id, a);
  assert.equal(f.received[0].event.extra, undefined);
  assert.equal(f.received[0].event._meta, undefined);
  f.transport.onmessage({ jsonrpc: "2.0", id: 9, result: { tools: [] } });
  assert.equal(f.forwarded.length, 1);
  await f.conn.cancel(a);
  f.notify(a, "event", { ...e, eventId: "late" });
  assert.equal(f.received.length, 1);
  assert.equal(f.statuses.at(-1).status, "stopped");
  f.controller.abort();
  assert.equal(f.statuses.at(-1).status, "failed");
  assert.equal(f.released(), 1);
  f.conn.close();
  assert.equal(f.released(), 1);
});
test("activation timeout cancels request rather than claiming a subscription", async () => {
  const f = fixture(5);
  await assert.rejects(f.conn.subscribe("comment.created", {}), /timed out/);
  assert.equal(f.sent.at(-1).method, "notifications/cancelled");
  assert.equal(f.statuses.at(-1).status, "failed");
  f.conn.close();
});
test("webhook-only events and unknown names fail before opening a stream", async () => {
  const f = fixture();
  await assert.rejects(f.conn.subscribe("remote", {}), /push delivery/);
  await assert.rejects(f.conn.subscribe("unknown", {}), /Unknown/);
  assert.equal(f.sent.length, 0);
  f.conn.close();
});
