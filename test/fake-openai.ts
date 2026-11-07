// A fake OpenAI for tests: the sign-in service (discovery, keys, authorization codes, token
// rotation, revocation) and the API with the plan's token (model catalog, streamed Responses).

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ResponsesScript =
  | { events: Record<string, unknown>[]; endEarly?: boolean }
  | { status: number; body: unknown };

interface Grant {
  clientId: string;
  challenge: string;
  redirectUri: string;
  nonce: string;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signJwt(claims: Record<string, unknown>, key: KeyObject, kid = "k1"): string {
  const head = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64(claims)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

export const textEvents = (...deltas: string[]): Record<string, unknown>[] => [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
  ...deltas.map((delta) => ({ type: "response.output_text.delta", output_index: 0, delta })),
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    },
  },
];

export const limitEvents = (): Record<string, unknown>[] => [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "subscription_sharing_usage_limit_exceeded",
      message: "The ChatGPT user has reached their Subscription Sharing usage limit.",
    },
  },
  { type: "response.failed", response: { id: "resp_1", status: "failed" } },
];

export class FakeOpenAI {
  readonly server: Server;
  base = "";
  readonly #key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  /** Another key, to sign ID tokens the gateway must reject. */
  readonly #wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  signWith: KeyObject = this.#key.privateKey;

  /** Signs ID tokens with a key that is not in the published key set (or back with the right one). */
  useForeignKey(foreign: boolean): void {
    this.signWith = foreign ? this.#wrongKey : this.#key.privateKey;
  }

  /** Invalidates every refresh token issued so far, as revoking the app in ChatGPT would. */
  revokeAllRefresh(): void {
    for (const token of this.#refresh.keys()) this.revoked.add(token);
  }
  readonly subject = "user-1";
  readonly email = "owner@example.com";
  clientId = "app_registered";
  expiresIn = 3600;
  /** Seconds before expiry from which a refresh is allowed (OpenAI: 360). */
  refreshWindow = 360;
  scope = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
  readonly #codes = new Map<string, Grant>();
  readonly #refresh = new Map<string, string>(); // refresh token -> client id
  readonly #access = new Set<string>();
  readonly revoked = new Set<string>();
  tokenRequests: URLSearchParams[] = [];
  responsesRequests: Record<string, unknown>[] = [];
  responses: ResponsesScript | ((body: Record<string, unknown>) => ResponsesScript) = {
    events: textEvents("Hel", "lo"),
  };
  catalog = [
    { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list" },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Review", visibility: "hide" },
  ];

  constructor() {
    this.server = createServer((req, res) => {
      this.#handle(req)
        .then(({ status, body, sse }) => {
          if (sse) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of sse.events)
              res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
            return;
          }
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        })
        .catch((error: Error) => res.writeHead(500).end(error.message));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get apiBase(): string {
    return `${this.base}/v1`;
  }

  /** What the browser does: the user signs in and OpenAI redirects to the app's callback. */
  approve(authorizationUrl: string, extra: Record<string, string> = {}): string {
    const url = new URL(authorizationUrl);
    const p = url.searchParams;
    const dynamic = p.get("client_id") === "dynamic_agent_client";
    const code = randomBytes(8).toString("hex");
    this.#codes.set(code, {
      clientId: dynamic ? this.clientId : String(p.get("client_id")),
      challenge: String(p.get("code_challenge")),
      redirectUri: String(p.get("redirect_uri")),
      nonce: String(p.get("nonce")),
    });
    const callback = new URL(String(p.get("redirect_uri")));
    callback.search = new URLSearchParams({
      code,
      state: String(p.get("state")),
      ...(dynamic ? { client_id: this.clientId } : {}),
      ...extra,
    }).toString();
    return callback.toString();
  }

  #tokens(clientId: string, nonce?: string): Record<string, unknown> {
    const access = `at-${randomBytes(6).toString("hex")}`;
    const refresh = `rt-${randomBytes(6).toString("hex")}`;
    this.#access.add(access);
    this.#refresh.set(refresh, clientId);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: signJwt(
        {
          iss: this.base,
          sub: this.subject,
          aud: clientId,
          iat: now,
          exp: now + 3600,
          email: this.email,
          ...(nonce ? { nonce } : {}),
        },
        this.signWith,
      ),
      token_type: "Bearer",
      expires_in: this.expiresIn,
      scope: this.scope,
      earliest_refresh_at: now + this.expiresIn - this.refreshWindow,
    };
  }

  async #handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body?: unknown; sse?: { events: Record<string, unknown>[] } }> {
    const url = new URL(req.url ?? "/", this.base);
    let text = "";
    for await (const chunk of req) text += chunk;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return {
          status: 200,
          body: {
            issuer: this.base,
            authorization_endpoint: `${this.base}/oauth/authorize`,
            token_endpoint: `${this.base}/oauth/token`,
            revocation_endpoint: `${this.base}/oauth/revoke`,
            jwks_uri: `${this.base}/.well-known/jwks.json`,
          },
        };
      case "/.well-known/jwks.json":
        return {
          status: 200,
          body: {
            keys: [{ ...this.#key.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }],
          },
        };
      case "/oauth/token": {
        const form = new URLSearchParams(text);
        this.tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          const grant = this.#codes.get(String(form.get("code")));
          this.#codes.delete(String(form.get("code")));
          const verifier = String(form.get("code_verifier"));
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            !grant ||
            grant.challenge !== challenge ||
            grant.clientId !== form.get("client_id") ||
            grant.redirectUri !== form.get("redirect_uri")
          ) {
            return {
              status: 400,
              body: { error: "invalid_grant", error_description: "Bad code." },
            };
          }
          return { status: 200, body: this.#tokens(grant.clientId, grant.nonce) };
        }
        const token = String(form.get("refresh_token"));
        const clientId = this.#refresh.get(token);
        if (!clientId || this.revoked.has(token) || clientId !== form.get("client_id")) {
          return {
            status: 400,
            body: {
              error: "invalid_grant",
              error_description:
                "The refresh token has been invalidated. A fresh sign-in is required.",
            },
          };
        }
        this.#refresh.delete(token); // rotation: the old refresh token is spent
        return { status: 200, body: this.#tokens(clientId) };
      }
      case "/oauth/revoke": {
        const form = new URLSearchParams(text);
        const token = String(form.get("token"));
        this.revoked.add(token);
        this.#refresh.delete(token);
        for (const access of this.#access) this.revoked.add(access);
        return { status: 200, body: {} };
      }
    }
    if (!this.#access.has(bearer) || this.revoked.has(bearer)) {
      return {
        status: 401,
        body: {
          error: {
            message: "Encountered invalidated oauth token for user, failing request",
            type: null,
            code: "token_revoked",
            param: null,
          },
        },
      };
    }
    if (url.pathname === "/v1/models") return { status: 200, body: { models: this.catalog } };
    if (url.pathname === "/v1/responses") {
      const body = JSON.parse(text) as Record<string, unknown>;
      this.responsesRequests.push(body);
      const script = typeof this.responses === "function" ? this.responses(body) : this.responses;
      if ("status" in script) return { status: script.status, body: script.body };
      return { status: 200, sse: { events: script.events } };
    }
    return { status: 404, body: { detail: "Not Found" } };
  }
}
