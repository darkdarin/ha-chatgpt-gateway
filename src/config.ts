import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** The app's own data folder (`/data` in Home Assistant). */
  dataDir: string;
  /** Port of the OpenAI-compatible API for clients. */
  apiPort: number;
  logLevel: LogLevel;
}

export const DEFAULT_API_PORT = 8780;

/**
 * Reads the configuration: the app options Home Assistant writes to `<data>/options.json`, with
 * environment overrides for running outside Home Assistant (`DATA_DIR`, `API_PORT`, `LOG_LEVEL`).
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const dataDir = env.DATA_DIR ?? "/data";
  let options: Record<string, unknown> = {};
  try {
    options = JSON.parse(await readFile(join(dataDir, "options.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const logLevel = env.LOG_LEVEL ?? options.log_level ?? "info";
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`Unknown log level "${String(logLevel)}"; use one of ${LOG_LEVELS.join(", ")}`);
  }
  const apiPort = Number(env.API_PORT ?? DEFAULT_API_PORT);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid API port "${env.API_PORT}"`);
  }
  return { dataDir, apiPort, logLevel: logLevel as LogLevel };
}
