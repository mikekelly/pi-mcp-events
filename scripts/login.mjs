import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline/promises";
const runtime = await ModelRuntime.create();
const rl = createInterface({ input: process.stdin, output: process.stderr });
try {
  await runtime.login("openai-codex", "oauth", {
    notify(e) {
      if (e.type === "auth_url") console.log(e.url);
      else if (e.type === "device_code")
        console.log(e.verificationUri + "\nCode: " + e.userCode);
      else console.log(e.message ?? "");
    },
    async prompt(p) {
      if (p.type === "select") return p.options[0].id;
      return rl.question(p.message + " ", { signal: p.signal });
    },
  });
  console.log("PI_LOGIN_COMPLETE");
} finally {
  rl.close();
}
