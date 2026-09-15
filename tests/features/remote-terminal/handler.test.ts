/** @jest-environment node */
/// <reference types="jest" />

import { RemoteTerminalToolHandler } from "../../../src/features/remote-terminal/handler";

test("requests the session list from rterm", async () => {
  const request = jest.fn().mockResolvedValue({
    requestId: "call-1",
    ok: true,
    result: [{ sessionId: "session-1" }],
  });
  const handler = new RemoteTerminalToolHandler({
    getRterm: () =>
      ({ requestSessions: request, getSnapshot: () => ({ hostLabel: "remote" }) }) as never,
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval: jest.fn(),
  });

  await expect(
    handler.handle({
      namespace: "remote_terminal",
      tool: "sessions",
      arguments: {},
      threadId: "thread-1",
      callId: "call-1",
    } as never),
  ).resolves.toMatchObject({ success: true });
  expect(request).toHaveBeenCalledWith({ requestId: "call-1" });
});

test("requests command execution from rterm after approval", async () => {
  const request = jest.fn().mockResolvedValue({
    requestId: "call-2",
    ok: true,
    result: "completed; exitCode=0\ndone",
  });
  const executeProvider = jest.fn().mockResolvedValue({ output: "done", exitCode: 0 });
  const requestApproval = jest.fn().mockResolvedValue(true);
  const handler = new RemoteTerminalToolHandler({
    getRterm: () =>
      ({
        request,
        executeProvider,
        getProviderSessionTabLabel: jest.fn(),
        getSnapshot: () => ({ hostLabel: "remote" }),
      }) as never,
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval,
  });

  await expect(
    handler.handle({
      namespace: "remote_terminal",
      tool: "execute",
      arguments: { command: "pwd" },
      threadId: "thread-1",
      callId: "call-2",
    } as never),
  ).resolves.toMatchObject({ success: true });
  expect(executeProvider).toHaveBeenCalledWith("pwd", undefined);
});

test("selects the requested session and includes its tab identity in approval", async () => {
  const executeProvider = jest.fn().mockResolvedValue({ output: "done", exitCode: 0 });
  const selectProviderSession = jest.fn().mockReturnValue(true);
  const requestApproval = jest.fn().mockResolvedValue(true);
  const handler = new RemoteTerminalToolHandler({
    getRterm: () =>
      ({
        executeProvider,
        selectProviderSession,
        getProviderSessionTabLabel: jest.fn().mockReturnValue("puong@mydev · session-"),
        getSnapshot: () => ({ hostLabel: "remote" }),
      }) as never,
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval,
  });

  await expect(
    handler.handle({
      namespace: "remote_terminal",
      tool: "execute",
      arguments: { command: "pwd", sessionId: "session-1" },
      threadId: "thread-1",
      callId: "call-3",
    } as never),
  ).resolves.toMatchObject({ success: true });
  expect(selectProviderSession).toHaveBeenCalledWith("session-1");
  expect(requestApproval).toHaveBeenCalledWith(
    "thread-1",
    "call-3",
    "pwd",
    "[puong@mydev · session-]\nRun command.",
    "remote",
    "remote_terminal.execute",
  );
  expect(executeProvider).toHaveBeenCalledWith("pwd", "session-1");
});

test("rejects an unknown session before requesting command approval", async () => {
  const requestApproval = jest.fn();
  const handler = new RemoteTerminalToolHandler({
    getRterm: () =>
      ({
        selectProviderSession: jest.fn().mockReturnValue(false),
        getProviderSessionTabLabel: jest.fn(),
        getSnapshot: () => ({ hostLabel: "remote" }),
      }) as never,
    readWorkspaceFile: jest.fn(),
    writeWorkspaceFile: jest.fn(),
    requestApproval,
  });

  await expect(
    handler.handle({
      namespace: "remote_terminal",
      tool: "execute",
      arguments: { command: "pwd", sessionId: "stale-session" },
      threadId: "thread-1",
      callId: "call-4",
    } as never),
  ).resolves.toMatchObject({
    success: false,
    contentItems: [{ text: "The provider session is not connected or does not exist." }],
  });
  expect(requestApproval).not.toHaveBeenCalled();
});
