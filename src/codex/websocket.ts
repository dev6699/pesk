import { EventEmitter } from "node:events";
import type { IncomingMessage, JsonRpcResponse, OutgoingMessage, ServerMessage } from "./protocol";
import { describeSocketError, isJsonRpcResponse, isRecord } from "./protocol";

export type SocketEvents = {
  open: [];
  message: [message: ServerMessage];
  close: [event: unknown];
  error: [details: string];
  debug: [values: unknown[]];
  stopped: [];
};

export interface CodexSocketTransport {
  on<Event extends keyof SocketEvents>(
    event: Event,
    listener: (...args: SocketEvents[Event]) => void,
  ): this;
  start(): void;
  stop(): void;
  isOpen(): boolean;
  send(message: OutgoingMessage): void;
  setRequest<TResult>(id: number, callback: (message: JsonRpcResponse<TResult>) => void): void;
}

/**
 * Owns the low-level connection to the Codex app server.
 *
 * This class handles WebSocket lifecycle, newline-delimited JSON framing,
 * JSON-RPC response correlation, and reconnects. It does not interpret
 * Codex protocol methods or maintain thread state; those responsibilities
 * remain in CodexController.
 */
export class CodexWebSocketTransport implements CodexSocketTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly requests = new Map<number, (message: JsonRpcResponse) => void>();
  private readonly eventEmitter = new EventEmitter();

  constructor(private readonly url = "ws://127.0.0.1:4500") {}

  /** Subscribes to a transport lifecycle or server-message event. */
  on<Event extends keyof SocketEvents>(
    event: Event,
    listener: (...args: SocketEvents[Event]) => void,
  ): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  /** Opens the connection and enables automatic reconnects. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Closes the connection and cancels future reconnects. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.requests.clear();
    socket?.close();
    this.eventEmitter.emit("stopped");
  }

  /** Returns whether the current socket is open and ready to send. */
  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Sends one newline-delimited JSON message when connected. */
  send(message: OutgoingMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(`${JSON.stringify(message)}\n`);
    }
  }

  /** Registers a typed callback for a JSON-RPC response ID. */
  setRequest<TResult>(id: number, callback: (message: JsonRpcResponse<TResult>) => void): void {
    this.requests.set(id, (message) => callback(message as JsonRpcResponse<TResult>));
  }

  private connect(): void {
    if (this.stopped) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    )
      return;

    try {
      const socket = new WebSocket(this.url);
      this.requests.clear();
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.eventEmitter.emit("open");
      });
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!isRecord(value)) return;
          const message = value as IncomingMessage;
          if (isJsonRpcResponse(message)) this.handleResponse(message);
          else this.eventEmitter.emit("message", message as ServerMessage);
        } catch (error) {
          this.eventEmitter.emit("debug", ["Invalid Codex message", error]);
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.eventEmitter.emit("close", event);
        this.socket = null;
        this.requests.clear();
        if (!this.stopped) this.scheduleReconnect();
      });
      socket.addEventListener("error", (error) => {
        if (this.socket !== socket) return;
        this.eventEmitter.emit("error", describeSocketError(error, this.url));
      });
    } catch (error) {
      this.eventEmitter.emit("debug", ["Codex connection failed", error]);
      if (!this.stopped) this.scheduleReconnect();
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") return;
    const callback = this.requests.get(message.id);
    if (!callback) return;
    this.requests.delete(message.id);
    callback(message);
  }

  private scheduleReconnect(): void {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 3000);
    }
  }
}
