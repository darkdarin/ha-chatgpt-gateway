import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApiServer } from "../src/api.ts";
import { newApiKey } from "../src/apikey.ts";
import { createLogger } from "../src/log.ts";

const key = newApiKey();
const server = createApiServer({ apiKey: () => key, log: createLogger("error", () => {}) });
let base = "";

interface ErrorBody {
  error: { message: string; type: string; code: string | null };
}
const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("a request without the key is refused with an OpenAI-style error", async () => {
  const response = await fetch(`${base}/v1/models`);
  assert.equal(response.status, 401);
  const error = await errorOf(response);
  assert.equal(error.code, "invalid_api_key");
  assert.equal(typeof error.message, "string");
});

test("a signed-out gateway answers 503 not_signed_in", async () => {
  const response = await fetch(`${base}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(response.status, 503);
  assert.equal((await errorOf(response)).code, "not_signed_in");
});

test("paths outside /v1 are not found", async () => {
  const response = await fetch(`${base}/`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 404);
  assert.equal((await errorOf(response)).code, "not_found");
});
