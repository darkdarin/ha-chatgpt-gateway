import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAuthorized } from "./apikey.ts";
import { AuthError } from "./auth.ts";
import { ClientError, fromResponses, type Piece, toResponses, type Usage } from "./chat.ts";
import type { Logger } from "./log.ts";
import { NotSignedIn, type Session } from "./session.ts";
import { type Model, type Upstream, UpstreamError } from "./upstream.ts";

export interface ApiOptions {
  /** The current client key; read on every request, so a regenerated key applies at once. */
  apiKey: () => string;
  session: Session;
  upstream: Upstream;
  log: Logger;
}

const MAX_BODY = 8 * 1024 * 1024; // room for an image or two
const MODELS_TTL_MS = 10 * 60_000;
const LIMIT = "subscription_sharing_usage_limit_exceeded";

/** An OpenAI-style error body: `{"error": {"message", "type", "param", "code"}}`. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string | null = null,
  param: string | null = null,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, param, code } }));
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ClientError("The request body is too large.", null, 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClientError("The request body is not valid JSON.");
  }
}

/** The OpenAI-compatible API for clients in the home (`/v1/...`, bearer key). */
export function createApiServer(options: ApiOptions): Server {
  const { session, upstream, log } = options;
  let models: { list: Model[]; at: number; status: string } | undefined;

  async function listModels(): Promise<Model[]> {
    const token = await session.accessToken();
    if (models && models.status === session.status && Date.now() - models.at < MODELS_TTL_MS) {
      return models.list;
    }
    const list = await upstream.models(token);
    models = { list, at: Date.now(), status: session.status };
    return list;
  }

  /** Sends an error to the client and keeps the app page informed. */
  async function fail(res: ServerResponse, error: unknown): Promise<void> {
    if (error instanceof ClientError) {
      sendError(res, error.status, error.message, "invalid_request_error", error.code, error.param);
    } else if (error instanceof NotSignedIn) {
      sendError(res, 503, error.message, "service_unavailable", "not_signed_in");
    } else if (error instanceof AuthError) {
      const signedOut = session.status !== "signed_in";
      sendError(
        res,
        503,
        signedOut
          ? "The ChatGPT sign-in no longer works. Sign in again on the app page."
          : error.message,
        "service_unavailable",
        signedOut ? "not_signed_in" : error.code,
      );
    } else if (error instanceof UpstreamError) {
      if (error.status === 401) {
        // OpenAI refused the token itself: the sign-in was revoked.
        await session.revoked(error.message);
        sendError(
          res,
          503,
          "The ChatGPT sign-in was revoked. Sign in again on the app page.",
          "service_unavailable",
          "not_signed_in",
        ); // fmt: skip
        return;
      }
      if (error.status === 429 || error.status === 403)
        session.noteProblem(error.code, error.message);
      log.warning(`OpenAI answered ${error.status} ${error.code}`);
      const status = error.status >= 500 && error.status !== 503 ? 502 : error.status;
      sendError(res, status, error.message, error.type, error.code, error.param);
    } else {
      log.error(`Request failed: ${String(error)}`);
      sendError(res, 500, "The gateway failed to handle the request.", "server_error");
    }
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = toResponses(await readBody(req));
    const token = await session.accessToken();
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const started = Date.now();
    const pieces = fromResponses(upstream.respond(token, request.body, controller.signal));
    // Wait for the first piece before answering: errors before it get a real HTTP status (the
    // plan's usage limit arrives as an event inside an HTTP 200 stream).
    const first = await pieces.next();
    session.clearProblem(LIMIT);
    const firstMs = Date.now() - started;

    if (!request.stream) {
      let content = "";
      const calls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[] = [];
      let done: Extract<Piece, { type: "done" }> | undefined;
      const take = (piece: Piece) => {
        if (piece.type === "text") content += piece.text;
        else if (piece.type === "tool_call") {
          calls[piece.index] = {
            id: piece.id,
            type: "function",
            function: { name: piece.name, arguments: "" },
          };
        } else if (piece.type === "tool_arguments") {
          const call = calls[piece.index];
          if (call) call.function.arguments += piece.arguments;
        } else done = piece;
      };
      if (!first.done) take(first.value);
      for await (const piece of pieces) take(piece);
      sendJson(res, {
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: content || (calls.length ? null : ""),
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            logprobs: null,
            finish_reason: done?.finish ?? "stop",
          },
        ],
        ...(done?.usage ? { usage: done.usage } : {}),
      });
      log.debug(`chat ${request.model}: first ${firstMs} ms, total ${Date.now() - started} ms`);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (delta: Record<string, unknown>, finish: string | null = null, usage?: Usage) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
          ...(request.includeUsage ? { usage: null } : {}),
        })}\n\n`,
      );
      if (usage && request.includeUsage) {
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: request.model, choices: [], usage })}\n\n`,
        );
      }
    };
    const emit = (piece: Piece) => {
      if (piece.type === "text") send({ content: piece.text });
      else if (piece.type === "tool_call") {
        send({
          tool_calls: [
            {
              index: piece.index,
              id: piece.id,
              type: "function",
              function: { name: piece.name, arguments: "" },
            },
          ],
        });
      } else if (piece.type === "tool_arguments") {
        send({ tool_calls: [{ index: piece.index, function: { arguments: piece.arguments } }] });
      } else send({}, piece.finish, piece.usage);
    };
    send({ role: "assistant", content: "" });
    try {
      if (!first.done) emit(first.value);
      for await (const piece of pieces) emit(piece);
      res.write("data: [DONE]\n\n");
    } catch (error) {
      if (controller.signal.aborted) return;
      // The answer has started: report the error as an event, as OpenAI does.
      const upstreamError = error instanceof UpstreamError ? error : undefined;
      if (upstreamError?.code === LIMIT) session.noteProblem(LIMIT, upstreamError.message);
      log.warning(`The answer broke off: ${upstreamError?.code ?? String(error)}`);
      res.write(
        `data: ${JSON.stringify({
          error: {
            message: upstreamError?.message ?? "The answer broke off.",
            type: upstreamError?.type ?? "server_error",
            param: null,
            code: upstreamError?.code ?? "stream_interrupted",
          },
        })}\n\n`,
      );
    }
    res.end();
    log.debug(
      `chat ${request.model} (stream): first ${firstMs} ms, total ${Date.now() - started} ms`,
    );
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://gateway").pathname.replace(/\/+$/, "");
    if (!path.startsWith("/v1/")) {
      sendError(res, 404, `Unknown path ${path || "/"}`, "invalid_request_error", "not_found");
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
    const handle = async (): Promise<void> => {
      if (req.method === "GET" && path === "/v1/models") {
        const list = await listModels();
        sendJson(res, {
          object: "list",
          data: list.map((m) => ({ id: m.slug, object: "model", created: 0, owned_by: "openai" })),
        });
      } else if (req.method === "GET" && path.startsWith("/v1/models/")) {
        const name = decodeURIComponent(path.slice("/v1/models/".length));
        const model = (await listModels()).find((m) => m.slug === name);
        if (!model)
          throw new ClientError(
            `The model '${name}' does not exist.`,
            "model",
            404,
            "model_not_found",
          );
        sendJson(res, { id: model.slug, object: "model", created: 0, owned_by: "openai" });
      } else if (req.method === "POST" && path === "/v1/chat/completions") {
        await chat(req, res);
      } else {
        throw new ClientError(`Unknown endpoint ${req.method} ${path}.`, null, 404, "not_found");
      }
    };
    handle().catch((error: unknown) => fail(res, error));
  });
}
