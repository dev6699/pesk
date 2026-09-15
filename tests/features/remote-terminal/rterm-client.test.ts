/** @jest-environment node */
/// <reference types="jest" />

import { RtermClient } from "../../../src/features/remote-terminal/rterm-client";

test("delegates tool requests without storing provider credentials", async () => {
  const request = jest.fn().mockResolvedValue({
    requestId: "call-1",
    ok: true,
    result: [{ sessionId: "session-1" }],
  });
  const client = new RtermClient({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    requestSessions: request,
    selectSession: jest.fn(),
  });

  await expect(client.requestSessions({ requestId: "call-1" })).resolves.toMatchObject({
    ok: true,
  });
  expect(request).toHaveBeenCalledWith({ requestId: "call-1" });
});

test("builds the rterm embed URL with the thread room", async () => {
  const client = new RtermClient({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    requestSessions: jest.fn(),
    selectSession: jest.fn(),
  });
  await expect(client.getEmbedUrlForSession("thread-1")).resolves.toBe(
    "http://remote:5000/provider/ssh?embed=1&roomId=thread-1",
  );
});

test("uses the selected provider session and replaces stale sessions", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce({
      requestId: "call-1",
      ok: true,
      result: [
        { sessionId: "session-1", token: "token-1", target: "node-1", user: "root" },
        { sessionId: "session-2", token: "token-2", target: "node-2", user: "root" },
      ],
    })
    .mockResolvedValueOnce({
      requestId: "call-2",
      ok: true,
      result: [{ sessionId: "session-2", token: "token-2", target: "node-2", user: "root" }],
    });
  const selectSession = jest.fn().mockReturnValue(true);
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ output: "node-2", truncated: false }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    const client = new RtermClient({
      enabled: true,
      url: "http://remote:5000/provider/ssh",
      requestSessions: request,
      selectSession,
    });

    await client.requestSessions({ requestId: "call-1" });
    expect(client.getSnapshot().hostLabel).toBe("root@node-1");
    expect(client.selectProviderSession("session-2")).toBe(true);
    expect(client.getSnapshot().hostLabel).toBe("root@node-2");
    await client.readProvider();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://remote:5000/api/sessions/session-2/read?maxLines=200",
      expect.objectContaining({ headers: { Authorization: "Bearer token-2" } }),
    );

    await client.requestSessions({ requestId: "call-2" });
    expect(client.getSnapshot().hostLabel).toBe("root@node-2");
    expect(client.getProviderSessionTabLabel("session-1")).toBeUndefined();
    await client.readProvider();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://remote:5000/api/sessions/session-2/read?maxLines=200",
      expect.anything(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
