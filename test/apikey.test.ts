import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAuthorized, loadOrCreateApiKey, newApiKey, saveApiKey } from "../src/apikey.ts";

const tempDir = () => mkdtemp(join(tmpdir(), "gateway-"));

test("the first start creates a private key, later starts reuse it", async () => {
  const dir = await tempDir();
  const key = await loadOrCreateApiKey(dir);
  assert.match(key, /^cgw-[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(join(dir, "api_key"))).mode & 0o777, 0o600);
  assert.equal(await loadOrCreateApiKey(dir), key);
});

test("a regenerated key replaces the saved one", async () => {
  const dir = await tempDir();
  const first = await loadOrCreateApiKey(dir);
  const second = newApiKey();
  await saveApiKey(dir, second);
  assert.notEqual(first, second);
  assert.equal((await readFile(join(dir, "api_key"), "utf8")).trim(), second);
  assert.equal(await loadOrCreateApiKey(dir), second);
});

test("only the exact bearer key is authorized", () => {
  const key = newApiKey();
  assert.equal(isAuthorized(`Bearer ${key}`, key), true);
  assert.equal(isAuthorized(`bearer ${key}`, key), true);
  assert.equal(isAuthorized(undefined, key), false);
  assert.equal(isAuthorized(key, key), false);
  assert.equal(isAuthorized(`Bearer ${key}x`, key), false);
  assert.equal(isAuthorized(`Bearer ${newApiKey()}`, key), false);
  assert.equal(isAuthorized("Bearer ", key), false);
});
