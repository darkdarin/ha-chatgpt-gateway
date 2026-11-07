import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AuthError } from "../src/auth.ts";
import { NotSignedIn } from "../src/session.ts";
import { FakeOpenAI } from "./fake-openai.ts";
import { makeSession, signIn, tempDir } from "./helpers.ts";

const fake = new FakeOpenAI();
before(() => fake.start());
after(() => fake.stop());

test("signing in by pasting the callback address registers the app and keeps the tokens private", async () => {
  const dir = await tempDir();
  const session = await makeSession(fake, dir);
  const url = new URL(await session.startSignIn());
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "ChatGPT Gateway");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(String(url.searchParams.get("scope")), /chatgpt\.tokens\.use\.direct/);
  assert.equal(session.view().status, "signing_in");

  const view = await session.finishSignIn(fake.approve(url.toString()));
  assert.equal(view.status, "signed_in");
  assert.equal(view.email, fake.email);
  assert.equal(view.sharing, true);
  assert.equal(JSON.stringify(view).includes("at-"), false, "the view never carries tokens");
  assert.equal((await stat(join(dir, "chatgpt"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, "chatgpt", "auth.json"))).mode & 0o777, 0o600);

  // a restart keeps the sign-in
  const again = await makeSession(fake, dir);
  assert.equal(again.view().status, "signed_in");
  assert.match(await again.accessToken(), /^at-/);
  session.close();
  again.close();
});

test("a later sign-in reuses the issued client instead of registering again", async () => {
  const session = await makeSession(fake);
  await signIn(session, fake);
  await session.signOut();
  const url = new URL(await session.startSignIn());
  assert.equal(url.searchParams.get("client_id"), fake.clientId);
  assert.equal(url.searchParams.has("agent_name_hint"), false);
  assert.equal(url.searchParams.get("login_hint"), fake.email);
  await session.finishSignIn(fake.approve(url.toString()));
  assert.equal(session.view().status, "signed_in");
  session.close();
});

test("the browser on the same machine reaches the loopback listener directly", async () => {
  const session = await makeSession(fake);
  const callback = fake.approve(await session.startSignIn());
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.equal(session.view().status, "signed_in");
  session.close();
});

test("an address from another attempt or without a code is refused, the sign-in stays open", async () => {
  const session = await makeSession(fake);
  const url = await session.startSignIn();
  const other = new URL(fake.approve(url));
  other.searchParams.set("state", "someone-else");
  await assert.rejects(session.finishSignIn(other.toString()), { code: "state_mismatch" });
  await assert.rejects(session.finishSignIn("not an address"), { code: "invalid_callback" });
  const denied = fake.approve(url, { error: "access_denied" });
  const deniedUrl = new URL(denied);
  deniedUrl.searchParams.delete("code");
  await assert.rejects(session.finishSignIn(deniedUrl.toString()), { code: "access_denied" });
  assert.equal(session.view().status, "signing_in");
  session.close();
});

test("an ID token signed with a foreign key is rejected", async () => {
  const session = await makeSession(fake);
  fake.useForeignKey(true);
  try {
    await assert.rejects(signIn(session, fake), { code: "invalid_id_token" });
    assert.equal(session.view().status, "signed_out");
  } finally {
    fake.useForeignKey(false);
  }
  session.close();
});

test("a refresh rotates the tokens and saves the new refresh token", async () => {
  const dir = await tempDir();
  const session = await makeSession(fake, dir);
  await signIn(session, fake);
  const before = JSON.parse(await readFile(join(dir, "chatgpt", "auth.json"), "utf8"));
  await session.refresh();
  const saved = JSON.parse(await readFile(join(dir, "chatgpt", "auth.json"), "utf8"));
  assert.notEqual(saved.tokens.refreshToken, before.tokens.refreshToken);
  assert.notEqual(saved.tokens.accessToken, before.tokens.accessToken);
  assert.equal(await session.accessToken(), saved.tokens.accessToken);
  session.close();
});

test("a token about to expire is renewed on use; concurrent requests share one refresh", async () => {
  fake.expiresIn = 30;
  fake.refreshWindow = 60; // allowed at once
  try {
    const session = await makeSession(fake);
    await signIn(session, fake);
    const first = fake.tokenRequests.length;
    const [a, b] = await Promise.all([session.accessToken(), session.accessToken()]);
    assert.equal(a, b);
    assert.equal(fake.tokenRequests.length, first + 1);
    session.close();
  } finally {
    fake.expiresIn = 3600;
    fake.refreshWindow = 360;
  }
});

test("a refresh refused as invalid_grant turns the session into reauth_required", async () => {
  const session = await makeSession(fake);
  await signIn(session, fake);
  fake.revokeAllRefresh();
  await assert.rejects(
    session.refresh(),
    (error: unknown) => error instanceof AuthError && error.terminal,
  );
  assert.equal(session.view().status, "reauth_required");
  assert.equal(session.view().problem?.code, "reauth_required");
  await assert.rejects(session.accessToken(), NotSignedIn);
  session.close();
});

test("signing out revokes the refresh token at OpenAI", async () => {
  const session = await makeSession(fake);
  await signIn(session, fake);
  const token = await session.accessToken();
  await session.signOut();
  assert.equal(fake.revoked.has(token), true);
  assert.equal(session.view().status, "signed_out");
  session.close();
});
