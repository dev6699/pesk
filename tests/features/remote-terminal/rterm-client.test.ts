/** @jest-environment node */
/// <reference types="jest" />

import { RtermClient } from "../../../src/features/remote-terminal/rterm-client";

describe("RtermClient provider mode", () => {
  const session = {
    sessionId: "session/1",
    token: "token-1",
    provider: "ssh",
    target: "test-host",
    user: "test-user",
  };

  function client() {
    return new RtermClient({
      enabled: true,
      url: "http://remote:5000/provider/ssh",
      onChanged: jest.fn(),
    });
  }

  afterEach(() => jest.restoreAllMocks());

  test("tracks the selected provider session", () => {
    const target = client();
    target.setProviderSession(session);

    expect(target.getSnapshot()).toMatchObject({
      state: "connected",
      hostLabel: "test-user@test-host",
      activeSessionId: "session/1",
      sessions: [
        { sessionId: "session/1", provider: "ssh", target: "test-host", user: "test-user" },
      ],
    });

    target.clearProviderSession();
    expect(target.getSnapshot()).toMatchObject({
      state: "disconnected",
      hostLabel: "test-user@test-host",
    });
  });

  test("retains multiple sessions and routes by explicit session ID", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ output: "session two", truncated: false }), { status: 200 }),
      );
    const target = client();
    const second = { ...session, sessionId: "session/2", target: "other-host", user: "other-user" };
    target.setProviderSession(session);
    target.setProviderSession(second);
    expect(target.getSnapshot()).toMatchObject({
      activeSessionId: "session/2",
      sessions: [
        { sessionId: "session/1", provider: "ssh", target: "test-host", user: "test-user" },
        { sessionId: "session/2", provider: "ssh", target: "other-host", user: "other-user" },
      ],
    });

    expect(target.getProviderSessions()).toEqual([session, second]);
    await expect(target.readProvider(20, session.sessionId)).resolves.toEqual({
      output: "session two",
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:5000/api/sessions/session%2F1/read?maxLines=20",
      { headers: { Authorization: "Bearer token-1" } },
    );
    expect(target.selectProviderSession(session.sessionId)).toBe(true);
    expect(target.getSnapshot().hostLabel).toBe("test-user@test-host");
    target.clearProviderSession(session.sessionId);
    expect(target.getProviderSessions()).toEqual([second]);
  });

  test("reads the attached provider terminal", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ output: "shell output", truncated: false }), { status: 200 }),
      );
    const target = client();
    target.setProviderSession(session);

    await expect(target.readProvider(20)).resolves.toEqual({
      output: "shell output",
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:5000/api/sessions/session%2F1/read?maxLines=20",
      { headers: { Authorization: "Bearer token-1" } },
    );
  });

  test("executes through the attached provider terminal", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ output: "done", exitCode: 0 }), { status: 200 }),
      );
    const target = client();
    target.setProviderSession(session);

    await expect(target.executeProvider("pwd")).resolves.toEqual({ output: "done", exitCode: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://remote:5000/api/sessions/session%2F1/execute",
      expect.objectContaining({
        headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
        body: JSON.stringify({ command: "pwd" }),
      }),
    );
  });

  test("reports provider errors and does nothing without a session", async () => {
    const target = client();
    await expect(target.readProvider()).resolves.toBeUndefined();
    await expect(target.executeProvider("pwd")).resolves.toBeUndefined();

    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    target.setProviderSession(session);
    await expect(target.readProvider()).rejects.toThrow("not found");
  });

  test("transfers raw bytes through the provider", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ bytes: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const target = client();
    target.setProviderSession(session);
    await expect(
      target.uploadProviderBytes(new Uint8Array([1, 2]), "/tmp/remote.txt"),
    ).resolves.toBe(2);
    await expect(target.downloadProviderBytes("/tmp/remote.txt")).resolves.toEqual(
      new Uint8Array([111, 107]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("stays disabled when configured disabled", () => {
    const target = new RtermClient({
      enabled: false,
      url: "http://remote/provider/ssh",
      onChanged: jest.fn(),
    });
    expect(target.getSnapshot().enabled).toBe(false);
  });
});
