import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
// Exercise the real adapter mediation. Source override is for coordinated development.
const source = process.env.PI_MCP_ADAPTER_SOURCE;
const entry = source
  ? pathToFileURL(resolve(source, "runtime-protocol.ts")).href
  : new URL(
      "./runtime-protocol.ts",
      import.meta.resolve("@realmikekelly/pi-mcp-adapter"),
    ).href;
export const adapter = await import(entry);
