import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
const root = resolve(import.meta.dirname, "..");
const releaseRoot = process.env.PI_EVENTS_RELEASE_ROOT;
const adapterEntry = releaseRoot
  ? pathToFileURL(join(releaseRoot, "@realmikekelly/pi-mcp-adapter/index.ts")).href
  : import.meta.resolve("@realmikekelly/pi-mcp-adapter");
const eventsEntry = releaseRoot
  ? join(releaseRoot, "@realmikekelly/pi-mcp-events/dist/index.js")
  : join(root, "dist/index.js");
const dir = await mkdtemp(join(tmpdir(), "pi-events-idle-"));
const live = !!process.env.FIGMA_LIVE_FILE;
const state = join(dir, "snapshots.json");
await writeFile(state, JSON.stringify({ comments: [] }));
const config = {
  mcpServers: {
    figma: {
      command: process.execPath,
      args: live
        ? [join(root, "node_modules/@realmikekelly/figma-listen/dist/cli.js")]
        : [join(root, "test/figma-fixture.mjs")],
      env: live
        ? { FIGMA_ACCESS_TOKEN: "${FIGMA_ACCESS_TOKEN}" }
        : { FIGMA_FIXTURE_STATE: state },
      protocolVersion: "legacy",
    },
  },
  settings: {
    trace: { enabled: true, file: join(dir, "wire.jsonl") },
    idleTimeout: 1,
  },
};
await writeFile(
  join(dir, "adapter.ts"),
  `import {createMcpAdapter} from ${JSON.stringify(adapterEntry)}; export default createMcpAdapter(${JSON.stringify({ config })});`,
);
const settingsManager = SettingsManager.inMemory({
  defaultTools: ["mcp_events", "mcp"],
  retry: { enabled: false },
});
const loader = new DefaultResourceLoader({
  cwd: dir,
  agentDir: dir,
  settingsManager,
  additionalExtensionPaths: [
    join(dir, "adapter.ts"),
    eventsEntry,
  ],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const errors = loader.getExtensions().errors;
assert.deepEqual(errors, [], JSON.stringify(errors));
const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert.ok(model);
const { session } = await createAgentSession({
  cwd: dir,
  agentDir: dir,
  resourceLoader: loader,
  settingsManager,
  sessionManager: SessionManager.inMemory(),
  modelRuntime: runtime,
  model,
  thinkingLevel: "low",
});
let starts = 0;
const log = [];
session.subscribe((e) => {
  if (
    [
      "agent_start",
      "agent_end",
      "agent_settled",
      "tool_execution_end",
      "extension_error",
    ].includes(e.type)
  ) {
    log.push({ time: new Date().toISOString(), ...e });
    if (e.type === "agent_start") starts++;
    console.log(e.type, e.type === "tool_execution_end" ? e.toolName : "");
  }
});
try {
  await session.bindExtensions({});
  console.log("TOOLS", session.getActiveToolNames());
  await session.prompt(
    live
      ? `Use mcp_events to subscribe to figma.design.changed on server figma with arguments ${JSON.stringify({ scope: { kind: "frame", file_key: process.env.FIGMA_LIVE_FILE, node_id: process.env.FIGMA_LIVE_FRAME } })}. Once active, reply SUBSCRIBED and end your turn. Do not poll or wait. When an MCP event arrives later, reply briefly identifying the changed node name and property.`
      : 'Use mcp_events to subscribe to figma.comment.created on server figma with arguments {"scope":{"kind":"file","file_key":"fileA"},"tag":"#bot"}. Once the subscription is active, reply SUBSCRIBED and end your turn. Do not poll or wait. When an MCP event arrives later, reply with its comment text only.',
  );
  assert.match(session.getLastAssistantText(), /SUBSCRIBED/);
  assert.equal(session.isStreaming, false);
  const initialStarts = starts;
  console.log("IDLE_CONFIRMED", dir);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(starts, initialStarts);
  const marker = `PI-WAKE-${randomUUID()}`;
  const sent = Date.now();
  if (!live)
    await writeFile(
      state,
      JSON.stringify({
        comments: [
          {
            id: marker,
            message: `${marker} #bot`,
            created_at: new Date().toISOString(),
            user: { id: "synthetic", handle: "Fixture" },
            reactions: [],
          },
        ],
      }),
    );
  for (let i = 0; i < (live ? 3000 : 900); i++) {
    if (
      starts > initialStarts &&
      !session.isStreaming &&
      session.getLastAssistantText()?.includes(live ? "PI-LIVE-" : marker)
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(starts > initialStarts, "No event-triggered agent turn");
  assert.match(
    session.getLastAssistantText(),
    new RegExp(live ? "PI-LIVE-" : marker),
  );
  const wire = await readFile(join(dir, "wire.jsonl"), "utf8");
  assert.ok(wire.includes("events/stream"));
  assert.ok(wire.includes("notifications/events/event"));
  assert.ok(!wire.includes("listen_get_events"));
  const result = {
    passed: true,
    pi: "1.0.3",
    adapter: "@realmikekelly/pi-mcp-adapter@5.0.1",
    figma_listen: "1.3.1",
    upstream: live ? "live Figma REST" : "synthetic snapshot",
    native_subscription: true,
    idle_before_event: true,
    additional_prompts: 0,
    initialStarts,
    finalStarts: starts,
    marker: live ? "PI-LIVE-" : marker,
    elapsed_after_idle_ms: Date.now() - sent,
    response: session.getLastAssistantText(),
    evidence: dir,
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await writeFile(join(dir, "events.json"), JSON.stringify(log, null, 2));
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  console.log("EVIDENCE", dir);
}
