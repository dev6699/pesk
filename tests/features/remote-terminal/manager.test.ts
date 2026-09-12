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
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }
  return FakeWebSocket;
});

import WebSocket from "ws";
import { RemoteTerminalManager } from "../../../src/features/remote-terminal/manager";

test("keeps independent clients per thread without connecting automatically", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "ws://remote:5000/bash/ws",
    onChanged: jest.fn(),
  });

  const first = manager.getClient("thread-1");
  const second = manager.getClient("thread-2");

  expect(first).not.toBe(second);
  expect(manager.getClient("thread-1")).toBe(first);
  expect(first.getSnapshot()).toMatchObject({ state: "disconnected", hostLabel: "remote" });
  expect(second.getSnapshot()).toMatchObject({ state: "disconnected", hostLabel: "remote" });
  expect(manager.getEmbedUrl("thread-1")).toContain("embed=1");
});

test("forwards client changes and output and disconnects all threads", () => {
  const onChanged = jest.fn();
  const onOutput = jest.fn();
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "ws://remote:5000/bash/ws",
    onChanged,
    onOutput,
  });
  manager.setCurrentThread("thread-1");
  expect(manager.toggleConnection()).toBe(true);
  const socket = (
    WebSocket as unknown as {
      instances: Array<{ readyState: number; emit: (event: string, ...args: unknown[]) => void }>;
    }
  ).instances.at(-1);
  if (!socket) throw new Error("fake WebSocket was not created");
  socket.readyState = WebSocket.OPEN;
  socket.emit("message", "c");
  socket.emit("message", `1${Buffer.from("output\n").toString("base64")}`);
  expect(manager.authenticate("123456")).toBe(true);
  expect(manager.write("pwd\n")).toBe(true);
  expect(manager.resize(80, 24)).toBe(true);
  expect(onChanged).toHaveBeenCalledWith(
    "thread-1",
    expect.objectContaining({ state: "connected" }),
  );
  expect(onOutput).toHaveBeenCalledWith("thread-1", "output\n");
  manager.disconnectAll();
  expect(manager.getSnapshot("thread-1").output).toBe("");
  manager.setCurrentThread("");
  expect(manager.authenticate("123456")).toBe(false);
  expect(manager.write("pwd\n")).toBe(false);
  expect(manager.resize(80, 24)).toBe(false);
});

test("uses the selected thread for current-terminal operations", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "",
    onChanged: jest.fn(),
  });
  manager.setCurrentThread("thread-1");

  expect(manager.toggleConnection()).toBe(false);
  expect(manager.authenticate("123456")).toBe(false);
  expect(manager.write("pwd\n")).toBe(false);
  expect(manager.resize(80, 24)).toBe(false);

  manager.setCurrentThread(undefined);
  expect(manager.getSnapshot()).toMatchObject({ state: "disconnected", enabled: true });
  expect(manager.getEmbedUrl()).toBe("");
});
