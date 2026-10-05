# Pi MCP Events

Your agent updates a design in Figma, gives you a link, and asks you to review it. Before finishing its turn, it subscribes to comments and changes on the file, page, section, or frame it is working on. You open the link and leave feedback in Figma. When that feedback arrives, Pi wakes up, reads it, and can revise the design through the official Figma MCP. You can keep collaborating through comments and design changes without copying each update back into the terminal.

Pi MCP Events adds event subscriptions and idle wakeups to [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). The adapter supplies MCP connections, authentication, ordinary tools, and its management UI; this package supplies the `mcp_events` tool and delivers incoming activity into the agent's context. A server can offer both tools and events through the same connection.

For the Figma workflow, the **official remote Figma MCP** reads and edits designs, while [**Figma listen**](https://github.com/mikekelly/figma-listen) observes comments and changes. Pi MCP Events connects that activity to the running agent. Keep Pi open while you review; comments arrive after polling detects them, and design changes are grouped until the default 120-second quiet period.

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

## Set up Figma collaboration

The following setup was verified with Pi 1.0.3, adapter fork 5.1.0, Pi MCP Events 0.2.0, Figma listen 1.3.1, and `pi-figma-remote-auth` 0.1.3. Install the adapter and Events packages above first, and sign Pi in to your chosen model provider (for example, use `/login` for ChatGPT).

### 1. Generate a token for Figma listen

In Figma, go to **Settings → Security → Personal access tokens → Generate new token**. Give it a name, set its expiration to 90 days, and select all read scopes.

Export it in the shell that launches Pi, for example from your existing shell credentials file:

```sh
export FIGMA_ACCESS_TOKEN="YOUR_FIGMA_PERSONAL_ACCESS_TOKEN"
```

Start a new terminal or reload your shell configuration after adding it. This PAT is used by Figma listen's REST API polling. The official remote MCP uses a separate OAuth login.

### 2. Configure both Figma servers

Merge these entries into `~/.pi/agent/mcp-adapter.json`, preserving any existing servers and settings:

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp",
      "auth": "oauth",
      "lifecycle": "lazy",
      "exposeResources": true,
      "directTools": false
    },
    "figma-listen": {
      "command": "npx",
      "args": ["-y", "@realmikekelly/figma-listen@1.3.1"],
      "env": { "FIGMA_ACCESS_TOKEN": "${FIGMA_ACCESS_TOKEN}" }
    }
  }
}
```

`exposeResources` makes Figma's skill and reference resources available through the adapter. Use the remote server named `figma` for canvas edits. If you previously configured `figma-desktop`, disable that entry with `"disabled": true` or remove it to avoid selecting its read-only tools.

### 3. Authenticate the official remote MCP

Figma currently restricts remote MCP access to [approved clients](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), and Pi is not on that list. The third-party [pi-figma-remote-auth](https://pi.dev/packages/pi-figma-remote-auth) package provides an OAuth workaround: it registers with the client name `Codex` and saves credentials for the adapter. This worked in our live test; it is not official Pi support and depends on Figma continuing to accept that registration.

```sh
pi install npm:pi-figma-remote-auth@0.1.3
```

Restart Pi, then run this command **inside Pi**:

```text
/figma-remote-auth login --server figma
```

Confirm the login, open the printed URL in your browser, and approve access to your Figma account. The consent screen may identify the client as **Codex**. The helper saves the OAuth credentials; adapter 5.1.0 imports them into the OS credential store on connection and removes the temporary plaintext token file. Restart Pi after login.

**Skip `/figma-remote-auth setup` with the versions above.** Its 0.1.3 setup command writes the adapter's older `auth: "oauth"` format into `~/.pi/agent/mcp.json`. Pi 1.0.3 interprets that file using its native MCP schema, so the adapter skips the entry with `auth.provider must be a provider name`. The `mcp-adapter.json` configuration in step 2 is the verified fix. If you already ran setup, move only that `figma` entry into `mcp-adapter.json` and remove the duplicate from `mcp.json`; preserve your other entries.

### 4. Verify the connection

Ask Pi:

> Connect to the remote MCP server named figma, call whoami, and confirm that use_figma is available. Then use mcp_events to list the event catalog on figma-listen. Do not change any designs yet.

The remote server should identify your Figma account and expose `figma_use_figma`. Figma listen should list comment, reaction, design-change, and scope-deletion events. Figma account permissions and MCP access limits still apply. The remote setup does not require the Figma desktop app to stay open.

### 5. Work together in Figma

Give Pi a Figma link and a design task, then ask it to keep listening when it hands the design back for review. For example:

> Update this frame as discussed: FIGMA_FRAME_URL. Use the remote figma MCP for edits. When ready, give me a link and ask me to review it in Figma. Use mcp_events on figma-listen to subscribe to new and edited comments and design changes scoped to this frame, then finish your turn. I'll leave comments or make changes in Figma. When events arrive, inspect the relevant design, respond to my feedback within the agreed task, and give me an updated link in Pi. Keep listening until I ask you to stop. Recognize your own edits so they do not cause an edit feedback loop.

You can now leave a comment in Figma, see Pi wake and revise the design, and review the next iteration in the same file. You can also adjust the design yourself and have Pi respond to the resulting changeset. The agent reports back in Pi and through its canvas edits; this setup does not add a tool for the agent to post Figma comment replies.

Scope subscriptions to the work being reviewed. For page, section, or frame scopes, anchor comments to nodes within that scope; use file scope for file-wide feedback. Subscriptions are in memory: keep that Pi session running, and subscribe again after restarting or reloading it.

For a quieter comment channel, ask for a `#bot` tag filter and `include_thread_replies: true`. That includes untagged replies in a tagged thread, so a follow-up such as “done” does not also need the tag. Omit `tag` to receive all matching comments. Tags filter comments and reactions, not design changes.

