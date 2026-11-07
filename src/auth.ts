// Sign in with ChatGPT: OAuth 2.0 authorization code + PKCE + OpenID Connect, as OpenAI documents it
// for open-source apps (https://developers.openai.com/siwc/token-sharing-open-source). The client
// registers itself on the first sign-in (`client_id=dynamic_agent_client`); the issued client id
// comes back with the authorization code and is reused for later sign-ins.

import { createHash, randomBytes } from "node:crypto";
import { type IdClaims, type Jwk, TokenError, tokenHeader, verifyIdToken } from "./jwt.ts";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_API = "https://api.openai.com/v1";
export const SHARING_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${SHARING_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
export const CALLBACK_PATH = "/auth/callback";

/** Refresh errors after which only a new sign-in helps (OpenAI's errors-and-recovery page). */
const TERMINAL = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

export class AuthError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.retryable = retryable;
  }
  /** The saved sign-in can no longer be used: the user has to sign in again. */
  get terminal(): boolean {
    return TERMINAL.has(this.code);
  }
}

export interface Endpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Milliseconds since the epoch; refreshing earlier is refused. */
  earliestRefreshAt?: number;
  scopes: string[];
}

export interface PendingAuthorization {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The saved client id, or undefined when this sign-in registers the app. */
  clientId?: string;
}

export interface CallbackResult {
  code: string;
  clientId: string;
}

export interface Identity {
  subject: string;
  email?: string;
  name?: string;
}

const random = () => randomBytes(32).toString("base64url");

async function request(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new AuthError("network_error", "Could not reach OpenAI's sign-in service.", true);
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function oauthError(body: unknown, status: number): AuthError {
  const data = isObject(body) ? body : {};
  const nested = isObject(data.error) ? data.error : undefined;
  const code = String(
    (typeof data.error === "string" ? data.error : nested?.code) ?? `http_${status}`,
  );
  const message = String(
    data.error_description ?? nested?.message ?? `OpenAI's sign-in service answered ${status}.`,
  );
  return new AuthError(code, message, status >= 500 || status === 429);
}

/** Parses an epoch value in seconds (number or numeric string) or an ISO date to milliseconds. */
function epochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string" && value) {
    const number = Number(value);
    if (Number.isFinite(number)) return number * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function tokenSet(data: Record<string, unknown>, previousScopes: string[] = []): TokenSet {
  const scope = typeof data.scope === "string" ? data.scope : previousScopes.join(" ");
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.expires_in !== "number" ||
    data.expires_in <= 0 ||
    String(data.token_type ?? "").toLowerCase() !== "bearer"
  ) {
    throw new AuthError("invalid_token_response", "OpenAI returned incomplete credentials.");
  }
  const earliest = epochMs(data.earliest_refresh_at);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" && data.refresh_token
      ? { refreshToken: data.refresh_token }
      : {}),
    ...(typeof data.id_token === "string" && data.id_token ? { idToken: data.id_token } : {}),
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(earliest !== undefined ? { earliestRefreshAt: earliest } : {}),
    scopes: scope.split(/\s+/).filter(Boolean),
  };
}

export class OpenAIAuth {
  readonly issuer: string;
  readonly resource: string;
  #endpoints: Promise<Endpoints> | undefined;
  #keys: Jwk[] = [];

  constructor(issuer = OPENAI_ISSUER, resource = OPENAI_API) {
    this.issuer = issuer;
    this.resource = resource;
  }

