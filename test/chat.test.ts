import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientError, fromResponses, type Piece, toResponses } from "../src/chat.ts";
import { UpstreamError } from "../src/upstream.ts";
import { limitEvents, textEvents } from "./fake-openai.ts";

async function collect(events: Record<string, unknown>[]): Promise<Piece[]> {
  const pieces: Piece[] = [];
  async function* source() {
    yield* events;
  }
  for await (const piece of fromResponses(source())) pieces.push(piece);
  return pieces;
}

test("system messages become instructions, the rest input; unsupported options are dropped", () => {
  const { body, stream, includeUsage, model } = toResponses({
    model: "gpt-6-luna",
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.3,
    max_tokens: 200,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "developer", content: [{ type: "text", text: "Answer in Russian." }] },
      { role: "user", content: [{ type: "text", text: "2+2?" }] },
    ],
  });
  assert.equal(model, "gpt-6-luna");
  assert.equal(stream, true);
  assert.equal(includeUsage, true);
  assert.deepEqual(body, {
    model: "gpt-6-luna",
    instructions: "Be brief.\n\nAnswer in Russian.",
    input: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: [{ type: "input_text", text: "2+2?" }] },
    ],
    reasoning: { effort: "none" },
  });
});

test("function tools, tool calls and their results pass through", () => {
  const { body } = toResponses({
    model: "m",
    tools: [
      {
        type: "function",
        function: {
          name: "remember",
          description: "Keep a fact",
          parameters: { type: "object", properties: { fact: { type: "string" } } },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "remember" } },
    messages: [
      { role: "user", content: "Remember that the door code is 1234" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "remember", arguments: '{"fact":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "saved" },
    ],
  });
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "remember",
      description: "Keep a fact",
      parameters: { type: "object", properties: { fact: { type: "string" } } },
      strict: false,
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: "function", name: "remember" });
  assert.deepEqual(body.input, [
    { role: "user", content: "Remember that the door code is 1234" },
    { type: "function_call", call_id: "call_1", name: "remember", arguments: '{"fact":"x"}' },
    { type: "function_call_output", call_id: "call_1", output: "saved" },
  ]);
});

test("requests the gateway cannot serve are refused with the parameter named", () => {
  const refused = (request: unknown, param: string | null) =>
    assert.throws(
      () => toResponses(request),
      (error: unknown) => {
        assert.ok(error instanceof ClientError);
        assert.equal(error.param, param);
        return true;
      },
    );
  refused({ messages: [{ role: "user", content: "x" }] }, "model");
  refused({ model: "m", messages: [] }, "messages");
  refused({ model: "m", messages: [{ role: "user", content: "x" }], n: 2 }, "n");
  refused({ model: "m", messages: [{ role: "user", content: "x" }], functions: [] }, "functions");
  refused({ model: "m", messages: [{ role: "robot", content: "x" }] }, "messages[0].role");
  refused({ model: "m", messages: [{ role: "system", content: "only rules" }] }, "messages");
  refused(
    { model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }] },
    "tools[0]",
  );
});

test("text deltas and the finish come through, with usage", async () => {
  const pieces = await collect(textEvents("Че", "тыре"));
  assert.deepEqual(pieces, [
    { type: "text", text: "Че" },
    { type: "text", text: "тыре" },
    {
      type: "done",
      finish: "stop",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  ]);
});

test("function calls become tool-call pieces with streamed arguments", async () => {
  const pieces = await collect([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1" },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "remember" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_1",
      delta: '{"fa',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_1",
      delta: 'ct":1}',
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", arguments: '{"fact":1}' },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "function_call", id: "fc_2", call_id: "call_b", name: "forget" },
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      item: { type: "function_call", id: "fc_2", arguments: "{}" },
    },
    { type: "response.completed", response: {} },
  ]);
  assert.deepEqual(pieces, [
    { type: "tool_call", index: 0, id: "call_a", name: "remember" },
    { type: "tool_arguments", index: 0, arguments: '{"fa' },
    { type: "tool_arguments", index: 0, arguments: 'ct":1}' },
    { type: "tool_call", index: 1, id: "call_b", name: "forget" },
    { type: "tool_arguments", index: 1, arguments: "{}" },
    { type: "done", finish: "tool_calls" },
  ]);
});

test("the plan's usage limit inside the stream is a 429 error", async () => {
  await assert.rejects(collect(limitEvents()), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 429);
    assert.equal(error.code, "subscription_sharing_usage_limit_exceeded");
    return true;
  });
});

test("a stream that ends without completion is an error", async () => {
  await assert.rejects(collect(textEvents("a").slice(0, -1)), { code: "stream_interrupted" });
});
