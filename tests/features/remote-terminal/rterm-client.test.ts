/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

jest.mock("ws", () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];
    readonly sent: string[] = [];
    readyState = 0;
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    send(message: string): void {
      this.sent.push(message);
    }

    close(): void {
      this.readyState = 3;
      this.emit("close");
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return FakeWebSocket;
});

import WebSocket from "ws";
import { RtermClient } from "../../../src/features/remote-terminal/rterm-client";

interface TestSocket {
  sent: string[];
  readyState: number;
  emit(event: string, ...args: unknown[]): void;
}

describe("RtermClient", () => {
  function client(): RtermClient {
    return new RtermClient({ enabled: true, onChanged: jest.fn() });
  }

  test("refuses automated execution while disconnected", () => {
    const target = client();

    expect(target.getSnapshot()).toMatchObject({
      state: "disconnected",
    });
    expect(target.execute("uname -a")).toBeUndefined();
  });

  test("returns bounded recent output metadata", () => {
    const target = client();

    expect(target.readRecent(3)).toEqual({ output: "", truncated: false });
  });

  test("uses raw auth framing and forwards terminal input and resize messages", () => {
    const target = client();
    const socket = connect(target);

    expect(target.authenticate("123456")).toBe(true);
    expect(target.write("ls\n")).toBe(true);
    expect(target.resize(80, 24)).toBe(true);
    expect(socket.sent).toEqual(["b123456", "0ls\n", '2{"cols":80,"rows":24}']);
  });

  test("tracks authentication state and decodes output", () => {
    const changed = jest.fn();
    const target = new RtermClient({ enabled: true, onChanged: changed });
    const socket = connect(target);

    socket.emit("message", "a");
    expect(target.getSnapshot().state).toBe("authenticating");
    socket.emit("message", "d");
    expect(target.getSnapshot().authFailed).toBe(true);
    socket.emit("message", "c");
    socket.emit("message", `1${Buffer.from("hello\nworld\n").toString("base64")}`);

    expect(target.getSnapshot()).toMatchObject({
      state: "connected",
      output: "hello\nworld\n",
      authFailed: false,
    });
    expect(target.readRecent(2)).toEqual({ output: "world\n", truncated: true });
    expect(changed).toHaveBeenCalled();
  });

  test("completes executions and clears output on reconnect", async () => {
    const target = client();
    const socket = connect(target);
    socket.emit("message", "c");

    const execution = target.execute("npm test");
    expect(execution).toBeDefined();
    expect(socket.sent[0]).toContain("npm test");
    const id = execution?.id;
    socket.emit(
      "message",
      `1${Buffer.from(`result\n\u001b]9;pesk-done;${id};0\u0007`).toString("base64")}`,
    );
    await expect(target.wait(id ?? "missing", 100)).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(target.readRecent().output).toContain("result");

    expect(target.reconnect()).toBe(true);
    expect(target.readRecent()).toEqual({ output: "", truncated: false });
  });

  test("completes executions when the marker is split across output messages", async () => {
    const target = client();
    const socket = connect(target);
    socket.emit("message", "c");

    const execution = target.execute("printf result");
    expect(execution).toBeDefined();
    const marker = `\u001b]9;pesk-done;${execution?.id};0\u0007`;
    const splitAt = marker.length - 2;
    socket.emit(
      "message",
      `1${Buffer.from(`result\n${marker.slice(0, splitAt)}`).toString("base64")}`,
    );
    expect(execution?.status).toBe("running");
    socket.emit("message", `1${Buffer.from(marker.slice(splitAt)).toString("base64")}`);

    await expect(target.wait(execution?.id ?? "missing", 100)).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
    });
  });

  test("clears buffered output when disconnected", () => {
    const target = client();
    const socket = connect(target);
    socket.emit("message", "c");
    socket.emit("message", "0old output");

    target.disconnect();

    expect(target.getSnapshot().state).toBe("disconnected");
    expect(target.getSnapshot().output).toBe("");
  });

  test("toggles and rejects invalid connection operations", () => {
    const target = client();
    expect(target.connect("not-a-url")).toBe(false);
    expect(target.toggleConnection()).toBe(false);

    connect(target);
    expect(target.toggleConnection()).toBe(true);
    expect(target.getSnapshot().state).toBe("disconnected");
  });

  test("covers disconnected operations, embed URL, and transient execution waits", async () => {
    const target = client();
    expect(target.getEmbedUrl()).toBe("");
    expect(target.authenticate("123456")).toBe(false);
    expect(target.write("ls")).toBe(false);
    expect(target.resize(80, 24)).toBe(false);
    target.clearBuffer();

    expect(target.connect("ws://")).toBe(true);
    expect(target.getSnapshot().hostLabel).toBe("remote shell");
    expect(target.getEmbedUrl()).toContain("embed=1&bridge=parent");
    const socket = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!socket) throw new Error("fake WebSocket was not created");
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", "");
    socket.emit("message", "xignored");
    await expect(target.wait("missing", 0)).resolves.toBeUndefined();
    target.disconnect();
  });

  test("handles invalid host labels, socket close/error, and wait timeouts", async () => {
    const target = new RtermClient({ url: "%", enabled: true, onChanged: jest.fn() });
    expect(target.getSnapshot().hostLabel).toBe("remote shell");
    const socket = connect(target);
    socket.emit("message", "c");
    const execution = target.execute("sleep 1");
    if (!execution) throw new Error("execution was not created");
    await expect(target.wait(execution.id, 110)).resolves.toMatchObject({ status: "running" });
    socket.emit("error");
    expect(target.getSnapshot()).toMatchObject({ state: "disconnected", output: "" });
    (target as unknown as { handleMessage: (message: string) => void }).handleMessage(
      `1${Buffer.from("late output").toString("base64")}`,
    );
    target.disconnect();
    expect(target.connect("ws://remote.example/bash/ws")).toBe(true);
    const reopened = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!reopened) throw new Error("fake WebSocket was not created");
    reopened.readyState = WebSocket.OPEN;
    reopened.emit("close");
    expect(target.getSnapshot().state).toBe("disconnected");
  });

  test("covers disabled clients, query embed URLs, and failed execution writes", () => {
    const disabled = new RtermClient({
      enabled: false,
      url: "ws://remote.example/bash/ws",
      onChanged: jest.fn(),
    });
    expect(disabled.connect("ws://remote.example/bash/ws")).toBe(false);
    expect(disabled.toggleConnection()).toBe(false);
    expect(disabled.getEmbedUrl()).toBe("");

    const target = client();
    expect(target.connect("ws://remote.example/bash/ws?token=1")).toBe(true);
    const socket = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!socket) throw new Error("fake WebSocket was not created");
    socket.emit("message", "c");
    expect(target.getEmbedUrl()).toContain("?token=1&embed=1");
    expect(target.getEmbedUrl()).toBe("http://remote.example/bash?token=1&embed=1&bridge=parent");
    expect(target.execute("pwd")).toBeUndefined();
    socket.emit(
      "message",
      `1${Buffer.from("\u001b]9;pesk-done;missing;0\u0007").toString("base64")}`,
    );
  });

  test("handles stale socket events and bounds the output buffer", () => {
    const target = new RtermClient({ enabled: true, onChanged: jest.fn(), maxBytes: 4 });
    expect(target.connect("ws://remote.example/bash/ws")).toBe(true);
    const oldSocket = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!oldSocket) throw new Error("fake WebSocket was not created");
    expect(target.reconnect()).toBe(true);
    oldSocket.emit("close");
    oldSocket.emit("error");
    const socket = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!socket) throw new Error("fake WebSocket was not recreated");
    socket.readyState = WebSocket.OPEN;
    oldSocket.emit("message", `1${Buffer.from("stale output").toString("base64")}`);
    expect(target.getSnapshot().output).toBe("");
    socket.emit("message", `1${Buffer.from("123456").toString("base64")}`);
    expect(target.getSnapshot().output).toBe("3456");
    expect(target.readRecent()).toEqual({ output: "3456", truncated: true });
  });

  function connect(target: RtermClient): TestSocket {
    expect(target.connect("ws://remote.example/bash/ws")).toBe(true);
    const socket = (WebSocket as unknown as { instances: TestSocket[] }).instances.at(-1);
    if (!socket) throw new Error("fake WebSocket was not created");
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
    return socket;
  }
});