Design notifications identify changed nodes and property names. The agent should read the current design through the official MCP when it needs the new values. The agent's own canvas writes can also produce events; there is no automatic suppression of self-authored edits. It can unsubscribe before making a revision and subscribe again afterwards, or recognize changes it already made before deciding whether to act.

### Native subscription examples

Discover event schemas first:

```json
{ "action": "catalog", "server": "figma-listen" }
```

Subscribe to comments on a frame (replace the example IDs):

```json
{
  "action": "subscribe",
  "server": "figma-listen",
  "name": "figma.comment.created",
  "arguments": {
    "scope": { "kind": "frame", "file_key": "YOUR_FILE_KEY", "node_id": "123:456" },
    "tag": "#bot",
    "include_thread_replies": true
  }
}
```

Subscribe separately to edits in that frame:

```json
{
  "action": "subscribe",
  "server": "figma-listen",
  "name": "figma.design.changed",
  "arguments": {
    "scope": { "kind": "frame", "file_key": "YOUR_FILE_KEY", "node_id": "123:456" }
  }
}
```

Subscribe separately to `figma.comment.edited` if existing comment edits should also wake the agent. File, page, section, and frame scopes are supported; consult the catalog's input schema for exact arguments.

`mcp_events` exposes `catalog`, `subscribe`, `list`, and `unsubscribe`. Pass a returned `subscription_id` to unsubscribe. The subscribe result is returned only after the server acknowledges the native stream. Identical active or reconnecting requests are reused when their argument JSON matches. The subscription ID remains stable through reconnects. Optional `max_age_ms` bounds cursor replay; omit it to use the server's replay policy.

Use `mcp_events` for wakeups. Figma listen's `listen_subscribe` and `listen_get_events` tools provide a separate retrieval workflow; calling them does not open a native event stream.

This complete write → subscribe → idle → external edit → wake → write-back loop passed in Pi's interactive terminal with the published packages. See [live verification](docs/verification.md#remote-figma-writes-and-live-idle-wakeup--2026-10-05).

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

The published 0.2.0 / 5.1.0 pair was also verified in Pi's interactive terminal against real Figma: Pi created a disposable design, subscribed, went idle, received an external change through Figma listen, and wrote a revision through the official remote MCP without another prompt. Earlier runs cover comment wakeups, recovery, and shutdown. See [test evidence](docs/verification.md).