  endpoints(): Promise<Endpoints> {
    this.#endpoints ??= (async () => {
      const response = await request(`${this.issuer}/.well-known/openid-configuration`);
      const data = await json(response);
      if (!response.ok || !isObject(data) || data.issuer !== this.issuer) {
        throw new AuthError(
          "discovery_failed",
          "OpenAI's sign-in configuration is unavailable.",
          true,
        );
      }
      const origin = new URL(this.issuer).origin;
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
        const value = data[key];
        if (typeof value !== "string" || new URL(value).origin !== origin) {
          throw new AuthError("discovery_failed", "OpenAI's sign-in configuration is invalid.");
        }
      }
      return data as unknown as Endpoints;
    })().catch((error: unknown) => {
      this.#endpoints = undefined;
      throw error;
    });
    return this.#endpoints;
  }

  async #key(kid: string | undefined): Promise<Jwk> {
    const find = () => this.#keys.find((key) => kid === undefined || key.kid === kid);
    let key = find();
    if (!key) {
      const response = await request((await this.endpoints()).jwks_uri);
      const data = await json(response);
      if (!response.ok || !isObject(data) || !Array.isArray(data.keys)) {
        throw new AuthError("keys_unavailable", "OpenAI's signing keys are unavailable.", true);
      }
      this.#keys = data.keys.filter(isObject) as Jwk[];
      key = find();
    }
    if (!key) throw new AuthError("invalid_id_token", "The sign-in could not be verified.");
    return key;
  }

  /** Verifies the ID token of a sign-in or a refresh and returns who signed in. */
  async verifyIdentity(idToken: string, clientId: string, nonce?: string): Promise<Identity> {
    let claims: IdClaims;
    try {
      const key = await this.#key(tokenHeader(idToken).kid);
      claims = verifyIdToken(idToken, key, {
        issuer: this.issuer,
        audience: clientId,
        ...(nonce !== undefined ? { nonce } : {}),
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      const reason = error instanceof TokenError ? `: ${error.message}` : "";
      throw new AuthError("invalid_id_token", `The sign-in could not be verified${reason}.`);
    }
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    };
  }

  /** The authorization address to open in a browser, and what is needed to finish the sign-in. */
  async authorize(options: {
    redirectUri: string;
    appName: string;
    clientId?: string;
    loginHint?: string;
  }): Promise<PendingAuthorization> {
    const endpoints = await this.endpoints();
    const state = random();
    const nonce = random();
    const verifier = random();
    const url = new URL(endpoints.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: options.clientId ?? DYNAMIC_CLIENT,
      response_type: "code",
      redirect_uri: options.redirectUri,
      scope: SCOPES,
      resource: this.resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    if (!options.clientId) url.searchParams.set("agent_name_hint", options.appName);
    if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
    return {
      url: url.toString(),
      state,
      nonce,
      verifier,
      redirectUri: options.redirectUri,
      ...(options.clientId ? { clientId: options.clientId } : {}),
    };
  }

  /** Reads the address the browser was sent to after the sign-in (code, state, client id). */
  parseCallback(address: string, pending: PendingAuthorization): CallbackResult {
    let url: URL;
    try {
      url = new URL(address.trim());
    } catch {
      throw new AuthError("invalid_callback", "That is not a web address.");
    }
    const params = url.searchParams;
    if (url.pathname !== CALLBACK_PATH) {
      throw new AuthError("invalid_callback", `Paste the address that contains ${CALLBACK_PATH}.`);
    }
    if (params.getAll("state").length !== 1 || params.get("state") !== pending.state) {
      throw new AuthError(
        "state_mismatch",
        "This address belongs to another sign-in attempt. Use the link shown on this page.",
      );
    }
    const error = params.get("error");
    if (error) {
      const message =
        error === "access_denied"
          ? "The sign-in was cancelled or the permission was not granted."
          : (params.get("error_description") ?? `The sign-in failed (${error}).`);
      throw new AuthError(error, message);
    }
    const code = params.get("code");
    const returned = params.get("client_id");
    const clientId = returned ?? pending.clientId;
    if (!code || params.getAll("code").length !== 1) {
      throw new AuthError("invalid_callback", "The address has no sign-in code.");
    }
    if (
      !clientId ||
      clientId === DYNAMIC_CLIENT ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
      (pending.clientId !== undefined && returned !== null && returned !== pending.clientId)
    ) {
      throw new AuthError(
        "registration_incomplete",
        "OpenAI did not complete the app registration.",
      );
    }
    return { code, clientId };
  }

  async #token(body: URLSearchParams): Promise<Record<string, unknown>> {
    const endpoints = await this.endpoints();
    const response = await request(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    const data = await json(response);
    if (!response.ok) throw oauthError(data, response.status);
    if (!isObject(data))
      throw new AuthError("invalid_token_response", "Unexpected token response.");
    return data;
  }

  /** Exchanges the one-time code for tokens and checks who signed in. */
  async exchange(
    pending: PendingAuthorization,
    callback: CallbackResult,
  ): Promise<{ tokens: TokenSet; identity: Identity }> {
    const data = await this.#token(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: callback.clientId,
        code: callback.code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: this.resource,
      }),
    );
    const tokens = tokenSet(data);
    if (!tokens.idToken)
      throw new AuthError("invalid_id_token", "OpenAI did not say who signed in.");
    if (!tokens.refreshToken) {
      throw new AuthError("invalid_token_response", "OpenAI did not grant offline access.");
    }
    const identity = await this.verifyIdentity(tokens.idToken, callback.clientId, pending.nonce);
    return { tokens, identity };
  }

  /** Renews the access token; the refresh token is rotated (the old one stops working). */
  async refresh(clientId: string, refreshToken: string, scopes: string[]): Promise<TokenSet> {
    const data = await this.#token(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
        resource: this.resource,
      }),
    );
    const tokens = tokenSet(data, scopes);
    return tokens.refreshToken ? tokens : { ...tokens, refreshToken };
  }

  /** Revokes the refresh token, which ends the app's access to the account at once. */
  async revoke(clientId: string, refreshToken: string): Promise<void> {
    const endpoints = await this.endpoints();
    if (!endpoints.revocation_endpoint) {
      throw new AuthError("revocation_unavailable", "OpenAI offers no way to revoke the sign-in.");
    }
    const response = await request(endpoints.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    });
    await response.body?.cancel();
    if (response.status !== 200) {
      throw new AuthError("revocation_failed", `Revoking the sign-in failed (${response.status}).`);
    }
  }
}
