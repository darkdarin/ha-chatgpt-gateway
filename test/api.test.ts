import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { createApiServer } from "../src/api.ts";
import { newApiKey } from "../src/apikey.ts";
import type { Session } from "../src/session.ts";
import { Upstream } from "../src/upstream.ts";
import { FakeOpenAI, limitEvents, textEvents } from "./fake-openai.ts";
import { makeSession, quiet, signIn } from "./helpers.ts";

const fake = new FakeOpenAI();
const key = newApiKey();
let session: Session;
let server: Server;
let base = "";

interface ErrorBody {
  error: { message: string; type: string; code: string | null; param: string | null };
}
type Chunk = { choices: { delta: Record<string, unknown>; finish_reason: string | null }[] };
const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;
const auth = { authorization: `Bearer ${key}` };
const post = (body: unknown) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ask = (extra: Record<string, unknown> = {}) =>
  post({ model: "gpt-6-luna", messages: [{ role: "user", content: "2+2?" }], ...extra });

/** The `data:` payloads of an SSE body. */
async function events(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice(6))
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

before(async () => {
  await fake.start();
  session = await makeSession(fake);
  server = createApiServer({
    apiKey: () => key,
    session,
    upstream: new Upstream(fake.apiBase),
    log: quiet,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  session.close();
  server.close();
  await fake.stop();
});
beforeEach(async () => {
  fake.responses = { events: textEvents("Че", "тыре") };
  if (session.status !== "signed_in") await signIn(session, fake);
});

test("without the key a request is refused with an OpenAI-style error", async () => {
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 401);
  assert.equal((await errorOf(response)).code, "invalid_api_key");
  const wrong = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${newApiKey()}` },
  });
  assert.equal(wrong.status, 401);
});

test("the models of the plan are listed in OpenAI's format", async () => {
  const response = await fetch(`${base}/v1/models`, { headers: auth });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { object: string; data: { id: string }[] };
  assert.equal(body.object, "list");
  assert.deepEqual(
    body.data.map((m) => m.id),
    ["gpt-6-luna", "gpt-6.1-sol"],
  );
  const one = await fetch(`${base}/v1/models/gpt-6-luna`, { headers: auth });
  assert.equal(((await one.json()) as { id: string }).id, "gpt-6-luna");
  const missing = await fetch(`${base}/v1/models/gpt-4o`, { headers: auth });
  assert.equal(missing.status, 404);
});

test("a streamed answer comes as chat.completion.chunk deltas, then [DONE]", async () => {
  const response = await ask({ stream: true, temperature: 0.2, max_tokens: 50 });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
  const all = await events(response);
  assert.equal(all.at(-1), "[DONE]");
  const chunks = all.slice(0, -1) as (Chunk & { object: string })[];
  assert.ok(chunks.every((c) => c.object === "chat.completion.chunk"));
  assert.equal(chunks[0]?.choices[0]?.delta.role, "assistant");
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? "").join(""), "Четыре");
  assert.equal(chunks.at(-1)?.choices[0]?.finish_reason, "stop");
  // the plan does not accept these: they must not reach OpenAI
  const sent = fake.responsesRequests.at(-1) ?? {};
  assert.equal("temperature" in sent, false);
  assert.equal("max_output_tokens" in sent, false);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
});

test("usage is added as a last chunk when stream_options.include_usage is set", async () => {
  const all = await events(await ask({ stream: true, stream_options: { include_usage: true } }));
  const usage = all.slice(0, -1).at(-1) as { choices: unknown[]; usage: { total_tokens: number } };
  assert.deepEqual(usage.choices, []);
  assert.equal(usage.usage.total_tokens, 13);
});

test("a non-streamed answer is one chat.completion", async () => {
  const response = await ask();
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    choices: { message: { role: string; content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number };
  };
  assert.equal(body.object, "chat.completion");
  assert.deepEqual(body.choices[0]?.message, { role: "assistant", content: "Четыре" });
  assert.equal(body.choices[0]?.finish_reason, "stop");
  assert.equal(body.usage.prompt_tokens, 10);
});

test("tool calls stream out like OpenAI's, with finish_reason tool_calls", async () => {
  fake.responses = {
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "remember" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"fact":' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"x"}' },
      { type: "response.completed", response: {} },
    ],
  };
  const tool = { type: "function", function: { name: "remember", parameters: { type: "object" } } };
  const all = await events(await ask({ stream: true, tools: [tool] }));
  const deltas = all.slice(0, -1).map((c) => (c as Chunk).choices[0]);
  assert.deepEqual(deltas[1]?.delta, {
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "remember", arguments: "" } },
    ],
  });
  assert.deepEqual(deltas[2]?.delta, {
    tool_calls: [{ index: 0, function: { arguments: '{"fact":' } }],
  });
  assert.equal(deltas.at(-1)?.finish_reason, "tool_calls");
  assert.deepEqual((fake.responsesRequests.at(-1)?.tools as unknown[] | undefined)?.[0], {
    type: "function",
    name: "remember",
    parameters: { type: "object" },
    strict: false,
  });
});

test("the usage limit (an event inside HTTP 200) becomes HTTP 429 and shows on the page", async () => {
  fake.responses = { events: limitEvents() };
  const response = await ask({ stream: true });
  assert.equal(response.status, 429);
  assert.equal((await errorOf(response)).code, "subscription_sharing_usage_limit_exceeded");
  assert.equal(session.view().problem?.code, "subscription_sharing_usage_limit_exceeded");
  // the next good answer clears it
  fake.responses = { events: textEvents("ok") };
  assert.equal((await ask()).status, 200);
  assert.equal(session.view().problem, undefined);
});

test("an error after the answer has started arrives as an error event", async () => {
  fake.responses = {
    events: [
      { type: "response.output_text.delta", delta: "Нач" },
      { type: "error", error: { code: "server_error", message: "Something broke" } },
    ],
  };
  const response = await ask({ stream: true });
  assert.equal(response.status, 200);
  const all = await events(response);
  assert.equal((all.at(-1) as ErrorBody).error.code, "server_error");
  assert.equal(all.includes("[DONE]"), false);
});

test("OpenAI's errors before the stream keep their status and message", async () => {
  fake.responses = {
    status: 400,
    body: { error: { code: "model_not_found", message: "The 'gpt-4o' model is not supported." } },
  };
  const response = await ask({ model: "gpt-4o" });
  assert.equal(response.status, 400);
  assert.equal((await errorOf(response)).code, "model_not_found");
  fake.responses = { status: 400, body: { detail: "Unsupported parameter: temperature" } };
  const detail = await ask();
  assert.equal(detail.status, 400);
  assert.equal((await errorOf(detail)).message, "Unsupported parameter: temperature");
});

test("a bad request is refused before reaching OpenAI", async () => {
  const count = fake.responsesRequests.length;
  const response = await post({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "x" }],
    n: 3,
  });
  assert.equal(response.status, 400);
  assert.equal((await errorOf(response)).param, "n");
  const broken = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: auth,
    body: "{",
  });
  assert.equal(broken.status, 400);
  assert.equal(fake.responsesRequests.length, count);
});

test("a token OpenAI has revoked signs the gateway out: 503 not_signed_in", async () => {
  fake.revokeAllRefresh();
  fake.revoked.add(await session.accessToken());
  const response = await ask();
  assert.equal(response.status, 503);
  assert.equal((await errorOf(response)).code, "not_signed_in");
  assert.equal(session.view().status, "reauth_required");
  const models = await fetch(`${base}/v1/models`, { headers: auth });
  assert.equal(models.status, 503);
});
