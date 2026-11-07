import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE = "api_key";
const PREFIX = "cgw-";

/** A new key for clients: a recognisable prefix and 256 random bits. */
export function newApiKey(): string {
  return PREFIX + randomBytes(32).toString("base64url");
}

/** Writes the key atomically, readable only by the app (mode 600). */
export async function saveApiKey(dataDir: string, key: string): Promise<void> {
  const target = join(dataDir, FILE);
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${key}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
}

/** The saved key, or a new one generated and saved on the first start. */
export async function loadOrCreateApiKey(dataDir: string): Promise<string> {
  try {
    const key = (await readFile(join(dataDir, FILE), "utf8")).trim();
    if (key) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = newApiKey();
  await saveApiKey(dataDir, key);
  return key;
}

/** Whether an `Authorization` header carries exactly this key as a bearer token. */
export function isAuthorized(header: string | undefined, key: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
