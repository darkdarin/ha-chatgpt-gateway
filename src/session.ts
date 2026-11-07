// The ChatGPT sign-in of the app: kept in <data>/chatgpt/auth.json (owner-only), renewed in the
// background before the access token expires, and offered to the API as a bearer token.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  AuthError,
  CALLBACK_PATH,
  type Identity,
  type OpenAIAuth,
  type PendingAuthorization,
  SHARING_SCOPE,
  type TokenSet,
} from "./auth.ts";
import type { Logger } from "./log.ts";

export type Status = "signed_out" | "signing_in" | "signed_in" | "reauth_required";

interface Saved {
  version: 1;
  status: "signed_out" | "signed_in" | "reauth_required";
  /** The client id OpenAI issued to this installation; reused for every later sign-in. */
  clientId?: string;
  subject?: string;
  email?: string;
  name?: string;
  tokens?: Required<Pick<TokenSet, "accessToken" | "refreshToken">> &
    Pick<TokenSet, "expiresAt" | "earliestRefreshAt" | "scopes">;
}

export interface Problem {
  code: string;
  message: string;
  /** ISO time it happened. */
  at: string;
}

/** What the app page may show: never tokens. */
export interface SessionView {
  status: Status;
  email?: string;
  name?: string;
  /** Plan usage is granted (the `chatgpt.tokens.use.direct` scope). */
  sharing: boolean;
  /** The authorization address while signing in. */
  authUrl?: string;
  expiresAt?: string;
  problem?: Problem;
}

export class NotSignedIn extends Error {
  readonly code = "not_signed_in";
}

export interface SessionOptions {
  dataDir: string;
  auth: OpenAIAuth;
  appName: string;
  /** Loopback port of the sign-in callback (the redirect address OpenAI sends the browser to). */
  callbackPort: number;
  log: Logger;
}

