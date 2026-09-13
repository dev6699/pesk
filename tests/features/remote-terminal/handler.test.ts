/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import { RemoteTerminalToolHandler } from "../../../src/features/remote-terminal/handler";
import type { RtermClient } from "../../../src/features/remote-terminal/rterm-client";
import {
  REMOTE_TERMINAL_EXECUTE_TOOL,
  REMOTE_TERMINAL_NAMESPACE,
  REMOTE_TERMINAL_READ_TOOL,
  REMOTE_TERMINAL_SESSIONS_TOOL,
  REMOTE_TERMINAL_TOOLS,
} from "../../../src/features/remote-terminal/tools";

test("publishes the remote terminal namespace schema", () => {
  expect(REMOTE_TERMINAL_NAMESPACE).toBe("remote_terminal");
  expect(REMOTE_TERMINAL_READ_TOOL).toBe("read");
  expect(REMOTE_TERMINAL_EXECUTE_TOOL).toBe("execute");
  expect(REMOTE_TERMINAL_SESSIONS_TOOL).toBe("sessions");
  expect(REMOTE_TERMINAL_TOOLS[0]?.tools).toHaveLength(3);
});

test("lists all provider sessions for the thread", async () => {
  const { handler } = makeHandler({
    getProviderSessions: jest.fn(() => [
      { sessionId: "one", token: "token-1", provider: "ssh", target: "dev-a", user: "alice" },
      { sessionId: "two", token: "token-2", provider: "ssh", target: "dev-b", user: "bob" },
    ]),
  });

  await expect(
    handler.handle(params(REMOTE_TERMINAL_SESSIONS_TOOL) as never),
  ).resolves.toMatchObject({
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify([
          { sessionId: "one", provider: "ssh", target: "dev-a", user: "alice" },
          { sessionId: "two", provider: "ssh", target: "dev-b", user: "bob" },
        ]),
      },
    ],
    success: true,
  });
});

function makeHandler(overrides: Partial<RtermClient> = {}) {
  const rterm = {
    getSnapshot: jest.fn(() => ({
      enabled: true,
      state: "connected" as const,
      output: "",
      hostLabel: "remote",
      authFailed: false,
    })),
    getProviderSessions: jest.fn(() => [
      { sessionId: "session-1", token: "token-1", provider: "ssh", target: "host", user: "user" },
    ]),
    selectProviderSession: jest.fn(() => true),
    readProvider: jest.fn(async () => ({ output: "shell output", truncated: false })),
    executeProvider: jest.fn(async () => ({ output: "done", exitCode: 0 })),
    ...overrides,
  } as unknown as RtermClient;
  const requestApproval = jest.fn(async () => true);
  return {
    handler: new RemoteTerminalToolHandler({ getRterm: () => rterm, requestApproval }),
    rterm,
    requestApproval,
  };
}

test("routes explicit session IDs and notifies the renderer", async () => {
  const onSessionSelected = jest.fn();
  const rterm = {
    getSnapshot: jest.fn(() => ({
      enabled: true,
      state: "connected" as const,
      output: "",
      hostLabel: "host-b",
      authFailed: false,
    })),
    getProviderSessions: jest.fn(() => [
      { sessionId: "session-2", token: "token-2", provider: "ssh", target: "host", user: "user" },
    ]),
    selectProviderSession: jest.fn(() => true),
    readProvider: jest.fn(async () => ({ output: "selected", truncated: false })),
  } as unknown as RtermClient;
  const handler = new RemoteTerminalToolHandler({
    getRterm: () => rterm,
    onSessionSelected,
    requestApproval: jest.fn(async () => true),
  });

  await expect(
    handler.handle(params("read", { sessionId: "session-2" }) as never),
  ).resolves.toMatchObject({ success: true });
  expect(rterm.selectProviderSession).toHaveBeenCalledWith("session-2");
  expect(onSessionSelected).toHaveBeenCalledWith("thread-1", "session-2");
  expect(rterm.readProvider).toHaveBeenCalledWith(200, "session-2");
});

