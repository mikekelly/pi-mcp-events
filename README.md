# Pi MCP Events

An event-stream companion to [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Your agent subscribes to an MCP event, finishes its turn, and wakes when the event arrives. A server can expose both ordinary tools and events through the same connection.

The adapter owns server configuration, authentication, connections, tool discovery and its management UI. This companion adds the `mcp_events` tool and visible event messages that can wake an idle Pi session.

## Install

Requires Node 22.19+ and Pi 1.0.3+. For now, use [Mike Kelly's adapter fork](https://github.com/mikekelly/pi-mcp-adapter), which includes the connection hook needed by this package. Unmodified upstream pi-mcp-adapter 5.0.0 does not expose that hook.

```sh
# Skip removal if the upstream adapter is not installed.
pi remove npm:pi-mcp-adapter
pi install npm:@realmikekelly/pi-mcp-adapter
pi install npm:@realmikekelly/pi-mcp-events
```

Use the full `npm:@realmikekelly/pi-mcp-events` source: `npm:` tells Pi to install from npm, and `@realmikekelly/` is part of the published package name. A bare `pi install pi-mcp-events` is treated as a local path.

Restart Pi. Keep only one adapter enabled; if you installed the upstream adapter from Git or a local path, remove that registration instead. **Your existing MCP server configuration stays the same.** Once upstream includes the hook, you can switch back to the official adapter and keep this companion.

Both packages must be installed as Pi extensions. The companion deliberately does not install another adapter as an npm dependency. It reuses the active adapter's connection, so a server can offer tools and events in the same process. The adapter's management UI and tool rendering remain available; this version does not add a dedicated subscriptions panel.

If the adapter is missing, disabled, or lacks the required hook, the first `mcp_events` catalog or subscribe request returns an error with the replacement install command and restart instructions. Pi also shows those instructions as a warning once per session. Compatibility is checked when you use the tool, not at startup. Pi stays running, and the extension does not install packages or launch a separate MCP server to work around the missing hook.

## Try it with Figma listen

[Figma listen](https://github.com/mikekelly/figma-listen) is a companion to the official Figma MCP. The official MCP lets an agent work on designs; Figma listen observes feedback and edits. Generate a Figma personal access token with read scopes and export `FIGMA_ACCESS_TOKEN` in the environment used to launch Pi. See Figma listen's README for token setup.

Add this server to your existing adapter config, such as `~/.config/mcp/mcp.json` or your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "figma-listen": {
      "command": "npx",
      "args": ["-y", "@realmikekelly/figma-listen@1.3.1"],
      "env": { "FIGMA_ACCESS_TOKEN": "${FIGMA_ACCESS_TOKEN}" }
    }
  }
}
```

Ask Pi:

> Use mcp_events to discover events on figma-listen, subscribe to new comments tagged #bot in this Figma file, then finish your turn. When feedback arrives, tell me what changed.

The tool calls are:

```json
{ "action": "catalog", "server": "figma-listen" }
```

```json
{
  "action": "subscribe",
  "server": "figma-listen",
  "name": "figma.comment.created",
  "arguments": {
    "scope": { "kind": "file", "file_key": "YOUR_FILE_KEY" },
    "tag": "#bot"
  }
}
```

For edits, subscribe separately to `figma.design.changed`. Figma listen supports file, page, section and frame scopes; use the event catalog's input schema for exact arguments. Design events arrive after the default 120-second quiet period. Comments arrive when polling detects them, subject to Figma's rate limits.

`mcp_events` exposes `catalog`, `subscribe`, `list` and `unsubscribe`. Pass a returned `subscription_id` to unsubscribe. The subscribe result is returned only after the server acknowledges the native stream. Identical active requests are reused when their argument JSON matches.

Use `mcp_events` for wakeups. Figma listen's `listen_subscribe` and `listen_get_events` tools provide a separate retrieval workflow; calling them does not open a native event stream.

## How it works

1. The companion requests a lease on the adapter's configured connection. The lease prevents idle disconnection while subscribed and ends on adapter shutdown or disconnect.
2. It discovers event types using `events/list` and opens `events/stream` with draft push delivery.
3. It routes correlated `notifications/events/*` messages, leaving other traffic with the adapter and SDK. Normal MCP tools remain available.
4. Events are collected over a fixed 500ms window and delivered with Pi's `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. Idle Pi sessions start a turn; busy sessions receive a queued follow-up.
5. Unsubscribe cancels the stream. Session shutdown cancels streams, clears pending batches and releases connections.

The MCP Events wire format is experimental. This implementation supports local **stdio** transport only. HTTP, SSE, WebSocket and webhook delivery are outside this version. Legacy and modern MCP handshakes have protocol test coverage; the real Pi model tests used the adapter's legacy handshake.

Subscriptions and deduplication state live in memory, scoped to the Pi extension session. There is no shared daemon or subscription file. Independent Pi processes can subscribe independently. A restarted, reloaded or disconnected session must subscribe again; there is no automatic reconnect or replay persistence. You may pass a cursor when subscribing if the server supports replay. Truncated replay produces a warning.

Heartbeat notifications do not wake the model. Duplicate event IDs are suppressed within a bounded 10,000-ID window per stream. Upstream errors appear as warnings and in subscription status. Payloads are external data, not new user instructions.

Limits: 100 recorded subscriptions per session (unsubscribe to remove old entries); 256 events or 64,000 JSON characters per batch; large individual event payloads are shortened. Overflow counts and truncation markers are visible to the agent. This is bounded delivery, not a durable message queue.

## Development and verification

```sh
git clone https://github.com/mikekelly/pi-mcp-events.git
cd pi-mcp-events
npm ci
```

The development dependencies include the published adapter fork. The original minimal upstream patch is preserved in `patches/pi-mcp-adapter-5.0.0.patch` (base commit `85db03d87cd0f7461b55eab8d25c10bce473b801`); normal installation does not require applying it.

```sh
npm run check
node scripts/idle-test.mjs
```

The first command runs deterministic protocol, routing, batching and extension lifecycle tests, including the published Figma listen server. The second requires existing Pi ChatGPT authentication, uses a real Pi model and a controlled Figma snapshot fixture, and checks that an event alone starts a second turn after the first finishes. It does not need a Figma token. `node scripts/login.mjs` can perform the ChatGPT login interactively.

For a live test, create a disposable frame, then run:

```sh
FIGMA_LIVE_FILE=YOUR_FILE_KEY FIGMA_LIVE_FRAME=YOUR_FRAME_ID node scripts/idle-test.mjs
```

After `IDLE_CONFIRMED`, rename a child node to a unique name beginning `PI-LIVE-` and change its fill in Figma. The test allows five minutes for detection, the quiet period and model response. Remove your test frame afterwards. The script does not edit Figma itself.

Both real-model tests passed on 2026-10-05 with Pi 1.0.3, patched pi-mcp-adapter 5.0.0 and Figma listen 1.3.1. In the live test, Pi identified the changed rectangle's name and fill with no additional prompt. The temporary frame was removed. See [test evidence](docs/verification.md).
