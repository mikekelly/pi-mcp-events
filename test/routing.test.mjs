import test from "node:test";
import assert from "node:assert/strict";
import { EventConnection } from "../dist/stream.js";
import { EVENTS_PROTOCOL } from "../dist/protocol.js";
import { adapter } from "./protocol-fixture.mjs";
const tick = () => new Promise((r) => setTimeout(r, 0));
export function fixture(timeout = 100, options = {}) {
  const sent = [],
    received = [],
    forwarded = [],
    statuses = [],
    gaps = [],
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
    (sub) => gaps.push({ ...sub }),
    timeout,
    options,
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
    gaps,
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

async function activate(f) {
  const pending = f.conn.subscribe(
    "comment.created",
    {},
    "original",
    undefined,
    300000,
  );
  await tick();
  const id = f.sent.find((m) => m.method === "events/stream").id;
  f.notify(id, "active", { cursor: "baseline" });
  return await pending;
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out");
}
test("mid-stream gaps and null/absent cursors are visible without a new subscription", async () => {
  const f = fixture();
  const sub = await activate(f);
  f.notify(sub.id, "active", { cursor: "fresh", truncated: true });
  assert.equal(sub.cursor, "fresh");
  assert.equal(f.gaps.length, 1);
  assert.equal(f.statuses.at(-1).unexpected, true);
  f.notify(sub.id, "heartbeat", { cursor: null });
  assert.equal(sub.cursor, null);
  f.notify(sub.id, "active", { cursor: "again" });
  f.notify(sub.id, "heartbeat");
  assert.equal(sub.cursor, null);
  assert.equal(f.sent.filter((m) => m.method === "events/stream").length, 1);
  f.conn.close();
});
test("explicit termination stops delivery without waiting for a final response or retrying", async () => {
  const f = fixture(100, { reconnect: async () => f.session, retryBaseMs: 5 });
  const sub = await activate(f);
  f.notify(sub.id, "terminated", {
    error: { code: -32012, message: "Access revoked" },
  });
  assert.equal(sub.status, "failed");
  assert.equal(sub.error, "Access revoked");
  assert.equal(f.connection.activeProtocolOperations, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.sent.filter((m) => m.method === "events/stream").length, 1);
  f.conn.close();
});
test("heartbeat loss reopens with the latest cursor, stable identity and dedup across streams", async () => {
  const f = fixture(100, {
    reconnect: async () => f.session,
    heartbeatTimeoutMs: 20,
    retryBaseMs: 5,
  });
  const sub = await activate(f);
  const event = {
    eventId: "same",
    name: "comment.created",
    timestamp: "now",
    cursor: "latest",
    data: {},
  };
  f.notify(sub.id, "event", event);
  await until(
    () => f.sent.filter((m) => m.method === "events/stream").length === 2,
  );
  const reopened = f.sent.filter((m) => m.method === "events/stream")[1];
  assert.notEqual(reopened.id, sub.id);
  assert.equal(reopened.params.cursor, "latest");
  assert.equal(reopened.params.maxAgeMs, 300000);
  f.notify(reopened.id, "active", { cursor: "latest" });
  f.notify(reopened.id, "event", { ...event, cursor: "after-duplicate" });
  assert.equal(sub.cursor, "after-duplicate");
  assert.equal(f.received.length, 1);
  f.notify(reopened.id, "event", { ...event, eventId: "new" });
  assert.equal(f.received.at(-1).id, sub.id);
  await f.conn.cancel(sub.id);
  assert.equal(f.connection.activeProtocolOperations, 0);
  f.conn.close();
});
test("transport recovery reacquires a session and unsubscribe cancels pending recovery", async () => {
  const replacement = fixture();
  let reconnects = 0;
  const f = fixture(100, {
    reconnect: async () => {
      reconnects++;
      return replacement.session;
    },
    retryBaseMs: 5,
  });
  const sub = await activate(f);
  f.controller.abort();
  await until(() => replacement.sent.some((m) => m.method === "events/stream"));
  const reopened = replacement.sent.find((m) => m.method === "events/stream");
  replacement.notify(reopened.id, "active", { cursor: "baseline" });
  assert.equal(sub.status, "active");
  assert.equal(reconnects, 1);
  replacement.controller.abort();
  await f.conn.cancel(sub.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reconnects, 1);
  assert.equal(sub.status, "stopped");
  f.conn.close();
  replacement.conn.close();
});
test("retry exhaustion stops an unresponsive stream and shutdown clears timers", async () => {
  const f = fixture(10, {
    reconnect: async () => f.session,
    heartbeatTimeoutMs: 10,
    retryBaseMs: 1,
    maxRetries: 2,
  });
  const sub = await activate(f);
  await until(() => sub.status === "failed");
  assert.match(sub.error, /exhausted/);
  assert.equal(f.sent.filter((m) => m.method === "events/stream").length, 3);
  assert.equal(f.connection.activeProtocolOperations, 0);
  f.conn.close();
});

test("parallel subscriptions share reconnection and shutdown rejects late sessions", async () => {
  const replacement = fixture();
  let finishConnect,
    calls = 0;
  const f = fixture(100, {
    retryBaseMs: 1,
    reconnect: () => {
      calls++;
      return new Promise((resolve) => {
        finishConnect = resolve;
      });
    },
  });
  await activate(f);
  const other = f.conn.subscribe("comment.edited", {});
  await tick();
  const id = f.sent.filter((m) => m.method === "events/stream").at(-1).id;
  f.notify(id, "active");
  await other;
  f.controller.abort();
  await until(() => calls === 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  f.conn.close();
  finishConnect(replacement.session);
  await tick();
  assert.equal(replacement.session.signal.aborted, true);
  assert.equal(
    replacement.sent.filter((m) => m.method === "events/stream").length,
    0,
  );
  replacement.conn.close();
});

test("acknowledgement/replay-gap flapping does not generate a wakeup per retry", async () => {
  const f = fixture(100, {
    reconnect: async () => f.session,
    heartbeatTimeoutMs: 10,
    retryBaseMs: 1,
    maxRetries: 2,
  });
  const sub = await activate(f);
  for (let count = 2; count <= 3; count++) {
    await until(
      () => f.sent.filter((m) => m.method === "events/stream").length === count,
    );
    const id = f.sent.filter((m) => m.method === "events/stream").at(-1).id;
    f.notify(id, "active", { cursor: `fresh-${count}`, truncated: true });
  }
  await until(() => sub.status === "failed");
  assert.deepEqual(
    f.statuses.filter((s) => s.unexpected).map((s) => s.status),
    ["reconnecting", "failed"],
  );
  assert.equal(f.statuses.at(-1).truncated, true);
  assert.equal(f.gaps.length, 1);
  f.conn.close();
});
