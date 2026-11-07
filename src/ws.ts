// The Responses API over WebSocket (`wss://…/v1/responses`, `response.create` messages). With the
// ChatGPT plan's token an answer starts 0.6–0.9 s sooner on an open connection than with one HTTP
// request per turn, so the gateway keeps a connection open and warm. One response at a time per
// connection; a connection belongs to the access token it was opened with.

import type { Logger } from "./log.ts";

/** WebSocket could not serve this request before any event: send it over HTTP instead. */
export class WsUnavailable extends Error {}

const TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);

interface Connection {
  socket: WebSocket;
  token: string;
  busy: boolean;
  openedAt: number;
  /** Receives the events of the response in progress. */
  listener?: (event: Record<string, unknown> | Error) => void;
}

export interface WsPoolOptions {
  /** `wss://api.openai.com/v1/responses` */
  url: string;
  log: Logger;
  /** Idle connections kept open per token (more are opened for concurrent requests). */
  maxIdle?: number;
  connectTimeoutMs?: number;
  /** How long to use HTTP only after a connection failed to open. */
  cooldownMs?: number;
}

export class WsPool {
  readonly #options: Required<WsPoolOptions>;
  readonly #connections = new Set<Connection>();
  #opening = 0;
  #disabledUntil = 0;
  /** The token to keep a warm connection for; undefined when signed out. */
  #warmToken: string | undefined;
  #warmTimer: NodeJS.Timeout | undefined;
  #warmDelayMs = 1000;
  #closed = false;

  constructor(options: WsPoolOptions) {
    this.#options = { maxIdle: 1, connectTimeoutMs: 10_000, cooldownMs: 60_000, ...options };
  }

  /** False for a while after a connection failed to open: requests go over HTTP meanwhile. */
  get available(): boolean {
    return !this.#closed && Date.now() >= this.#disabledUntil;
  }

  /** Connections currently open (for tests and the log). */
  get size(): number {
    return this.#connections.size;
  }

  #open(token: string): Promise<Connection> {
    this.#opening++;
    return new Promise<Connection>((resolve, reject) => {
      const socket = new WebSocket(this.#options.url, {
        headers: { authorization: `Bearer ${token}` },
      });
      const connection: Connection = { socket, token, busy: true, openedAt: Date.now() };
      const timer = setTimeout(() => socket.close(), this.#options.connectTimeoutMs);
      let opened = false;
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.#opening--;
        this.#connections.add(connection);
        this.#options.log.debug(`WebSocket to OpenAI open (${this.#connections.size} open)`);
        resolve(connection);
      };
      socket.onmessage = (message) => {
        let event: unknown;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (typeof event === "object" && event !== null) {
          connection.listener?.(event as Record<string, unknown>);
        }
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!opened) {
          this.#opening--;
          this.#disabledUntil = Date.now() + this.#options.cooldownMs;
          this.#options.log.warning("Could not open a WebSocket to OpenAI; using HTTP for a while");
          reject(new WsUnavailable("The WebSocket to OpenAI did not open."));
          return;
        }
        this.#connections.delete(connection);
        connection.listener?.(new WsUnavailable("The WebSocket to OpenAI closed."));
        this.#options.log.debug(`WebSocket to OpenAI closed (${this.#connections.size} open)`);
        // Keep one warm: OpenAI closes idle connections after a while.
        if (!connection.busy && token === this.#warmToken) {
          const lived = Date.now() - connection.openedAt;
          this.#warmDelayMs = lived > 60_000 ? 1000 : Math.min(this.#warmDelayMs * 2, 5 * 60_000);
          this.#scheduleWarm(this.#warmDelayMs);
        }
      };
    });
  }

  #idle(token: string): Connection | undefined {
    for (const connection of this.#connections) {
      if (
        !connection.busy &&
        connection.token === token &&
        connection.socket.readyState === WebSocket.OPEN
      ) {
        return connection;
      }
    }
    return undefined;
  }

  #release(connection: Connection): void {
    connection.listener = undefined;
    connection.busy = false;
    const idle = [...this.#connections].filter(
      (c) => !c.busy && c.token === connection.token,
    ).length;
    if (connection.token !== this.#warmToken || idle > this.#options.maxIdle)
      connection.socket.close();
  }

  #scheduleWarm(delayMs: number): void {
    clearTimeout(this.#warmTimer);
    this.#warmTimer = setTimeout(() => this.#warm(), delayMs);
    this.#warmTimer.unref();
  }

  #warm(): void {
    const token = this.#warmToken;
    if (!token || !this.available || this.#idle(token) || this.#opening) return;
    this.#open(token).then(
      (connection) => this.#release(connection),
      () => {}, // logged in #open; requests use HTTP until the cooldown ends
    );
  }

  /**
   * Keeps a connection open for this token, ready for the next request (undefined: signed out).
   * Connections of other tokens are closed once idle.
   */
  warm(token: string | undefined): void {
    this.#warmToken = token;
    for (const connection of this.#connections) {
      if (!connection.busy && connection.token !== token) connection.socket.close();
    }
    this.#warmDelayMs = 1000;
    if (token) this.#scheduleWarm(0);
    else clearTimeout(this.#warmTimer);
  }

  /** Sends a Responses API request and yields its events until the response ends. */
  async *respond(
    token: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    if (!this.available) throw new WsUnavailable("WebSocket is cooling down.");
    let connection = this.#idle(token);
    if (connection) connection.busy = true;
    else connection = await this.#open(token);
    const queue: (Record<string, unknown> | Error)[] = [];
    let wake: (() => void) | undefined;
    connection.listener = (event) => {
      queue.push(event);
      wake?.();
    };
    const abort = () => {
      queue.push(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      wake?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    const { stream: _stream, background: _background, ...rest } = body;
    connection.socket.send(JSON.stringify({ type: "response.create", ...rest, store: false }));
    let started = false;
    let finished = false;
    try {
      for (;;) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        const event = queue.shift();
        if (event === undefined) continue;
        if (event instanceof Error) {
          if (signal.aborted) throw event;
          // closed before the first event: nothing was answered yet, HTTP can take over
          if (!started)
            throw event instanceof WsUnavailable ? event : new WsUnavailable(event.message);
          throw event;
        }
        started = true;
        const terminal = TERMINAL.has(String(event.type));
        // Reuse the connection only after a clean end: an error may still be followed by
        // response.failed, which must not reach the next request. Decided before yielding,
        // because the consumer usually stops right at the final event.
        if (terminal) {
          finished = event.type === "response.completed" || event.type === "response.incomplete";
        }
        yield event;
        if (terminal) return;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      // An answer cut short would leave its remaining events on the connection: close it.
      if (finished && connection.socket.readyState === WebSocket.OPEN) this.#release(connection);
      else {
        connection.listener = undefined;
        connection.socket.close();
      }
    }
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#warmTimer);
    for (const connection of this.#connections) connection.socket.close();
  }
}
