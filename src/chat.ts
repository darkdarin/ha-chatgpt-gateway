// OpenAI Chat Completions ↔ Responses API. Requests: system and developer messages become
// `instructions`, the rest `input` items (tool calls and their results included); options that
// ChatGPT plan usage does not support (temperature, max_tokens…) are dropped. Answers: Responses
// events become Chat Completions deltas (text and tool calls) and a final finish reason.

import { UpstreamError } from "./upstream.ts";

/** A request the gateway cannot serve, answered with HTTP 400 (or `status`). */
export class ClientError extends Error {
  readonly status: number;
  readonly param: string | null;
  readonly code: string | null;
  constructor(
    message: string,
    param: string | null = null,
    status = 400,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ClientError";
    this.status = status;
    this.param = param;
    this.code = code;
  }
}

export interface ChatRequest {
  model: string;
  stream: boolean;
  includeUsage: boolean;
  /** The Responses API body (without `store` and `stream`, which the upstream sets). */
  body: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Options of Chat Completions that plan usage does not accept: dropped silently. */
const IGNORED = new Set([
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "stop",
  "user",
  "logit_bias",
  "metadata",
  "store",
  "service_tier",
  "prompt_cache_key",
  "safety_identifier",
  "verbosity",
]);

const KNOWN = new Set([
  ...IGNORED,
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "response_format",
  "n",
  "logprobs",
  "top_logprobs",
]);

type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

/** The text of a message content: a string or a list of text parts. */
function text(content: unknown, param: string): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part, i) => {
        if (isObject(part) && (part.type === "text" || part.type === "input_text")) {
          return typeof part.text === "string" ? part.text : "";
        }
        throw new ClientError("Only text parts are supported in this message.", `${param}[${i}]`);
      })
      .join("");
  }
  throw new ClientError("Message content must be a string or a list of parts.", param);
}

/** User content: text, or text and image parts. */
function userContent(content: unknown, param: string): string | InputPart[] {
  if (!Array.isArray(content)) return text(content, param);
  return content.map((part, i): InputPart => {
    if (isObject(part) && part.type === "text" && typeof part.text === "string") {
      return { type: "input_text", text: part.text };
    }
    if (isObject(part) && part.type === "image_url") {
      const image = part.image_url;
      const url = typeof image === "string" ? image : isObject(image) ? image.url : undefined;
      if (typeof url === "string") return { type: "input_image", image_url: url };
    }
    throw new ClientError("Only text and image_url parts are supported.", `${param}[${i}]`);
  });
}

function tools(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ClientError("tools must be a list.", "tools");
  return value.map((tool, i) => {
    const fn = isObject(tool) ? tool.function : undefined;
    if (
      !isObject(tool) ||
      tool.type !== "function" ||
      !isObject(fn) ||
      typeof fn.name !== "string"
    ) {
      throw new ClientError("Only function tools are supported.", `tools[${i}]`);
    }
    return {
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      // Chat Completions functions are not strict unless asked; the Responses API's default is.
      strict: fn.strict === true,
    };
  });
}

function toolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObject(value) && value.type === "function" && isObject(value.function)) {
    return { type: "function", name: value.function.name };
  }
  throw new ClientError("tool_choice must be auto, none, required or a function.", "tool_choice");
}

function responseFormat(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value) || value.type === "text") return undefined;
  if (value.type === "json_object") return { format: { type: "json_object" } };
  if (value.type === "json_schema" && isObject(value.json_schema)) {
    const schema = value.json_schema;
    return {
      format: {
        type: "json_schema",
        name: schema.name ?? "response",
        schema: schema.schema ?? {},
        strict: schema.strict === true,
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      },
    };
  }
  throw new ClientError("Unsupported response_format.", "response_format");
}

