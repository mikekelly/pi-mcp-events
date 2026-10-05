import test from "node:test";
import assert from "node:assert/strict";
import extension from "../dist/index.js";

function host(kind = "stdio") {
  const hooks = new Map(),
    messages = [],
    sent = [],
    controller = new AbortController();
  let tool,
    releases = 0;
  const transport = {
    async send(message) {
      sent.push(message);
      if (message.method === "events/stream") notify(message.id, "active");
    },
  };
  const notify = (id, type, data = {}) =>
    transport.onmessage?.({
      jsonrpc: "2.0",
      method: `notifications/events/${type}`,
      params: {
        ...data,
        _meta: { "io.modelcontextprotocol/subscriptionId": id },
      },
    });
  const client = {
    getProtocolEra: () => "legacy",
    request: async () => ({
      events: [{ name: "test.changed", delivery: ["push"] }],
    }),
    notification: (message) => transport.send(message),
  };
  const lease = {
    client,
    transport,
    transportKind: kind,
    signal: controller.signal,
    release() {
      if (!controller.signal.aborted) {
        releases++;
        controller.abort();
      }
    },
  };
  const pi = {
    events: {
      emit(_name, request) {
        request.result = Promise.resolve(lease);
      },
    },
    registerTool(t) {
      tool = t;
    },
    on(name, callback) {
      hooks.set(name, callback);
    },
    sendMessage(...args) {
      messages.push(args);
    },
  };
  extension(pi);
  const call = (args) =>
    tool.execute("test", args, new AbortController().signal);
  return { call, hooks, notify, sent, messages, releases: () => releases };
}
const subscribe = { action: "subscribe", server: "test", name: "test.changed" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("events trigger follow-up turns; shutdown suppresses queued wakeups and releases shared connection", async () => {
  const h = host();
  const first = await h.call(subscribe);
  assert.equal(first.isError, undefined);
  const id = first.details.subscription.id;
  assert.equal((await h.call(subscribe)).details.subscription.id, id);
  assert.equal(h.sent.filter((m) => m.method === "events/stream").length, 1);
  h.notify(id, "heartbeat");
  assert.equal(h.messages.length, 0);
  h.notify(id, "event", {
    eventId: "one",
    name: "test.changed",
    timestamp: "now",
    data: { text: "hello" },
  });
  await pause(550);
  assert.deepEqual(h.messages[0][1], {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.equal(h.messages[0][0].details.events[0].event.data.text, "hello");
  h.notify(id, "event", {
    eventId: "two",
    name: "test.changed",
    timestamp: "now",
    data: { text: "bye" },
  });
  await h.hooks.get("session_shutdown")();
  await pause(550);
  assert.equal(h.messages.length, 1);
  assert.equal(h.releases(), 1);
  assert.deepEqual(
    (await h.call({ action: "list" })).details.subscriptions,
    [],
  );
});

test("unsupported transport and failed subscription release the lease", async () => {
  const http = host("http");
  assert.match((await http.call(subscribe)).details.error, /stdio/);
  assert.equal(http.releases(), 1);
  const local = host();
  assert.match(
    (await local.call({ ...subscribe, name: "unknown" })).details.error,
    /Unknown/,
  );
  assert.equal(local.releases(), 1);
});

test("unpatched adapter fails clearly without starting another server", async () => {
  let tool;
  extension({
    events: { emit() {} },
    registerTool(t) {
      tool = t;
    },
    on() {},
    sendMessage() {
      assert.fail("unexpected wakeup");
    },
  });
  const result = await tool.execute("test", subscribe);
  assert.equal(result.isError, true);
  assert.match(result.details.error, /connection-lease hook/);
});
