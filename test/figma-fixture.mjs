// Published Figma listen server and engine, with controlled upstream snapshots only.
import { readFile } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "@realmikekelly/figma-listen";
import { ListenEngine } from "@realmikekelly/figma-listen/engine";
import { StateStore } from "@realmikekelly/figma-listen/store";
const state = process.env.FIGMA_FIXTURE_STATE;
const read = async () => JSON.parse(await readFile(state, "utf8"));
const fake = {
  async comments() {
    const snapshot = await read();
    if (snapshot.exit) process.exit(0);
    return snapshot.comments;
  },
  async discover(scope) {
    return { files: [{ key: scope.file_key }], warnings: [] };
  },
  async reactions() {
    return [];
  },
  async file() {
    return {
      name: "Synthetic design",
      version: "1",
      document: { id: "0:0", type: "DOCUMENT", children: [] },
    };
  },
};
const store = new StateStore();
await store.open("synthetic-user");
const engine = new ListenEngine(store, fake, { pollIntervalMs: 100 });
const handle = serveStdio(() => createServer(engine));
engine.start();
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await handle.close();
  await engine.close();
};
process.stdin.once("end", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