/** Validates a Chat Completions request and translates it to the Responses API. */
export function toResponses(request: unknown): ChatRequest {
  if (!isObject(request)) throw new ClientError("The request body must be a JSON object.");
  for (const key of Object.keys(request)) {
    if (!KNOWN.has(key)) throw new ClientError(`Unsupported parameter: ${key}.`, key);
  }
  const { model, messages } = request;
  if (typeof model !== "string" || !model.trim())
    throw new ClientError("model is required.", "model");
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ClientError("messages must be a non-empty list.", "messages");
  }
  if (request.n !== undefined && request.n !== 1)
    throw new ClientError("Only n=1 is supported.", "n");

  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  messages.forEach((message, i) => {
    const param = `messages[${i}]`;
    if (!isObject(message)) throw new ClientError("A message must be an object.", param);
    const role = message.role;
    if (role === "system" || role === "developer") {
      const value = text(message.content, `${param}.content`);
      if (value) instructions.push(value);
    } else if (role === "user") {
      input.push({ role: "user", content: userContent(message.content, `${param}.content`) });
    } else if (role === "assistant") {
      const value = text(message.content, `${param}.content`);
      if (value) input.push({ role: "assistant", content: value });
      const calls = message.tool_calls;
      if (calls !== undefined && calls !== null) {
        if (!Array.isArray(calls)) throw new ClientError("tool_calls must be a list.", param);
        calls.forEach((call, j) => {
          const fn = isObject(call) ? call.function : undefined;
          if (
            !isObject(call) ||
            typeof call.id !== "string" ||
            !isObject(fn) ||
            typeof fn.name !== "string"
          ) {
            throw new ClientError(
              "A tool call needs an id and a function name.",
              `${param}.tool_calls[${j}]`,
            );
          }
          input.push({
            type: "function_call",
            call_id: call.id,
            name: fn.name,
            arguments:
              typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        });
      }
    } else if (role === "tool") {
      if (typeof message.tool_call_id !== "string") {
        throw new ClientError("A tool message needs tool_call_id.", `${param}.tool_call_id`);
      }
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: text(message.content, `${param}.content`),
      });
    } else {
      throw new ClientError(`Unsupported message role: ${String(role)}.`, `${param}.role`);
    }
  });
  if (input.length === 0)
    throw new ClientError("messages need at least one user message.", "messages");

  const body: Record<string, unknown> = { model, input };
  if (instructions.length) body.instructions = instructions.join("\n\n");
  if (request.tools !== undefined && request.tools !== null) {
    const list = tools(request.tools);
    if (list.length) body.tools = list;
  }
  if (request.tool_choice !== undefined && request.tool_choice !== null) {
    body.tool_choice = toolChoice(request.tool_choice);
  }
  if (typeof request.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (typeof request.reasoning_effort === "string") {
    body.reasoning = { effort: request.reasoning_effort };
  }
  const format = responseFormat(request.response_format);
  if (format) body.text = format;
  const options = isObject(request.stream_options) ? request.stream_options : {};
  return {
    model,
    stream: request.stream === true,
    includeUsage: options.include_usage === true,
    body,
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export type Piece =
  | { type: "text"; text: string }
  | { type: "tool_call"; index: number; id: string; name: string }
  | { type: "tool_arguments"; index: number; arguments: string }
  | { type: "done"; finish: FinishReason; usage?: Usage };

function usage(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined;
  const number = (v: unknown) => (typeof v === "number" ? v : 0);
  const input = isObject(value.input_tokens_details) ? value.input_tokens_details : {};
  const output = isObject(value.output_tokens_details) ? value.output_tokens_details : {};
  return {
    prompt_tokens: number(value.input_tokens),
    completion_tokens: number(value.output_tokens),
    total_tokens: number(value.total_tokens),
    prompt_tokens_details: { cached_tokens: number(input.cached_tokens) },
    completion_tokens_details: { reasoning_tokens: number(output.reasoning_tokens) },
  };
}

/** The HTTP status for an OpenAI error code, so clients see a limit as 429 and so on. */
export function statusFor(code: string, fallback: number): number {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
    case "rate_limit_exceeded":
      return 429;
    case "subscription_sharing_user_not_eligible":
    case "subscription_sharing_route_not_supported":
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return 403;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return 503;
    case "subscription_sharing_unsupported_capability":
    case "unsupported_value":
    case "invalid_request_error":
      return 400;
    case "model_not_found":
      return 404;
    case "token_revoked":
    case "invalid_token":
    case "subscription_sharing_invalid_user":
      return 401;
    default:
      return fallback;
  }
}

function streamError(event: Record<string, unknown>): UpstreamError {
  const source =
    event.type === "response.failed" && isObject(event.response)
      ? event.response.error
      : event.error;
  const error = isObject(source) ? source : {};
  const code = typeof error.code === "string" ? error.code : "server_error";
  const message =
    typeof error.message === "string" ? error.message : "OpenAI could not complete the answer.";
  const type = typeof error.type === "string" ? error.type : "api_error";
  return new UpstreamError(statusFor(code, 502), code, message, type);
}

/** Turns Responses API events into text, tool-call pieces and the finish reason. */
export async function* fromResponses(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<Piece> {
  const toolIndex = new Map<unknown, number>(); // output_index or item id -> tool call index
  const argumentsSeen = new Set<number>();
  let calls = 0;
  for await (const event of events) {
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta)
          yield { type: "text", text: event.delta };
        break;
      case "response.output_item.added": {
        const item = isObject(event.item) ? event.item : {};
        if (item.type === "function_call") {
          const index = calls++;
          toolIndex.set(event.output_index, index);
          if (item.id !== undefined) toolIndex.set(item.id, index);
          const id = String(item.call_id ?? item.id ?? `call_${index}`);
          yield { type: "tool_call", index, id, name: String(item.name ?? "") };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = toolIndex.get(event.output_index) ?? toolIndex.get(event.item_id);
        if (index !== undefined && typeof event.delta === "string" && event.delta) {
          argumentsSeen.add(index);
          yield { type: "tool_arguments", index, arguments: event.delta };
        }
        break;
      }
      case "response.output_item.done": {
        // Some streams carry the arguments only in the finished item.
        const item = isObject(event.item) ? event.item : {};
        const index = toolIndex.get(event.output_index) ?? toolIndex.get(item.id);
        if (item.type === "function_call" && index !== undefined && !argumentsSeen.has(index)) {
          if (typeof item.arguments === "string" && item.arguments) {
            argumentsSeen.add(index);
            yield { type: "tool_arguments", index, arguments: item.arguments };
          }
        }
        break;
      }
      case "response.completed": {
        const response = isObject(event.response) ? event.response : {};
        const used = usage(response.usage);
        yield {
          type: "done",
          finish: calls ? "tool_calls" : "stop",
          ...(used ? { usage: used } : {}),
        };
        return;
      }
      case "response.incomplete": {
        const response = isObject(event.response) ? event.response : {};
        const details = isObject(response.incomplete_details) ? response.incomplete_details : {};
        const used = usage(response.usage);
        yield {
          type: "done",
          finish: details.reason === "content_filter" ? "content_filter" : "length",
          ...(used ? { usage: used } : {}),
        };
        return;
      }
      case "error":
      case "response.failed":
        throw streamError(event);
    }
  }
  throw new UpstreamError(
    502,
    "stream_interrupted",
    "OpenAI's answer ended before it was complete.",
  );
}
