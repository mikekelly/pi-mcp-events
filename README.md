# Pi MCP Events

An event-stream companion to [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Your agent subscribes to an MCP event, finishes its turn, and wakes when the event arrives. A server can expose both ordinary tools and events through the same connection.

The adapter owns server configuration, authentication, connections, tool discovery and its management UI. This companion adds the `mcp_events` tool and visible event messages that can wake an idle Pi session.

## Install

**Pi MCP Events 0.2.0 requires adapter fork 5.1.0 or newer. Upgrade both packages together from the older 0.1.0 / 5.0.1 pair.**

Requires Node 22.19+ and Pi 1.0.3+. For now, use [Mike Kelly's adapter fork](https://github.com/mikekelly/pi-mcp-adapter), which includes the mediated protocol-extension hook needed by this package. Unmodified upstream pi-mcp-adapter 5.0.0 does not expose that hook.

```sh
# Skip removal if the upstream adapter is not installed.
pi remove npm:pi-mcp-adapter
pi install npm:@realmikekelly/pi-mcp-adapter@^5.1.0
pi install npm:@realmikekelly/pi-mcp-events@^0.2.0
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

`mcp_events` exposes `catalog`, `subscribe`, `list` and `unsubscribe`. Pass a returned `subscription_id` to unsubscribe. The subscribe result is returned only after the server acknowledges the native stream. Identical active or reconnecting requests are reused when their argument JSON matches. The subscription ID remains stable through reconnects. Optional `max_age_ms` bounds cursor replay; omit it to use the server’s replay policy.

Use `mcp_events` for wakeups. Figma listen's `listen_subscribe` and `listen_get_events` tools provide a separate retrieval workflow; calling them does not open a native event stream.

## How it works

1. The companion registers the `events` protocol with the adapter: `events/list`, `events/stream`, and the supported `notifications/events/*` methods. Registration does not subscribe to anything.
2. When explicitly requested, it discovers event types and opens a stream through the adapter's mediated API. The companion receives no SDK client or raw transport.
3. The adapter routes notifications by declared method and subscription ID, owns cancellation, and prevents idle disconnection while operations are active. Core MCP methods, including tool calls, cannot be sent through this extension point. Normal MCP tools remain available.
4. Events are collected over a fixed 500ms window and delivered with Pi's `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. Idle Pi sessions start a turn; busy sessions receive a queued follow-up.
5. The initial `notifications/events/active` acknowledgement is rendered in the subscribe tool result. Unexpected stream endings, terminal errors, replay gaps and connection loss become visible status messages that wake Pi. Transient interruptions enter bounded recovery; repeated retry attempts do not each wake the model. These are batched over 500ms so several streams closing together do not each start a turn. A recoverable upstream error is reported while the subscription remains active.
6. Requested cancellation is rendered in the unsubscribe tool result without an extra turn. Session shutdown cancels streams and clears both event and status batches, including when the adapter's shutdown hook runs first.

The MCP Events wire format is experimental. This package focuses on **push over stdio and Streamable HTTP/SSE**, using the existing adapter server configuration. HTTP cancellation closes only the subscription’s response stream. There are no MCP event-polling loops, webhook receivers, tunnel tools or endpoint-registration actions. Events advertising only polling or webhook delivery return an explicit unsupported-delivery error. The generic adapter also retains its legacy HTTP+SSE and Unix socket compatibility. Real HTTP/SSE integration tests cover both MCP handshake generations; Figma listen and model wakeup tests use stdio.

Subscriptions and deduplication state live in memory, scoped to the Pi extension session. There is no shared daemon or subscription file. Independent Pi processes can subscribe independently. A restarted or reloaded Pi session must subscribe again. While Pi remains running, connection loss or 65 seconds without a valid event/heartbeat triggers recovery using the latest cursor. Up to five retries use 1, 2, 4, 8 and 16 second delays. A valid event/heartbeat resets that budget; repeated acknowledgement-then-disconnect cycles do not. Explicit termination, JSON-RPC errors, intentional cancellation and graceful server completion stop the subscription. Unsubscribe and shutdown cancel pending retries. Replay depends on server support and retention; null or absent cursors mean there is no replay position. Initial and mid-stream replay gaps are reported, and the fresh cursor is retained. Repeated gap reports during one recovery episode are folded into its eventual recovery/failure status; recovered events also carry `replay_truncated` when appropriate. Cursors are not persisted across Pi restarts.

Heartbeat notifications do not wake the model. Duplicate event IDs are suppressed within a bounded 10,000-ID window per stream. Upstream errors appear as warnings, in subscription status, and in context when they occur on an active stream. Payloads are external data, not new user instructions.

Limits: 100 recorded subscriptions per session (unsubscribe to remove old entries); 256 events or 64,000 JSON characters per batch; large individual event payloads are shortened. Overflow counts and truncation markers are visible to the agent. This is bounded delivery, not a durable message queue.

## Development and verification

```sh
git clone https://github.com/mikekelly/pi-mcp-events.git
cd pi-mcp-events
npm ci
```

The development dependency pins the compatible adapter fork by Git commit, so `npm ci` tests the exact adapter revision. To try local builds after cloning and building:

```sh
npm run build
# Remove any existing adapter/events registrations first; keep one of each.
pi install ./node_modules/@realmikekelly/pi-mcp-adapter
pi install .
```

Restart Pi. These local paths must remain on disk. The old connection-lease API is intentionally unsupported.

```sh
npm run check
node scripts/idle-test.mjs
```

The first command runs deterministic protocol, routing, batching and extension lifecycle tests, including the published Figma listen server. The second requires existing Pi ChatGPT authentication, uses a real Pi model and a controlled Figma snapshot fixture, and checks that an event alone starts a second turn after the first finishes, then closes the synthetic server and verifies one interruption wakeup followed by one final wakeup after bounded recovery is exhausted. It also checks that session shutdown does not start another turn. It does not need a Figma token. `node scripts/login.mjs` can perform the ChatGPT login interactively.

For a live test, create a disposable frame, then run:

```sh
FIGMA_LIVE_FILE=YOUR_FILE_KEY FIGMA_LIVE_FRAME=YOUR_FRAME_ID node scripts/idle-test.mjs
```

After `IDLE_CONFIRMED`, rename a child node to a unique name beginning `PI-LIVE-` and change its fill in Figma. The test allows five minutes for detection, the quiet period and model response. Remove your test frame afterwards. The script does not edit Figma itself.

The original live Figma test passed on 2026-10-05 with Pi 1.0.3 and the earlier adapter hook. The mediated protocol refactor was verified separately against published Figma listen 1.3.1 with controlled snapshots and a real Pi model, including disconnect wakeup and quiet shutdown. In the live test, Pi identified the changed rectangle's name and fill with no additional prompt. The temporary frame was removed. See [test evidence](docs/verification.md).
