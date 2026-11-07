// The app page in the Home Assistant sidebar (Ingress): sign-in, models, API address and key.
// Only the Supervisor's Ingress proxy may reach it; Home Assistant has signed the user in already.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AuthError } from "./auth.ts";
import type { Logger } from "./log.ts";
import { page } from "./page.ts";
import type { Session } from "./session.ts";
import type { Model, Upstream } from "./upstream.ts";

export const SUPERVISOR = "172.30.32.2";

export interface UiOptions {
  session: Session;
  upstream: Upstream;
  apiKey: () => string;
  regenerateKey: () => Promise<string>;
  /** How other apps reach the API, e.g. http://d9eec4fe-chatgpt-gateway:8780/v1. */
  internalUrl: string;
  apiPort: number;
  version: string;
  /** Outside Home Assistant (development): accept every client, not only the Supervisor. */
  trustAll: boolean;
  log: Logger;
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64 * 1024) throw new AuthError("too_large", "The request is too large.");
  }
  try {
    const value: unknown = JSON.parse(text || "{}");
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    throw new AuthError("invalid_request", "The request is not valid JSON.");
  }
}

export function createUiServer(options: UiOptions): Server {
  const { session, upstream, log } = options;
  let models: { list: Model[]; at: number } | undefined;

  async function state(): Promise<Record<string, unknown>> {
    const view = session.view();
    let modelList: Model[] | undefined;
    let modelsError: string | undefined;
    if (view.status === "signed_in") {
      try {
        if (!models || Date.now() - models.at > 10 * 60_000) {
          models = { list: await upstream.models(await session.accessToken()), at: Date.now() };
        }
        modelList = models.list;
      } catch (error) {
        modelsError = (error as Error).message;
      }
    } else {
      models = undefined;
    }
    return {
      version: options.version,
      session: view,
      models: modelList ?? null,
      ...(modelsError ? { modelsError } : {}),
      apiKey: options.apiKey(),
      internalUrl: options.internalUrl,
      apiPort: options.apiPort,
    };
  }

  return createServer((req, res) => {
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (!options.trustAll && remote !== SUPERVISOR) {
      res.writeHead(403).end("Open this page from the Home Assistant sidebar.");
      return;
    }
    const path = new URL(req.url ?? "/", "http://ui").pathname;
    const handle = async (): Promise<void> => {
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
        });
        res.end(page());
        return;
      }
      if (req.method === "GET" && path === "/api/state") {
        send(res, 200, await state());
        return;
      }
      if (req.method !== "POST" || !path.startsWith("/api/")) {
        res.writeHead(404).end("Not found");
        return;
      }
      // JSON only: a form on another site cannot send it, so it cannot act through Ingress.
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        send(res, 415, { error: { message: "Send JSON." } });
        return;
      }
      const body = await readJson(req);
      switch (path) {
        case "/api/signin":
          send(res, 200, { authUrl: await session.startSignIn() });
          return;
        case "/api/callback":
          if (typeof body.address !== "string")
            throw new AuthError("invalid_request", "No address.");
          await session.finishSignIn(body.address);
          models = undefined;
          send(res, 200, await state());
          return;
        case "/api/cancel":
          session.cancelSignIn();
          send(res, 200, await state());
          return;
        case "/api/signout":
          await session.signOut();
          models = undefined;
          send(res, 200, await state());
          return;
        case "/api/key":
          await options.regenerateKey();
          log.info("Generated a new API key for clients");
          send(res, 200, await state());
          return;
        default:
          res.writeHead(404).end("Not found");
      }
    };
    handle().catch((error: unknown) => {
      if (!(error instanceof AuthError)) log.error(`Page request failed: ${String(error)}`);
      send(res, error instanceof AuthError ? 400 : 500, {
        error: {
          code: error instanceof AuthError ? error.code : "error",
          message: (error as Error).message,
        },
      });
    });
  });
}
