import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIAuth } from "../src/auth.ts";
import { createLogger } from "../src/log.ts";
import { Session } from "../src/session.ts";
import type { FakeOpenAI } from "./fake-openai.ts";

export const quiet = createLogger("error", () => {});

export const tempDir = () => mkdtemp(join(tmpdir(), "gateway-"));

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function makeSession(fake: FakeOpenAI, dataDir?: string): Promise<Session> {
  const session = new Session({
    dataDir: dataDir ?? (await tempDir()),
    auth: new OpenAIAuth(fake.base, fake.apiBase),
    appName: "ChatGPT Gateway",
    callbackPort: await freePort(),
    log: quiet,
  });
  await session.load();
  return session;
}

/** Signs a session in the way the owner does: open the link, sign in, paste the address. */
export async function signIn(session: Session, fake: FakeOpenAI): Promise<void> {
  const url = await session.startSignIn();
  await session.finishSignIn(fake.approve(url));
}
