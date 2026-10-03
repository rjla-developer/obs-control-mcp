import { EventSubscription, OBSWebSocket, OBSWebSocketError } from "obs-websocket-js/json";
import type { OBSEventTypes, OBSRequestTypes, OBSResponseTypes } from "obs-websocket-js/json";
import { obsUrl, type Config } from "./config.ts";
import type { Logger } from "./log.ts";
import type { SecretRegistry } from "./redact.ts";

export type { OBSEventTypes, OBSRequestTypes, OBSResponseTypes };

/** What the tools need from OBS: one typed request at a time. */
export interface ObsClient {
  call<T extends keyof OBSRequestTypes>(type: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T]>;
}

/** Events the timeline listens to. High-volume events (meters, active state) are left out. */
export const TIMELINE_SUBSCRIPTIONS =
  EventSubscription.General |
  EventSubscription.Scenes |
  EventSubscription.Inputs |
  EventSubscription.Filters |
  EventSubscription.Outputs |
  EventSubscription.SceneItems |
  EventSubscription.Ui;

/** An error whose message is safe to show (already scrubbed of secrets). */
export class ObsError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export interface ObsConnectionOptions {
  config: Pick<Config, "host" | "port" | "password" | "connectTimeoutMs">;
  secrets: SecretRegistry;
  logger: Logger;
  eventSubscriptions?: number;
  /** Keep reconnecting after the connection drops (used by the timeline recorder). */
  autoReconnect?: boolean;
  /** Factory, so tests can swap the socket class. */
  createSocket?: () => OBSWebSocket;
}

/**
 * Lazy, self-healing connection to obs-websocket v5. Tools call `call()`; the
 * first call connects, and a dropped connection is re-opened on the next call.
 */
export class ObsConnection implements ObsClient {
  private readonly socket: OBSWebSocket;
  private readonly opts: ObsConnectionOptions;
  private connecting: Promise<void> | undefined;
  private closedByUs = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = 1000;
  private readonly connectedHandlers: Array<() => void | Promise<void>> = [];
  private readonly closedHandlers: Array<() => void> = [];

  constructor(opts: ObsConnectionOptions) {
    this.opts = opts;
    this.socket = opts.createSocket ? opts.createSocket() : new OBSWebSocket();
    this.socket.on("ConnectionClosed", (err) => {
      if (this.closedByUs) return;
      this.opts.logger.warn(`Connection to OBS closed (${this.describeError(err)})`);
      for (const h of this.closedHandlers) h();
      this.scheduleReconnect();
    });
    // Without a listener EventEmitter would throw on "error"-like events; keep it quiet and scrubbed.
    this.socket.on("ConnectionError", (err) => {
      this.opts.logger.debug(`OBS connection error (${this.describeError(err)})`);
    });
  }

  get connected(): boolean {
    return this.socket.identified;
  }

  /** Runs `handler` after every successful (re)connection. */
  onConnected(handler: () => void | Promise<void>): void {
    this.connectedHandlers.push(handler);
  }

  /** Runs `handler` when the connection drops (not when we close it). */
  onClosed(handler: () => void): void {
    this.closedHandlers.push(handler);
  }

  on<E extends keyof OBSEventTypes>(event: E, handler: (data: OBSEventTypes[E]) => void): void {
    // The emitter's typing maps void payloads to no arguments; all OBS events we use carry data.
    (this.socket.on as (e: string, h: (d: OBSEventTypes[E]) => void) => void).call(this.socket, event, handler);
  }

  /** Connects now and keeps reconnecting with backoff (needs autoReconnect). */
  keepConnected(): void {
    this.ensureConnected().catch((err: unknown) => {
      this.opts.logger.warn(this.describeError(err));
      this.scheduleReconnect();
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.socket.identified) return;
    if (!this.connecting) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  async call<T extends keyof OBSRequestTypes>(type: T, data?: OBSRequestTypes[T]): Promise<OBSResponseTypes[T]> {
    await this.ensureConnected();
    try {
      return await this.socket.call(type, data);
    } catch (err) {
      throw new ObsError(`${type} failed: ${this.describeError(err)}`, err instanceof OBSWebSocketError ? err.code : undefined);
    }
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.socket.disconnect().catch(() => undefined);
  }

  private async connectOnce(): Promise<void> {
    const { config } = this.opts;
    const url = obsUrl(config);
    this.closedByUs = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ObsError(`Timed out after ${config.connectTimeoutMs} ms connecting to OBS at ${config.host}:${config.port}`)), config.connectTimeoutMs);
    });
    try {
      await Promise.race([
        this.socket.connect(url, config.password, {
          eventSubscriptions: this.opts.eventSubscriptions ?? EventSubscription.None,
        }),
        timeout,
      ]);
    } catch (err) {
      await this.socket.disconnect().catch(() => undefined);
      if (err instanceof ObsError) throw err;
      throw new ObsError(this.explainConnectError(err), err instanceof OBSWebSocketError ? err.code : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.reconnectDelayMs = 1000;
    this.opts.logger.info(`Connected to OBS at ${config.host}:${config.port}`);
    for (const h of this.connectedHandlers) {
      try {
        await h();
      } catch (err) {
        this.opts.logger.warn(`After-connect handler failed: ${this.describeError(err)}`);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.opts.autoReconnect || this.closedByUs || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.ensureConnected().catch((err: unknown) => {
        this.opts.logger.warn(`Reconnect failed: ${this.describeError(err)}`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private explainConnectError(err: unknown): string {
    const { host, port, password } = this.opts.config;
    if (err instanceof OBSWebSocketError) {
      if (err.code === 4009) return `OBS at ${host}:${port} rejected the password (authentication failed)`;
      if (err.code === 4008 || (err.code === 4005 && !password))
        return `OBS at ${host}:${port} requires a password; set OBS_PASSWORD_FILE`;
      if (err.code === 1006 || err.code === -1)
        return `Cannot reach OBS at ${host}:${port}: is OBS open with Tools > WebSocket Server Settings enabled, and is the port open in the firewall?`;
    }
    return `Cannot connect to OBS at ${host}:${port}: ${this.describeError(err)}`;
  }

  private describeError(err: unknown): string {
    const raw =
      err instanceof OBSWebSocketError
        ? `${err.message || "no reason given"} (code ${err.code})`
        : err instanceof Error
          ? err.message
          : String(err);
    return this.opts.secrets.scrub(raw);
  }
}
