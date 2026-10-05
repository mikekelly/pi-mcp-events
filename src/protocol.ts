/** Structural adapter API: no SDK client or transport crosses this boundary. */
export const PROTOCOL_EVENT = "pi-mcp-adapter:protocol:v1";
export const EVENTS_PROTOCOL = {
  namespace: "events",
  requests: ["events/list"],
  streams: ["events/stream"],
  notifications: [
    "notifications/events/active",
    "notifications/events/event",
    "notifications/events/heartbeat",
    "notifications/events/error",
  ],
};
export interface ProtocolEnd {
  reason: "cancelled" | "ended" | "error" | "disconnected";
  error?: string;
  protocolError?: { code: number; message: string; data?: unknown };
}
export interface ProtocolWatch {
  readonly closed: Promise<ProtocolEnd>;
  close(): void;
}
export interface ProtocolStream {
  readonly id: string;
  readonly sent: Promise<void>;
  readonly closed: Promise<ProtocolEnd>;
  cancel(): Promise<void>;
}
export interface ProtocolSession {
  readonly signal: AbortSignal;
  watchNotifications(
    methods: string[],
    onNotification: (method: string, params: Record<string, unknown>) => void,
  ): ProtocolWatch;
  request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  openStream(
    method: string,
    params: Record<string, unknown>,
    onNotification: (method: string, params: Record<string, unknown>) => void,
  ): ProtocolStream;
  close(): void;
}
export interface ProtocolRegistration {
  connect(server: string): Promise<ProtocolSession>;
  dispose(): void;
}
