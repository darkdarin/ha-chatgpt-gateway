import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAuthorized } from "./apikey.ts";
import type { Logger } from "./log.ts";

export interface ApiOptions {
  /** The current client key; read on every request, so a regenerated key applies at once. */
  apiKey: () => string;
  log: Logger;
}

/** An OpenAI-style error body: `{"error": {"message", "type", "code"}}`. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string | null = null,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

/** The OpenAI-compatible API for clients in the home (`/v1/...`, bearer key). */
export function createApiServer(options: ApiOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (!path.startsWith("/v1/")) {
      sendError(res, 404, `Unknown path ${path}`, "invalid_request_error", "not_found");
      return;
    }
    if (!isAuthorized(req.headers.authorization, options.apiKey())) {
      sendError(
        res,
        401,
        "Pass the gateway's API key as 'Authorization: Bearer <key>'; it is shown on the app's page.",
        "invalid_request_error",
        "invalid_api_key",
      );
      return;
    }
    // Sign-in with ChatGPT and the model endpoints come next; until then every model call
    // answers like a gateway that is not signed in.
    sendError(
      res,
      503,
      "The gateway is not signed in to ChatGPT. Sign in on the app's page in Home Assistant.",
      "service_unavailable",
      "not_signed_in",
    );
  });
}
