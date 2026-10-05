import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventConnection } from "../dist/stream.js";
import { EVENTS_PROTOCOL } from "../dist/protocol.js";
import { adapter, McpServerManager } from "./protocol-fixture.mjs";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail("Condition not reached");
}

for (const protocolVersion of ["legacy", "2026-07-28"])
  test(`HTTP/SSE push: sibling isolation, cursor recovery, termination (${protocolVersion})`, async (t) => {
    const streams = [],
      cancelled = new Set(),
      events = [],
      statuses = [],
      sockets = new Set();
    const frame = (entry, method, params = {}) =>
      entry.res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/events/${method}`, params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": entry.request.id } } })}\n\n`,
      );
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const result = (value) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }),
          );
      if (request.method === "server/discover")
        return result({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        });
      if (request.method === "initialize")
        return result({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "push-fixture", version: "1" },
        });
      if (request.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (request.method === "tools/list")
        return result({
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          tools: [],
        });
      if (request.method === "events/list")
        return result({
          resultType: "complete",
          events: [
            {
              name: "test.changed",
              delivery: ["push"],
              inputSchema: { type: "object" },
            },
          ],
        });
      if (request.method === "events/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const entry = { request, res };
        streams.push(entry);
        res.on("close", () => cancelled.add(request.id));
        frame(entry, "active", { cursor: request.params.cursor ?? "baseline" });
        return;
      }
      res.writeHead(500).end("Unexpected method");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const manager = new McpServerManager();
    const owner = new AbortController();
    let conn;
    t.after(async () => {
      conn?.close();
      owner.abort();
      await manager.closeAll();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const connection = await manager.connect("http-events", {
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      auth: false,
      protocolVersion,
    });
    const session = adapter.createProtocolSession(
      connection,
      owner.signal,
      EVENTS_PROTOCOL,
    );
    conn = new EventConnection(
      "http-events",
      session,
      (sub, event) => events.push({ id: sub.id, event }),
      (sub) => statuses.push({ ...sub }),
      () => {},
      1000,
      { reconnect: async () => session, retryBaseMs: 5 },
    );
    const a = await conn.subscribe("test.changed", { scope: "a" });
    const b = await conn.subscribe("test.changed", { scope: "b" });
    frame(streams[0], "heartbeat", { cursor: "quiet-progress" });
    await until(() => a.cursor === "quiet-progress");
    streams[0].res.end();
    await until(() => streams.length === 3 && a.status === "active");
    assert.equal(streams[2].request.params.cursor, "quiet-progress");
    assert.equal(cancelled.has(b.id), false);
    assert.equal((await connection.client.listTools()).tools.length, 0);
    frame(streams[2], "event", {
      name: "test.changed",
      eventId: "one",
      timestamp: new Date().toISOString(),
      cursor: "after-one",
      data: { value: 1 },
    });
    await until(() => events.length === 1);
    assert.equal(events[0].id, a.id);
    frame(streams[2], "active", { cursor: "gap", truncated: true });
    await until(() => a.truncated);
    frame(streams[2], "terminated", {
      error: { code: -32012, message: "Permission revoked" },
    });
    await until(() => a.status === "failed");
    await until(() => cancelled.has(streams[2].request.id));
    await pause(20);
    assert.equal(streams.length, 3);
    assert.equal(b.status, "active");
    await conn.cancel(b.id);
    await until(() => cancelled.has(b.id));
    assert.equal(connection.activeProtocolOperations, 0);
    assert.equal((await connection.client.listTools()).tools.length, 0);
    assert.ok(statuses.some((sub) => sub.status === "reconnecting"));
  });
