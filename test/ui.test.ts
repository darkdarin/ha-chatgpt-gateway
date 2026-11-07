import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { newApiKey } from "../src/apikey.ts";
import type { Session } from "../src/session.ts";
import { createUiServer } from "../src/ui.ts";
import { Upstream } from "../src/upstream.ts";
import { FakeOpenAI } from "./fake-openai.ts";
import { makeSession, quiet } from "./helpers.ts";

const fake = new FakeOpenAI();
let session: Session;
let key = newApiKey();
const servers: Server[] = [];

async function serve(trustAll: boolean): Promise<string> {
  const server = createUiServer({
    session,
    upstream: new Upstream(fake.apiBase),
    apiKey: () => key,
    regenerateKey: async () => {
      key = newApiKey();
      return key;
    },
    internalUrl: "http://d9eec4fe-chatgpt-gateway:8780/v1",
    apiPort: 8780,
    version: "0.1.0",
    trustAll,
    log: quiet,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface State {
  session: { status: string; authUrl?: string; email?: string };
  models: { slug: string }[] | null;
  apiKey: string;
  internalUrl: string;
}

before(async () => {
  await fake.start();
  session = await makeSession(fake);
});
after(async () => {
  session.close();
  for (const server of servers) server.close();
  await fake.stop();
});

test("only the Supervisor's Ingress proxy may open the page", async () => {
  const base = await serve(false);
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 403);
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
});

test("the page signs in, lists the models and shows how to connect", async () => {
  const base = await serve(true);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ChatGPT Gateway/);

  const postJson = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let state = (await (await fetch(`${base}/api/state`)).json()) as State;
  assert.equal(state.session.status, "signed_out");
  assert.equal(state.models, null);
  assert.equal(state.internalUrl, "http://d9eec4fe-chatgpt-gateway:8780/v1");

  const { authUrl } = (await (await postJson("/api/signin")).json()) as { authUrl: string };
  const wrong = await postJson("/api/callback", { address: "http://127.0.0.1/elsewhere" });
  assert.equal(wrong.status, 400);
  const done = await postJson("/api/callback", { address: fake.approve(authUrl) });
  assert.equal(done.status, 200);
  state = (await done.json()) as State;
  assert.equal(state.session.status, "signed_in");
  assert.equal(state.session.email, fake.email);
  assert.deepEqual(
    state.models?.map((m) => m.slug),
    ["gpt-6-luna", "gpt-6.1-sol"],
  );

  const before = state.apiKey;
  state = (await (await postJson("/api/key")).json()) as State;
  assert.notEqual(state.apiKey, before);

  state = (await (await postJson("/api/signout")).json()) as State;
  assert.equal(state.session.status, "signed_out");
});

test("actions need JSON, so a form on another site cannot trigger them", async () => {
  const base = await serve(true);
  const response = await fetch(`${base}/api/signout`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "x=1",
  });
  assert.equal(response.status, 415);
});
