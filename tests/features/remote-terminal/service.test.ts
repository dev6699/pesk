/** @jest-environment node */
/// <reference types="jest" />

import { RemoteTerminalService } from "../../../src/features/remote-terminal/service";

test("delegates provider sessions and dynamic tools per thread", async () => {
  const selected = jest.fn();
  const service = new RemoteTerminalService({
    enabled: true,
    url: "http://remote:5000/provider/ssh",
    onChanged: jest.fn(),
    onSessionSelected: selected,
    requestApproval: jest.fn(async () => true),
  });
  expect(service.dynamicTools).toHaveLength(1);
  service.setCurrentThread("thread-1");
  expect(service.getEmbedUrl()).toContain("embed=1");
  expect(
    service.setProviderSession({
      sessionId: "session-1",
      token: "token-1",
      provider: "ssh",
      target: "test-host",
      user: "test-user",
    }),
  ).toBe(true);

  const result = await service.handleToolCall({
    namespace: "remote_terminal",
    tool: "sessions",
    arguments: {},
    threadId: "thread-1",
    callId: "call-1",
  } as never);
  expect(result.success).toBe(true);

  await service.handleToolCall({
    namespace: "remote_terminal",
    tool: "read",
    arguments: { sessionId: "session-1" },
    threadId: "thread-1",
    callId: "call-2",
  } as never);
  expect(selected).toHaveBeenCalledWith("thread-1", "session-1");
  expect(service.clearProviderSession("session-1")).toBe(true);
  service.disconnectAll();
});
