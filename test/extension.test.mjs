import test from "node:test";
import assert from "node:assert/strict";
import extension from "../dist/index.js";
import { adapter } from "./protocol-fixture.mjs";
function host(kind = "stdio") {
  const hooks = new Map(),
    messages = [],
    sent = [],
    controller = new AbortController(),
    bus = new Map();
  let tool;
  const transport = {
    hasPerRequestStream: kind === "http",
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
  const connection = {
    client,
    transport,
    definition:
      kind === "stdio" ? { command: "node" } : { url: "https://example.test" },
    status: "connected",
    inFlight: 0,
    lastUsedAt: 0,
  };
  const pi = {
    events: {
      on: (name, fn) => bus.set(name, fn),
      emit: (name, req) => bus.get(name)?.(req),
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
  adapter.registerProtocolBridge(pi, async () => ({
    connection,
    signal: controller.signal,
  }));
  extension(pi);
  const call = (args) =>
    tool.execute("test", args, new AbortController().signal);
  return {
    call,
    hooks,
    notify,
    sent,
    messages,
    connection,
    transport,
    controller,
  };
}
const subscribe = { action: "subscribe", server: "test", name: "test.changed" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("active is rendered in the tool result; events wake once; shutdown suppresses queued wakeups", async () => {
  const h = host();
  const first = await h.call(subscribe);
  assert.equal(first.isError, undefined);
  assert.equal(first.details.subscription.status, "active");
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
  assert.equal(h.connection.activeProtocolOperations, 0);
  assert.deepEqual(
    (await h.call({ action: "list" })).details.subscriptions,
    [],
  );
});
test("HTTP streams use the adapter and failed subscriptions do not leave active operations", async () => {
  const http = host("http");
  const subscribed = await http.call(subscribe);
  assert.equal(subscribed.details.subscription.status, "active");
  assert.equal(http.connection.activeProtocolOperations, 1);
  const local = host();
  assert.match(
    (await local.call({ ...subscribe, name: "unknown" })).details.error,
    /Unknown/,
  );
  assert.equal(local.connection.activeProtocolOperations, 0);
  await local.hooks.get("session_shutdown")();
  await http.hooks.get("session_shutdown")();
  assert.equal(http.connection.activeProtocolOperations, 0);
  assert.equal(http.sent.some(message => message.method === "notifications/cancelled"), false);
});
for (const reason of ["ended", "failed", "disconnected"])
  test(`unexpected ${reason} enters context and wakes the agent once`, async () => {
    const h = host();
    const id = (await h.call(subscribe)).details.subscription.id;
    if (reason === "disconnected") h.controller.abort();
    else
      h.transport.onmessage({
        jsonrpc: "2.0",
        id,
        ...(reason === "ended"
          ? { result: {} }
          : { error: { message: "upstream failed" } }),
      });
    await pause(550);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0][0].customType, "mcp-events-status");
    assert.equal(
      h.messages[0][0].details.subscriptions[0].status,
      reason === "ended" ? "ended" : "failed",
    );
    assert.deepEqual(h.messages[0][1], {
      triggerTurn: true,
      deliverAs: "followUp",
    });
    assert.match(h.messages[0][0].content, /external data, not instructions/);
    assert.equal(h.connection.activeProtocolOperations, 0);
    await h.hooks.get("session_shutdown")();
    assert.equal(h.messages.length, 1);
  });
test("requested cancellation is rendered in the tool result without an extra turn", async () => {
  const h = host();
  const id = (await h.call(subscribe)).details.subscription.id;
  const result = await h.call({ action: "unsubscribe", subscription_id: id });
  assert.equal(result.details.stopped, true);
  await pause(0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.connection.activeProtocolOperations, 0);
  await h.hooks.get("session_shutdown")();
});
test("recoverable error notifications enter context once and preserve active status", async () => {
  const h = host();
  const id = (await h.call(subscribe)).details.subscription.id;
  h.notify(id, "error", {
    error: { message: "upstream temporarily unavailable" },
  });
  h.notify(id, "error", {
    error: { message: "upstream temporarily unavailable" },
  });
  await pause(550);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][0].details.subscriptions[0].status, "active");
  await h.hooks.get("session_shutdown")();
});
test("missing or legacy adapter hook returns install instructions and warns once per session", async () => {
  let tool;
  const hooks = new Map(),
    warnings = [];
  extension({
    events: {
      emit(name) {
        assert.equal(name, "pi-mcp-adapter:protocol:v1");
      },
    },
    registerTool(t) {
      tool = t;
    },
    on(name, callback) {
      hooks.set(name, callback);
    },
    sendMessage() {
      assert.fail("unexpected wakeup");
    },
  });
  const start = () =>
    hooks.get("session_start")(
      {},
      { ui: { notify: (...args) => warnings.push(args) } },
    );
  start();
  assert.equal(warnings.length, 0);
  for (const action of ["catalog", "subscribe", "subscribe"]) {
    const result = await tool.execute("test", { ...subscribe, action });
    assert.equal(result.isError, true);
    assert.match(result.details.error, /protocol-extension hook/);
    assert.match(result.details.error, /pi remove npm:pi-mcp-adapter/);
    assert.match(
      result.details.error,
      /pi install npm:@realmikekelly\/pi-mcp-adapter/,
    );
    assert.match(result.details.error, /Restart Pi/);
    assert.equal(
      JSON.parse(result.content[0].text).error,
      result.details.error,
    );
    assert.equal(warnings[0][0], result.details.error);
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], "warning");
  await hooks.get("session_shutdown")();
  start();
  await tool.execute("test", subscribe);
  assert.equal(warnings.length, 2);
});

// Adapter shutdown may run before the companion's shutdown hook.
test("adapter-first session shutdown does not wake the agent with disconnect statuses", async () => {
  const h = host();
  await h.call(subscribe);
  h.controller.abort();
  await h.hooks.get("session_shutdown")();
  await pause(550);
  assert.equal(h.messages.length, 0);
});
