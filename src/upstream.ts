// OpenAI's API with the ChatGPT plan's token: the model catalog and the Responses API (always
// streamed, never stored, as plan usage requires).

export interface Model {
  slug: string;
  displayName: string;
}

/** An error from OpenAI, with the HTTP status and code to pass on to clients. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly param: string | null;
  constructor(status: number, code: string, message: string, type = "api_error", param = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads an error body: `{"error": {...}}`, an OAuth `{"error": "code"}` or `{"detail": "..."}`. */
export function errorFrom(status: number, body: unknown): UpstreamError {
  const data = isObject(body) ? body : {};
  const error = isObject(data.error) ? data.error : {};
  const code =
    (typeof error.code === "string" && error.code) ||
    (typeof data.error === "string" && data.error) ||
    (typeof data.code === "string" && data.code) ||
    `http_${status}`;
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof data.detail === "string" && data.detail) ||
    (typeof data.message === "string" && data.message) ||
    `OpenAI answered ${status}.`;
  const type = typeof error.type === "string" ? error.type : "api_error";
  const param = typeof error.param === "string" ? error.param : null;
  return new UpstreamError(status, code, message, type, param as null);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 500) };
  }
}

/** Splits a Server-Sent Events body into the JSON of its `data:` fields. */
export async function* sseEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): Record<string, unknown> | undefined => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    const value: unknown = JSON.parse(data);
    return isObject(value) ? value : undefined;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const event = parse(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const last = buffer.trim() ? parse(buffer) : undefined;
  if (last) yield last;
}

export class Upstream {
  readonly base: string;

  constructor(base = "https://api.openai.com/v1") {
    this.base = base;
  }

  #headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${token}`, ...extra };
  }

  /** The models the plan offers (`visibility: list` in OpenAI's catalog). */
  async models(token: string, signal?: AbortSignal): Promise<Model[]> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/models`, {
        headers: this.#headers(token, { accept: "application/json" }),
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new UpstreamError(502, "network_error", "Could not reach OpenAI.");
    }
    const body = await readJson(response);
    if (!response.ok) throw errorFrom(response.status, body);
    const list = isObject(body) && Array.isArray(body.models) ? body.models : undefined;
    if (!list) throw new UpstreamError(502, "invalid_model_catalog", "Unexpected model catalog.");
    return list
      .filter(isObject)
      .filter((model) => model.visibility === "list" && typeof model.slug === "string")
      .map((model) => ({
        slug: String(model.slug),
        displayName:
          typeof model.display_name === "string" ? model.display_name : String(model.slug),
      }));
  }

  /** Sends a Responses API request and yields its streamed events. */
  async *respond(
    token: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/responses`, {
        method: "POST",
        headers: this.#headers(token, {
          "content-type": "application/json",
          accept: "text/event-stream",
        }),
        body: JSON.stringify({ ...body, store: false, stream: true }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UpstreamError(502, "network_error", "Could not reach OpenAI.");
    }
    if (!response.ok || !response.body) throw errorFrom(response.status, await readJson(response));
    yield* sseEvents(response.body);
  }
}
