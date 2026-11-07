import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fromResponses, type Piece } from "../src/chat.ts";
import type { Session } from "../src/session.ts";
import { Upstream, UpstreamError } from "../src/upstream.ts";
import { WsPool } from "../src/ws.ts";
import { FakeOpenAI, limitEvents, textEvents } from "./fake-openai.ts";
import { makeSession, quiet, signIn } from "./helpers.ts";

const fake = new FakeOpenAI();
let session: Session;
let pool: WsPool;
let upstream: Upstream;

const body = { model: "gpt-6-luna", input: [{ role: "user", content: "2+2?" }] };

async function answer(signal = new AbortController().signal): Promise<string> {
  let text = "";
  for await (const piece of fromResponses(
    upstream.respond(await session.accessToken(), body, signal),
  )) {
    if ((piece as Piece).type === "text") text += (piece as { text: string }).text;
  }
  return text;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const start = Date.now(); !check(); await sleep(10)) {
    if (Date.now() - start > ms) throw new Error("timed out");
  }
}

before(async () => {
  await fake.start();
  session = await makeSession(fake);
  await signIn(session, fake);
});
beforeEach(() => {
  fake.websocket = true;
  fake.responses = { events: textEvents("Че", "тыре") };
  pool = new WsPool({ url: `${fake.apiBase.replace(/^http/, "ws")}/responses`, log: quiet });
  upstream = new Upstream(fake.apiBase, pool);
});
afterEach(() => pool.close());
after(async () => {
  session.close();
  await fake.stop();
});

test("answers go over one kept-open WebSocket, without stream or store from the client", async () => {
  pool.warm(session.currentToken); // as the app does on sign-in
  await until(() => pool.size === 1);
  const connections = fake.wsConnections;
  const requests = fake.wsRequests;
  assert.equal(await answer(), "Четыре");
  assert.equal(await answer(), "Четыре");
  assert.equal(fake.wsRequests, requests + 2);
  assert.equal(fake.wsConnections, connections, "both answers used the warm connection");
  const sent = fake.responsesRequests.at(-1) ?? {};
  assert.equal(sent.store, false);
  assert.equal("stream" in sent, false);
});

test("warm() opens a connection ahead of the first request", async () => {
  const connections = fake.wsConnections;
  pool.warm(session.currentToken);
  await until(() => pool.size === 1);
  assert.equal(fake.wsConnections, connections + 1);
  await answer();
  assert.equal(fake.wsConnections, connections + 1, "the request used the warm connection");
});

test("a connection the server closes while idle is opened again", async () => {
  pool.warm(session.currentToken);
  await until(() => pool.size === 1);
  const connections = fake.wsConnections;
  fake.dropWebSockets();
  await until(() => fake.wsConnections === connections + 1 && pool.size === 1, 5000);
});

test("a new token replaces the connections of the old one", async () => {
  pool.warm(session.currentToken);
  await until(() => pool.size === 1);
  const connections = fake.wsConnections;
  await session.refresh();
  pool.warm(session.currentToken);
  await until(() => fake.wsConnections === connections + 1 && pool.size === 1);
  assert.equal(await answer(), "Четыре");
});

test("when WebSocket is refused the request goes over HTTP", async () => {
  fake.websocket = false;
  const requests = fake.wsRequests;
  assert.equal(await answer(), "Четыре");
  assert.equal(fake.wsRequests, requests, "nothing went over WebSocket");
  assert.equal(pool.available, false, "WebSocket rests for a while after a failed connection");
  assert.equal(await answer(), "Четыре");
});

test("the usage limit over WebSocket is the same 429 error", async () => {
  fake.responses = { events: limitEvents() };
  await assert.rejects(answer(), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 429);
    return true;
  });
  // the connection that carried an error is not reused for the next answer
  fake.responses = { events: textEvents("ok") };
  assert.equal(await answer(), "ok");
});

test("an error status sent over WebSocket keeps its code", async () => {
  fake.responses = { status: 400, body: { error: { code: "model_not_found", message: "No." } } };
  await assert.rejects(answer(), { code: "model_not_found" });
});

test("a client that goes away closes the connection, so no leftovers reach the next answer", async () => {
  fake.responses = {
    events: [
      { type: "response.output_text.delta", delta: "first" },
      { type: "response.output_text.delta", delta: " second" },
      { type: "response.completed", response: {} },
    ],
  };
  const controller = new AbortController();
  const events = upstream.respond(await session.accessToken(), body, controller.signal);
  const first = await events.next();
  assert.equal((first.value as { delta: string }).delta, "first");
  controller.abort();
  await events.return(undefined);
  await until(() => pool.size === 0);
  fake.responses = { events: textEvents("clean") };
  assert.equal(await answer(), "clean");
});
