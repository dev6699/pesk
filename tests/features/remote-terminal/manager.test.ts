/** @jest-environment node */
/// <reference types="jest" />

import { RemoteTerminalManager } from "../../../src/features/remote-terminal/manager";

test("keeps independent provider clients per thread", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    onChanged: jest.fn(),
  });

  const first = manager.getClient("thread-1");
  const second = manager.getClient("thread-2");
  expect(first).not.toBe(second);
  expect(manager.getEmbedUrl("thread-1")).toContain("embed=1");

  expect(
    manager.setProviderSession({
      sessionId: "first",
      token: "token-1",
      provider: "ssh",
      target: "test-host",
      user: "test-user",
    }, "thread-1"),
  ).toBe(true);
  expect(first.getSnapshot()).toMatchObject({
    state: "connected",
    hostLabel: "test-user@test-host",
  });
  expect(second.getSnapshot()).toMatchObject({ state: "disconnected" });
});

test("clears all thread clients without affecting the provider server", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    onChanged: jest.fn(),
  });
  manager.setProviderSession(
    { sessionId: "first", token: "token-1", provider: "ssh", target: "test-host", user: "test-user" },
    "thread-1",
  );

  manager.disconnectAll();
  expect(manager.getSnapshot("thread-1")).toMatchObject({ state: "disconnected" });
});

test("uses the selected thread for provider session operations", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    onChanged: jest.fn(),
  });
  manager.setCurrentThread("thread-1");

  expect(manager.setProviderSession({
    sessionId: "first",
    token: "token-1",
    provider: "ssh",
    target: "test-host",
    user: "test-user",
  })).toBe(true);
  expect(manager.getSnapshot()).toMatchObject({ state: "connected" });
  expect(manager.clearProviderSession()).toBe(true);
  expect(manager.getSnapshot()).toMatchObject({ state: "disconnected" });
});

test("returns an empty snapshot without a selected thread and rejects missing thread updates", () => {
  const manager = new RemoteTerminalManager({ enabled: false, url: "", onChanged: jest.fn() });
  expect(manager.getSnapshot()).toMatchObject({ enabled: false, state: "disconnected" });
  expect(manager.setProviderSession({
    sessionId: "session-1", token: "token-1", provider: "ssh", target: "host-a", user: "user-a",
  })).toBe(false);
  expect(manager.clearProviderSession()).toBe(false);
});

test("removes only the requested provider session", () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    onChanged: jest.fn(),
  });
  manager.setProviderSession(
    { sessionId: "first", token: "token-1", provider: "ssh", target: "host-a", user: "user-a" },
    "thread-1",
  );
  manager.setProviderSession(
    { sessionId: "second", token: "token-2", provider: "ssh", target: "host-b", user: "user-b" },
    "thread-1",
  );

  expect(manager.clearProviderSession("first", "thread-1")).toBe(true);
  expect(manager.getClient("thread-1").getProviderSessions()).toEqual([
    { sessionId: "second", token: "token-2", provider: "ssh", target: "host-b", user: "user-b" },
  ]);
});
