import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPENAI_API, OPENAI_ISSUER } from "./auth.ts";

export const LOG_LEVELS = ["debug", "info", "warning", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** The app's own data folder (`/data` in Home Assistant). */
  dataDir: string;
  /** Port of the OpenAI-compatible API for clients. */
  apiPort: number;
  /** Port of the app page (Home Assistant's Ingress port). */
  uiPort: number;
  /** Loopback port of the sign-in callback; part of the registered redirect address. */
  callbackPort: number;
  /** Accept page requests from anyone, not only the Supervisor (development outside HA). */
  uiTrustAll: boolean;
  issuer: string;
  apiBase: string;
  logLevel: LogLevel;
}

export const DEFAULT_API_PORT = 8780;
export const DEFAULT_UI_PORT = 8099;
export const DEFAULT_CALLBACK_PORT = 47615;

function port(value: string | undefined, fallback: number, name: string): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error(`Invalid ${name} "${value}"`);
  }
  return number;
}

/**
 * Reads the configuration: the app options Home Assistant writes to `<data>/options.json`, with
 * environment overrides for running outside Home Assistant (`DATA_DIR`, `API_PORT`, `UI_PORT`,
 * `UI_TRUST_ALL=1`, `LOG_LEVEL`) and for tests (`CALLBACK_PORT`, `OPENAI_ISSUER`, `OPENAI_API`).
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
  return {
    dataDir,
    apiPort: port(env.API_PORT, DEFAULT_API_PORT, "API port"),
    uiPort: port(env.UI_PORT, DEFAULT_UI_PORT, "page port"),
    callbackPort: port(env.CALLBACK_PORT, DEFAULT_CALLBACK_PORT, "callback port"),
    uiTrustAll: env.UI_TRUST_ALL === "1",
    issuer: env.OPENAI_ISSUER ?? OPENAI_ISSUER,
    apiBase: env.OPENAI_API ?? OPENAI_API,
    logLevel: logLevel as LogLevel,
  };
}
