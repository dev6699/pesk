/// <reference types="jest" />
/// <reference types="node" />

import { CodexWebSocketTransport } from "../../src/codex";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  static shouldThrow = false;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public readonly url: string) {
    if (FakeWebSocket.shouldThrow) throw new Error("socket unavailable");
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: (event: unknown) => void): void {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(callback);
    this.listeners.set(event, callbacks);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, value: unknown = {}): void {
    if (event === "open") this.readyState = FakeWebSocket.OPEN;
    const eventValue = event === "message" ? { data: value } : value;
    for (const callback of this.listeners.get(event) ?? []) callback(eventValue);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldThrow = false;
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
});

describe("CodexWebSocketTransport", () => {
  test("reports construction failures and retries", () => {
    jest.useFakeTimers();
    try {
      FakeWebSocket.shouldThrow = true;
      const debug = jest.fn();
      const transport = new CodexWebSocketTransport();
      transport.on("debug", (values) => debug(...values));

      transport.start();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(debug).toHaveBeenCalledWith("Codex connection failed", expect.any(Error));

      jest.advanceTimersByTime(3000);
      expect(FakeWebSocket.instances).toHaveLength(0);
      transport.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test("reports malformed messages and socket errors", () => {
    const debug = jest.fn();
    const errors = jest.fn();
    const transport = new CodexWebSocketTransport();
    transport.on("debug", (values) => debug(...values));
    transport.on("error", errors);
    transport.start();
    const socket = FakeWebSocket.instances[0];

    socket.emit("message", "not-json");
    socket.emit("error", { type: "error", message: "socket failed" });

    expect(debug).toHaveBeenCalledWith("Invalid Codex message", expect.anything());
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("message=socket failed"));
    transport.stop();
  });

  test("ignores events from an obsolete socket after replacement", () => {
    const close = jest.fn();
    const error = jest.fn();
    const transport = new CodexWebSocketTransport();
    transport.on("close", close).on("error", error);
    transport.start();
    const first = FakeWebSocket.instances[0];
    const internal = transport as unknown as { socket: FakeWebSocket | null };
    internal.socket = null;
    transport.start();
    const second = FakeWebSocket.instances[1];

    first.emit("close", { code: 1006, reason: "obsolete" });
    first.emit("error", { message: "obsolete error" });

    expect(internal.socket).toBe(second);
    expect(close).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    transport.stop();
  });

  test("does not reconnect after an explicit stop", () => {
    jest.useFakeTimers();
    try {
      const transport = new CodexWebSocketTransport();
      transport.start();
      const socket = FakeWebSocket.instances[0];

      socket.emit("close", { code: 1006, reason: "server restarted" });
      transport.stop();
      jest.advanceTimersByTime(3000);

      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("ignores responses that arrive from a closed socket", () => {
    const transport = new CodexWebSocketTransport();
    const response = jest.fn();
    transport.setRequest(1, response);
    transport.start();
    const socket = FakeWebSocket.instances[0];

    socket.emit("close", { code: 1006, reason: "server restarted" });
    socket.emit("message", JSON.stringify({ id: 1, result: { ok: true } }));

    expect(response).not.toHaveBeenCalled();
    transport.stop();
  });

  test("reconnects after the WebSocket closes", () => {
    jest.useFakeTimers();
    try {
      const transport = new CodexWebSocketTransport();
      transport.start();
      FakeWebSocket.instances[0].emit("close");

      expect(FakeWebSocket.instances).toHaveLength(1);
      jest.advanceTimersByTime(3000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      transport.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
