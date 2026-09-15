/** @jest-environment node */
/// <reference types="jest" />

import { RemoteTerminalService } from "../../../src/features/remote-terminal/service";

test("resolves a dynamic tool request from an rterm response", async () => {
  let sent: { threadId: string; request: { requestId: string } } | undefined;
  const service = new RemoteTerminalService({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    sendSessionsRequest: (threadId, request) => {
      sent = { threadId, request };
      return true;
    },
    sendSessionSelection: jest.fn(),
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval: jest.fn().mockResolvedValue(true),
  });

  const pending = service.handleToolCall({
    namespace: "remote_terminal",
    tool: "sessions",
    arguments: {},
    threadId: "thread-1",
    callId: "call-1",
  } as never);
  expect(sent?.threadId).toBe("thread-1");
  service.handleSessionsResponse("thread-1", {
    requestId: "call-1",
    ok: true,
    connected: true,
    result: [{ sessionId: "session-1" }],
  });
  await expect(pending).resolves.toMatchObject({ success: true });
});

test("ignores an unconnected renderer response when another client may be connected", async () => {
  jest.useFakeTimers();
  const sendSessionsRequest = jest.fn().mockReturnValue(true);
  const service = new RemoteTerminalService({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    sendSessionsRequest,
    sendSessionSelection: jest.fn(),
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval: jest.fn().mockResolvedValue(true),
  });

  const pending = service.handleToolCall({
    namespace: "remote_terminal",
    tool: "sessions",
    arguments: {},
    threadId: "thread-1",
    callId: "call-2",
  } as never);
  const response = {
    requestId: "call-2",
    ok: true,
    connected: false,
    result: [],
    unavailable: true,
    error: "The rterm iframe is not connected.",
  };
  service.handleSessionsResponse("thread-1", response);

  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  jest.advanceTimersByTime(15_000);

  await expect(pending).resolves.toMatchObject({
    success: false,
    contentItems: [
      { type: "inputText", text: "Timed out waiting for a response from the rterm iframe." },
    ],
  });
  expect(sendSessionsRequest).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test("uses a connected renderer response after an unconnected response", async () => {
  const service = new RemoteTerminalService({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    sendSessionsRequest: jest.fn().mockReturnValue(true),
    sendSessionSelection: jest.fn(),
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval: jest.fn().mockResolvedValue(true),
  });

  const pending = service.handleToolCall({
    namespace: "remote_terminal",
    tool: "sessions",
    arguments: {},
    threadId: "thread-1",
    callId: "call-4",
  } as never);
  service.handleSessionsResponse("thread-1", {
    requestId: "call-4",
    ok: true,
    connected: false,
    result: [],
  });
  service.handleSessionsResponse("thread-1", {
    requestId: "call-4",
    ok: true,
    connected: true,
    result: [{ sessionId: "session-1" }],
  });

  await expect(pending).resolves.toMatchObject({ success: true });
});

test("returns an unavailable error when no renderer accepts the request", async () => {
  const service = new RemoteTerminalService({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    sendSessionsRequest: jest.fn().mockReturnValue(false),
    sendSessionSelection: jest.fn(),
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval: jest.fn().mockResolvedValue(true),
  });

  await expect(
    service.handleToolCall({
      namespace: "remote_terminal",
      tool: "sessions",
      arguments: {},
      threadId: "thread-1",
      callId: "call-3",
    } as never),
  ).resolves.toMatchObject({
    success: false,
    contentItems: [{ type: "inputText", text: "The rterm panel is unavailable." }],
  });
});
