# Idle wakeup verification — 2026-10-05

Both runs loaded the adapter and companion as separate extensions in the real Pi 1.0.3 SDK using ChatGPT authentication. Each agent opened a native events/stream subscription, acknowledged it and ended its turn. No further user prompt was supplied. Trace checks require native events/stream and notifications/events/event and reject listen_get_events retrieval.

| Test | Upstream | Result |
| --- | --- | --- |
| Comment | Published Figma listen 1.3.1 with controlled upstream snapshot | Idle agent started a second turn and echoed the new tagged comment. |
| Design change | Published Figma listen 1.3.1 with real Figma REST data | Idle agent started a second turn and identified the rectangle's renamed node and changed fill. |

Live response:

> Node “PI-LIVE-20261005-WAKE” (58:3) changed: `fills` and `name` (previously “Pi wakeup probe”).

The live subscription was scoped to a disposable frame. The default 120-second quiet period was retained. Elapsed time from the script's post-idle checkpoint to the response was about 191 seconds; this includes time before the edit was made and must not be interpreted as event transport latency. The test frame and its rectangle were removed after the stream stopped.

A repeat synthetic test passed using the final fork identity `@realmikekelly/pi-mcp-adapter@5.0.1`: the event alone started the second turn and the model echoed the new tagged comment. Evidence logs are retained locally and are not included in the published package.

Subsequent deterministic tests cover payload bounds, connection cleanup and rejection of unsupported transports. The model test verifies the actual Pi runtime wakeup; it does not claim a dedicated interactive adapter subscriptions UI was implemented or visually tested.

## Mediated protocol refactor — 2026-10-05

The refactor replaces raw connection access with registered protocol methods. The companion has no SDK client or transport. Deterministic tests exercise real adapter routing, core-method rejection, activation and cancellation, terminal results/errors, disconnects, lifecycle batching, and adapter-first shutdown. Integration tests use the published Figma listen 1.3.1 server with both 2025 and 2026 handshakes.

A fresh real Pi 1.0.3 / ChatGPT run using the new adapter implementation produced exactly three turns: the initial subscribe turn, a comment-triggered turn, and a disconnect-triggered turn. The model echoed the unique synthetic comment and subsequently replied `STREAM_STOPPED` after the fixture server exited. No additional prompt was sent. Shutdown produced no additional turn. The comment reply arrived about 3.8 seconds after fixture update; this is controlled-fixture evidence, not a Figma polling latency claim.

The live Figma edit test above predates this refactor; it was not repeated against real Figma for this change.
