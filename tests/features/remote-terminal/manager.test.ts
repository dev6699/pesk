/** @jest-environment node */
/// <reference types="jest" />

import { RemoteTerminalManager } from "../../../src/features/remote-terminal/manager";

test("routes requests through the client for the requested thread", async () => {
  const request = jest.fn().mockResolvedValue({ requestId: "call-1", ok: true, result: [] });
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    requestSessions: request,
    selectSession: jest.fn(),
  });

  await expect(
    manager.getClient("thread-1").requestSessions({ requestId: "call-1" }),
  ).resolves.toMatchObject({ ok: true });
  expect(request).toHaveBeenCalledWith("thread-1", {
    requestId: "call-1",
  });
});

test("uses a private stable room capability for each thread", async () => {
  const manager = new RemoteTerminalManager({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    requestSessions: jest.fn(),
    selectSession: jest.fn(),
  });
  manager.setCurrentThread("thread-1");

  const first = await manager.getEmbedUrlForSession();
  const second = await manager.getEmbedUrlForSession();
  manager.setCurrentThread("thread-2");
  const other = await manager.getEmbedUrlForSession();

  const firstRoom = new URL(first).searchParams.get("roomId");
  expect(firstRoom).toMatch(/^[0-9a-f-]{36}$/);
  expect(new URL(second).searchParams.get("roomId")).toBe(firstRoom);
  expect(new URL(other).searchParams.get("roomId")).not.toBe(firstRoom);
  expect(firstRoom).not.toBe("thread-1");
});
