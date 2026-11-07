import { createApiServer } from "./api.ts";
import { loadOrCreateApiKey } from "./apikey.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

const config = await loadConfig();
const log = createLogger(config.logLevel);
const apiKey = await loadOrCreateApiKey(config.dataDir);

const api = createApiServer({ apiKey: () => apiKey, log });
api.listen(config.apiPort, () => log.info(`API listening on port ${config.apiPort}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log.info("Stopping");
    api.close(() => process.exit(0));
    api.closeAllConnections();
  });
}
