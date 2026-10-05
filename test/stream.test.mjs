import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { EventConnection } from "../dist/stream.js";
import { EventBatcher } from "../dist/batch.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await pause(20);
  }
  assert.fail("Timed out");
}
for (const modern of [false, true])
  test(`published Figma listen: native streams share tools; cancellation and isolation (${modern ? "2026" : "2025"})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-events-test-"));
    const state = join(dir, "state.json");
    await writeFile(state, JSON.stringify({ comments: [] }));
    const client = new Client(
      { name: "events-test", version: "1" },
      modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("./figma-fixture.mjs", import.meta.url).pathname],
      env: { FIGMA_FIXTURE_STATE: state },
      stderr: "pipe",
    });
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    const controller = new AbortController();
    let released = 0;
    const events = [];
    const statuses = [];
    const conn = new EventConnection(
      "figma",
      {
        client,
        transport,
        signal: controller.signal,
        release() {
          released++;
        },
      },
      (sub, e) => events.push({ sub, e }),
      (s) => statuses.push({ ...s }),
    );
    t.after(async () => {
      conn.close();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    });
    assert.equal((await conn.catalog()).length, 9);
    assert.equal((await client.listTools()).tools.length, 5);
    const sub = await conn.subscribe("figma.comment.created", {
      scope: { kind: "file", file_key: "fileA" },
      tag: "#bot",
    });
    assert.equal(sub.status, "active");
    await pause(200);
    await writeFile(
      state,
      JSON.stringify({
        comments: [
          {
            id: "new",
            message: "hello #bot",
            created_at: new Date().toISOString(),
            user: { id: "u", handle: "test" },
            reactions: [],
          },
        ],
      }),
    );
    await until(() => events.length === 1);
    assert.equal(events[0].e.data.text, "hello #bot");
    assert.equal(events[0].sub.id, sub.id);
    const status = await client.callTool({
      name: "listen_status",
      arguments: {},
    });
    assert.equal(status.structuredContent.active_subscriptions, 1);
    await conn.cancel(sub.id);
    await pause(100);
    assert.equal(
      (await client.callTool({ name: "listen_status", arguments: {} }))
        .structuredContent.active_subscriptions,
      0,
    );
    assert.equal(statuses.at(-1).status, "stopped");
    conn.close();
    assert.equal(released, 1);
    assert.equal(
      (await client.listTools()).tools.length,
      5,
      "Closing events must not close adapter tools",
    );
  });
test("batching reports overflow and cleanup suppresses queued wakeups", async () => {
  const batches = [];
  const b = new EventBatcher(
    (items, dropped) => batches.push({ items, dropped }),
    10,
    2,
  );
  b.add(1);
  b.add(2);
  b.add(3);
  await pause(30);
  assert.deepEqual(batches, [{ items: [1, 2], dropped: 1 }]);
  b.add(4);
  b.clear();
  await pause(30);
  assert.equal(batches.length, 1);
});
