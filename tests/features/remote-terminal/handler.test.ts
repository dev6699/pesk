/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import { RemoteTerminalToolHandler } from "../../../src/features/remote-terminal/handler";
import type { RtermClient } from "../../../src/features/remote-terminal/rterm-client";
import {
  REMOTE_TERMINAL_EXECUTE_TOOL,
  REMOTE_TERMINAL_NAMESPACE,
  REMOTE_TERMINAL_READ_TOOL,
  REMOTE_TERMINAL_TOOLS,
} from "../../../src/features/remote-terminal/tools";

test("publishes the remote terminal namespace schema", () => {
  expect(REMOTE_TERMINAL_NAMESPACE).toBe("remote_terminal");
  expect(REMOTE_TERMINAL_READ_TOOL).toBe("read");
  expect(REMOTE_TERMINAL_EXECUTE_TOOL).toBe("execute");
  expect(REMOTE_TERMINAL_TOOLS[0]?.tools).toHaveLength(2);
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
    readRecent: jest.fn(() => ({ output: "shell output", truncated: false })),
    execute: jest.fn(() => ({
      id: "execution-1",
      status: "running" as const,
      output: "",
      startOffset: 0,
    })),
    wait: jest.fn(async () => ({
      id: "execution-1",
      status: "completed" as const,
      exitCode: 0,
      output: "done",
      startOffset: 0,
    })),
    ...overrides,
  } as unknown as RtermClient;
  const requestApproval = jest.fn(async () => true);
  return {
    handler: new RemoteTerminalToolHandler({ getRterm: () => rterm, requestApproval }),
    rterm,
    requestApproval,
  };
}

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
  expect(rterm.readRecent).toHaveBeenCalledWith(20);
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
    readRecent: jest.fn(() => ({ output: "old", truncated: true })),
  });
  await expect(handler.handle(params("read", { maxLines: 999 }) as never)).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: "remote shell\nold\n[older output omitted]" }],
  });
  expect(rterm.readRecent).toHaveBeenCalledWith(200);
  await handler.handle({ ...params("read"), arguments: [] } as never);
  expect(rterm.readRecent).toHaveBeenLastCalledWith(200);
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
  expect(rterm.execute).toHaveBeenCalledWith("npm test");
  expect(rterm.wait).toHaveBeenCalledWith("execution-1", 120000);
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
  expect(rejected.rterm.execute).not.toHaveBeenCalled();
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
  const disconnected = makeHandler({ execute: jest.fn(() => undefined) });
  await expect(
    disconnected.handler.handle(params("execute", { command: "pwd" }) as never),
  ).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: "The terminal is not connected." }],
  });
  const timeout = makeHandler({ wait: jest.fn(async () => undefined) });
  await expect(
    timeout.handler.handle(params("execute", { command: "npm test" }) as never),
  ).resolves.toMatchObject({
    contentItems: [{ type: "inputText", text: expect.stringContaining("120 seconds") }],
  });
});