const REFRESH_AHEAD_MS = 5 * 60_000;
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export class Session {
  readonly #options: SessionOptions;
  readonly #dir: string;
  #saved: Saved = { version: 1, status: "signed_out" };
  #pending: PendingAuthorization | undefined;
  #pendingTimer: NodeJS.Timeout | undefined;
  #listener: Server | undefined;
  #refreshing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #retryMs = 30_000;
  #problem: Problem | undefined;
  /** Notified after every change, so pages and logs can follow. */
  onChange: () => void = () => {};

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#dir = join(options.dataDir, "chatgpt");
  }

  get #file(): string {
    return join(this.#dir, "auth.json");
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8")) as Saved;
      if (data.version === 1) this.#saved = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (this.#saved.status === "signed_in" && this.#saved.tokens) {
      this.#options.log.info(`Signed in to ChatGPT${this.#who()}`);
      this.#schedule();
    }
  }

  async #save(): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await chmod(this.#dir, 0o700);
    const temporary = join(this.#dir, `.auth.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(this.#saved), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
    this.onChange();
  }

  #who(): string {
    return this.#saved.email ? ` as ${this.#saved.email}` : "";
  }

  get status(): Status {
    return this.#pending ? "signing_in" : this.#saved.status;
  }

  view(): SessionView {
    const tokens = this.#saved.tokens;
    return {
      status: this.status,
      ...(this.#saved.email ? { email: this.#saved.email } : {}),
      ...(this.#saved.name ? { name: this.#saved.name } : {}),
      sharing: this.#saved.status === "signed_in" && !!tokens?.scopes.includes(SHARING_SCOPE),
      ...(this.#pending ? { authUrl: this.#pending.url } : {}),
      ...(tokens && this.#saved.status === "signed_in"
        ? { expiresAt: new Date(tokens.expiresAt).toISOString() }
        : {}),
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }

  /** Remembers what went wrong last (a reached limit, a failed refresh) for the app page. */
  noteProblem(code: string, message: string): void {
    this.#problem = { code, message, at: new Date().toISOString() };
    this.onChange();
  }

  clearProblem(code?: string): void {
    if (!this.#problem || (code && this.#problem.code !== code)) return;
    this.#problem = undefined;
    this.onChange();
  }

  get #redirectUri(): string {
    return `http://127.0.0.1:${this.#options.callbackPort}${CALLBACK_PATH}`;
  }

  /** Starts a sign-in and returns the address to open in a browser. */
  async startSignIn(): Promise<string> {
    this.cancelSignIn();
    this.#pending = await this.#options.auth.authorize({
      redirectUri: this.#redirectUri,
      appName: this.#options.appName,
      ...(this.#saved.clientId ? { clientId: this.#saved.clientId } : {}),
      ...(this.#saved.email ? { loginHint: this.#saved.email } : {}),
    });
    this.#pendingTimer = setTimeout(() => this.cancelSignIn(), SIGN_IN_TIMEOUT_MS);
    this.#pendingTimer.unref();
    await this.#listen();
    this.onChange();
    return this.#pending.url;
  }

  /**
   * The loopback listener: when the browser runs on the same machine as the app, OpenAI's
   * redirect reaches it directly. Otherwise the user pastes the address on the app page.
   */
  async #listen(): Promise<void> {
    if (this.#listener) return;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.#redirectUri);
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || !this.#pending) {
        res.writeHead(404).end("Not found");
        return;
      }
      this.finishSignIn(url.toString()).then(
        () =>
          res.writeHead(200, { "content-type": "text/plain" }).end("Signed in. Close this tab."),
        (error: Error) => res.writeHead(400, { "content-type": "text/plain" }).end(error.message),
      );
    });
    await new Promise<void>((resolve) => {
      server.once("error", () => resolve()); // port taken: pasting the address still works
      server.listen(this.#options.callbackPort, "127.0.0.1", () => {
        this.#listener = server;
        resolve();
      });
    });
  }

  /** Stops the loopback listener; an answer in progress (the callback itself) still completes. */
  #stopListening(force = false): void {
    this.#listener?.close();
    if (force) this.#listener?.closeAllConnections();
    else this.#listener?.closeIdleConnections();
    this.#listener = undefined;
  }

  cancelSignIn(): void {
    if (!this.#pending) return;
    this.#pending = undefined;
    clearTimeout(this.#pendingTimer);
    this.#stopListening(true);
    this.onChange();
  }

  /** Finishes the sign-in with the address the browser was sent to. */
  async finishSignIn(address: string): Promise<SessionView> {
    const pending = this.#pending;
    if (!pending) throw new AuthError("no_sign_in", "Start the sign-in first.");
    const callback = this.#options.auth.parseCallback(address, pending);
    // The one-time code is used once, whatever happens next.
    this.#pending = undefined;
    clearTimeout(this.#pendingTimer);
    this.#stopListening();
    // Keep the registration even if the rest fails, so a retry does not register the app again.
    if (this.#saved.clientId !== callback.clientId) {
      this.#saved = { ...this.#saved, clientId: callback.clientId };
      await this.#save();
    }
    let result: { tokens: TokenSet; identity: Identity };
    try {
      result = await this.#options.auth.exchange(pending, callback);
    } catch (error) {
      if (error instanceof AuthError && error.code === "invalid_client") {
        delete this.#saved.clientId; // the registration is gone: register again next time
        await this.#save();
      }
      this.onChange();
      throw error;
    }
    const { tokens, identity } = result;
    if (this.#saved.subject && this.#saved.subject !== identity.subject) {
      this.#options.log.info("Signed in with a different ChatGPT account than before");
    }
    this.#saved = {
      version: 1,
      status: "signed_in",
      clientId: callback.clientId,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      ...(identity.name ? { name: identity.name } : {}),
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken as string,
        expiresAt: tokens.expiresAt,
        ...(tokens.earliestRefreshAt !== undefined
          ? { earliestRefreshAt: tokens.earliestRefreshAt }
          : {}),
        scopes: tokens.scopes,
      },
    };
    this.#problem = undefined;
    await this.#save();
    this.#options.log.info(`Signed in to ChatGPT${this.#who()}`);
    if (!tokens.scopes.includes(SHARING_SCOPE)) {
      this.#options.log.warning("Signed in, but the app may not use the ChatGPT plan");
    }
    this.#schedule();
    return this.view();
  }

  /** Revokes the sign-in at OpenAI and forgets the tokens (the app registration stays). */
  async signOut(): Promise<void> {
    this.cancelSignIn();
    clearTimeout(this.#timer);
    const tokens = this.#saved.tokens;
    const clientId = this.#saved.clientId;
    delete this.#saved.tokens;
    this.#saved.status = "signed_out";
    this.#problem = undefined;
    await this.#save();
    if (tokens && clientId) {
      try {
        await this.#options.auth.revoke(clientId, tokens.refreshToken);
      } catch (error) {
        this.noteProblem(
          "revocation_failed",
          `Signed out here, but OpenAI did not confirm it (${(error as Error).message}). ` +
            "Disconnect the app in ChatGPT settings to be sure.",
        );
      }
    }
    this.#options.log.info("Signed out of ChatGPT");
  }

  /** The current access token, renewed first when it is about to expire. */
  async accessToken(): Promise<string> {
    if (this.#saved.status !== "signed_in" || !this.#saved.tokens) {
      throw new NotSignedIn(
        this.#saved.status === "reauth_required"
          ? "The ChatGPT sign-in has expired or was revoked. Sign in again on the app page."
          : "The gateway is not signed in to ChatGPT. Sign in on the app page in Home Assistant.",
      );
    }
    const tokens = this.#saved.tokens;
    const now = Date.now();
    if (tokens.expiresAt - now < 60_000 && (tokens.earliestRefreshAt ?? 0) <= now) {
      await this.refresh();
    } else if (tokens.expiresAt <= now) {
      throw new AuthError(
        "refresh_not_ready",
        "The ChatGPT sign-in is being renewed. Retry.",
        true,
      );
    }
    const current = this.#saved.tokens;
    if (!current || this.#saved.status !== "signed_in") throw new NotSignedIn("Sign in again.");
    return current.accessToken;
  }

  /** Renews the tokens; concurrent callers share one refresh (the refresh token is single-use). */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const saved = this.#saved;
    if (saved.status !== "signed_in" || !saved.tokens || !saved.clientId) return;
    let tokens: TokenSet;
    try {
      tokens = await this.#options.auth.refresh(
        saved.clientId,
        saved.tokens.refreshToken,
        saved.tokens.scopes,
      );
    } catch (error) {
      if (error instanceof AuthError && error.terminal) {
        await this.revoked(error.message);
      } else {
        this.noteProblem("refresh_failed", `Renewing the ChatGPT sign-in failed: ${String(error)}`);
        this.#schedule(this.#retryMs);
        this.#retryMs = Math.min(this.#retryMs * 2, 5 * 60_000);
      }
      throw error;
    }
    // Save the rotated refresh token before anything else: the old one no longer works.
    this.#saved = {
      ...saved,
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? saved.tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.earliestRefreshAt !== undefined
          ? { earliestRefreshAt: tokens.earliestRefreshAt }
          : {}),
        scopes: tokens.scopes,
      },
    };
    await this.#save();
    if (tokens.idToken) {
      try {
        const identity = await this.#options.auth.verifyIdentity(tokens.idToken, saved.clientId);
        if (saved.subject && identity.subject !== saved.subject) {
          await this.revoked("The renewed sign-in belongs to another ChatGPT account.");
          throw new AuthError("account_mismatch", "The renewed sign-in is for another account.");
        }
      } catch (error) {
        if (error instanceof AuthError && error.code === "account_mismatch") throw error;
        // A temporarily unavailable key service does not make the renewed tokens invalid.
        this.#options.log.warning(`Could not verify the renewed sign-in: ${String(error)}`);
      }
    }
    this.#retryMs = 30_000;
    this.clearProblem("refresh_failed");
    this.#options.log.debug("Renewed the ChatGPT access token");
    this.#schedule();
  }

  /** The sign-in no longer works (revoked, expired): forget the tokens, ask to sign in again. */
  async revoked(reason: string): Promise<void> {
    if (this.#saved.status !== "signed_in") return;
    clearTimeout(this.#timer);
    delete this.#saved.tokens;
    this.#saved.status = "reauth_required";
    this.noteProblem("reauth_required", reason);
    await this.#save();
    this.#options.log.warning(`The ChatGPT sign-in no longer works: ${reason}`);
  }

  /** Plans the next refresh: 5 minutes before expiry, but not before OpenAI allows it. */
  #schedule(delayMs?: number): void {
    clearTimeout(this.#timer);
    const tokens = this.#saved.tokens;
    if (!tokens || this.#saved.status !== "signed_in") return;
    const at = Math.max(
      tokens.expiresAt - REFRESH_AHEAD_MS,
      (tokens.earliestRefreshAt ?? 0) + 1000,
    );
    const delay = delayMs ?? Math.max(at - Date.now(), 1000);
    this.#timer = setTimeout(() => {
      this.refresh().catch(() => {}); // reported through noteProblem and the log
    }, delay);
    this.#timer.unref();
  }

  close(): void {
    clearTimeout(this.#timer);
    this.cancelSignIn();
  }
}
