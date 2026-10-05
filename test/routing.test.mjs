import test from "node:test";
import assert from "node:assert/strict";
import { EventConnection } from "../dist/stream.js";
import { EVENTS_PROTOCOL } from "../dist/protocol.js";
import { adapter } from "./protocol-fixture.mjs";
const tick = () => new Promise((r) => setTimeout(r, 0));
export function fixture(timeout = 100) {
  const sent = [],
    received = [],
    forwarded = [],
    statuses = [],
    controller = new AbortController();
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
  const connection = {
    status: "connected",
    definition: { command: "node" },
    client,
    transport,
    inFlight: 0,
    lastUsedAt: 0,
  };
  const session = adapter.createProtocolSession(
    connection,
    controller.signal,
    EVENTS_PROTOCOL,
  );
  const conn = new EventConnection(
    "test",
    session,
    (sub, event) => received.push({ id: sub.id, event }),
    (sub, unexpected) => statuses.push({ ...sub, unexpected }),
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
    session,
    connection,
    sent,
    received,
    forwarded,
    statuses,
    controller,
    notify,
    transport,
  };
}
test("mediated streams route notifications, ignore heartbeats, and deduplicate events", async () => {
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
  f.notify(a, "heartbeat", { cursor: "quiet" });
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
  assert.equal(f.statuses.at(-1).unexpected, false);
  f.controller.abort();
  assert.equal(f.statuses.at(-1).status, "failed");
  assert.equal(f.statuses.at(-1).unexpected, true);
  assert.equal(f.connection.activeProtocolOperations, 0);
  assert.equal(f.session.signal.aborted, true);
});
test("activation timeout cancels without claiming a subscription or issuing an extra wakeup", async () => {
  const f = fixture(5);
  await assert.rejects(f.conn.subscribe("comment.created", {}), /timed out/);
  assert.equal(f.sent.at(-1).method, "notifications/cancelled");
  assert.equal(f.statuses.at(-1).status, "failed");
  assert.equal(f.statuses.at(-1).unexpected, false);
  assert.equal(f.connection.activeProtocolOperations, 0);
  f.conn.close();
});
test("webhook-only events and unknown names fail before opening a stream", async () => {
  const f = fixture();
  await assert.rejects(f.conn.subscribe("remote", {}), /push delivery/);
  await assert.rejects(f.conn.subscribe("unknown", {}), /Unknown/);
  assert.equal(f.sent.length, 0);
  f.conn.close();
});
for (const [frame, status] of [
  [{ result: {} }, "ended"],
  [{ error: { code: -1, message: "permission revoked" } }, "failed"],
])
  test(`remote terminal frame reports ${status} and releases the operation`, async () => {
    const f = fixture();
    const opening = f.conn.subscribe("comment.created", {});
    await tick();
    const id = f.sent[0].id;
    f.notify(id, "active");
    await opening;
    f.transport.onmessage({ jsonrpc: "2.0", id, ...frame });
    await tick();
    assert.equal(f.statuses.at(-1).status, status);
    assert.equal(f.statuses.at(-1).unexpected, true);
    assert.equal(f.connection.activeProtocolOperations, 0);
    f.conn.close();
  });

test("cancelling a pending subscribe releases its stream promptly without a lifecycle wakeup", async () => {
  const f = fixture(10000),
    controller = new AbortController();
  const pending = f.conn.subscribe(
    "comment.created",
    {},
    null,
    controller.signal,
  );
  await tick();
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.equal(f.connection.activeProtocolOperations, 0);
  assert.equal(f.statuses.at(-1).unexpected, false);
  f.conn.close();
});