const params = (tool: string, args: Record<string, unknown> = {}) =>
  ({
    namespace: REMOTE_TERMINAL_NAMESPACE,
    tool,
    arguments: args,
    threadId: "thread-1",
    callId: "call-1",
  }) as Record<string, unknown>;

test("reads recent output with the host label", async () => {
  const { handler, rterm } = makeHandler();
  await expect(handler.handle(params("read", { maxLines: 20 }) as never)).resolves.toEqual({
    contentItems: [{ type: "inputText", text: "remote\nshell output" }],
    success: true,
  });
  expect(rterm.readProvider).toHaveBeenCalledWith(20, undefined);
});

test("normalizes read arguments and marks older output", async () => {
  const { handler, rterm } = makeHandler({
    getSnapshot: jest.fn(() => ({
      enabled: true,
      state: "connected" as const,
      output: "",
      hostLabel: "",
      authFailed: false,
    })),
    readProvider: jest.fn(async () => ({ output: "old", truncated: true })),
  });
  await expect(handler.handle(params("read", { maxLines: 999 }) as never)).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: "remote shell\nold\n[older output omitted]" }],
  });
  expect(rterm.readProvider).toHaveBeenCalledWith(200, undefined);
  await handler.handle({ ...params("read"), arguments: [] } as never);
  expect(rterm.readProvider).toHaveBeenLastCalledWith(200, undefined);
});

test("requires approval and returns completed execution output", async () => {
  const { handler, requestApproval, rterm } = makeHandler();
  await expect(
    handler.handle(params("execute", { command: "npm test", reason: "verify" }) as never),
  ).resolves.toEqual({
    contentItems: [{ type: "inputText", text: "completed; exitCode=0\ndone" }],
    success: true,
  });
  expect(requestApproval).toHaveBeenCalledWith("thread-1", "call-1", "npm test", "verify");
  expect(rterm.executeProvider).toHaveBeenCalledWith("npm test", undefined);
});

test("uses the default approval reason", async () => {
  const { handler, requestApproval } = makeHandler();
  await handler.handle(params("execute", { command: "pwd" }) as never);
  expect(requestApproval).toHaveBeenCalledWith("thread-1", "call-1", "pwd", "Run on remote.");
});

test("rejects invalid and unapproved commands", async () => {
  const empty = makeHandler();
  await expect(empty.handler.handle(params("execute") as never)).resolves.toMatchObject({
    success: false,
  });
  const rejected = makeHandler();
  rejected.requestApproval.mockResolvedValue(false);
  await expect(
    rejected.handler.handle(params("execute", { command: "rm -rf /" }) as never),
  ).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: "The user rejected the terminal command." }],
  });
  expect(rejected.rterm.executeProvider).not.toHaveBeenCalled();
});

test("reports unsupported tools, disconnected terminals, and timeouts", async () => {
  const unsupported = makeHandler();
  await expect(
    unsupported.handler.handle({ ...params("read"), namespace: "other" } as never),
  ).resolves.toMatchObject({ success: false });
  await expect(unsupported.handler.handle(params("unknown") as never)).resolves.toEqual({
    contentItems: [{ type: "inputText", text: "Unsupported remote terminal tool." }],
    success: false,
  });
  const disconnected = makeHandler({ executeProvider: jest.fn(async () => undefined) });
  await expect(
    disconnected.handler.handle(params("execute", { command: "pwd" }) as never),
  ).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: "The provider session is not connected." }],
  });
  const timeout = makeHandler({
    executeProvider: jest.fn(async () => {
      throw new Error("timeout");
    }),
  });
  await expect(
    timeout.handler.handle(params("execute", { command: "npm test" }) as never),
  ).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: expect.stringContaining("timeout") }],
  });
});
