import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createApiServer } from "./api.ts";
import { loadOrCreateApiKey, newApiKey, saveApiKey } from "./apikey.ts";
import { OpenAIAuth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { Session } from "./session.ts";
import { createUiServer } from "./ui.ts";
import { Upstream } from "./upstream.ts";
import { WsPool } from "./ws.ts";

const config = await loadConfig();
const log = createLogger(config.logLevel);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

let apiKey = await loadOrCreateApiKey(config.dataDir);
const auth = new OpenAIAuth(config.issuer, config.apiBase);
const ws = config.websocket
  ? new WsPool({ url: `${config.apiBase.replace(/^http/, "ws")}/responses`, log })
  : undefined;
const upstream = new Upstream(config.apiBase, ws);
const session = new Session({
  dataDir: config.dataDir,
  auth,
  appName: "ChatGPT Gateway",
  callbackPort: config.callbackPort,
  log,
});
// Keep a WebSocket open with the current token: after sign-in, each refresh and sign-out.
session.onChange = () => ws?.warm(session.currentToken);
await session.load();
ws?.warm(session.currentToken);

const api = createApiServer({ apiKey: () => apiKey, session, upstream, log });
const ui = createUiServer({
  session,
  upstream,
  apiKey: () => apiKey,
  regenerateKey: async () => {
    const key = newApiKey();
    await saveApiKey(config.dataDir, key);
    apiKey = key;
    return key;
  },
  internalUrl: `http://${hostname()}:${config.apiPort}/v1`,
  apiPort: config.apiPort,
  version,
  trustAll: config.uiTrustAll,
  log,
});

log.info(`ChatGPT Gateway ${version} (${ws ? "WebSocket" : "HTTP"} to OpenAI)`);
api.listen(config.apiPort, () => log.info(`API listening on port ${config.apiPort}`));
ui.listen(config.uiPort, () => log.info(`Page listening on port ${config.uiPort}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info("Stopping");
    session.close();
    ws?.close();
    for (const server of [api, ui]) {
      server.close();
      server.closeAllConnections();
    }
    process.exit(0);
  });
}
