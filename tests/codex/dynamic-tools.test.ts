/** @jest-environment node */
/// <reference types="jest" />

import { DynamicToolApprovalManager } from "../../src/codex/dynamic-tools";
import { REMOTE_TERMINAL_TOOLS } from "../../src/features/remote-terminal/tools";
import { CodexThreadManager } from "../../src/codex/thread-manager";

describe("dynamic tools", () => {
  test("advertises only the supported remote-terminal tools", () => {
    expect(REMOTE_TERMINAL_TOOLS[0].tools.map((tool) => tool.name)).toEqual(["read", "execute"]);
  });

  test("publishes and resolves an approved local tool request", async () => {
    const threadManager = new CodexThreadManager();
    const notifyStateChanged = jest.fn();
    const onAttentionCleared = jest.fn();
    const approvals = new DynamicToolApprovalManager({
      threadManager,
      notifyStateChanged,
      onAttentionCleared,
    });

    const result = approvals.request("thread-1", "call-1", "npm test", "Run the test suite.");
    expect(threadManager.thread("thread-1").state.pendingApproval).toMatchObject({
      requestId: "dynamic:call-1",
      command: "npm test",
      reason: "Run the test suite.",
    });
    expect(threadManager.nextAttention()).toBe("thread-1");
    expect(notifyStateChanged).toHaveBeenCalledTimes(1);

    expect(approvals.respond("dynamic:call-1", "approve")).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(threadManager.thread("thread-1").state.pendingApproval).toBeUndefined();
    expect(threadManager.nextAttention()).toBeUndefined();
    expect(onAttentionCleared).toHaveBeenCalledTimes(1);
  });

  test("resolves rejected requests and ignores unknown responses", async () => {
    const threadManager = new CodexThreadManager();
    const approvals = new DynamicToolApprovalManager({
      threadManager,
      notifyStateChanged: jest.fn(),
    });
    const result = approvals.request("thread-1", "call-2", "rm -i file", "Cleanup.");

    expect(approvals.respond("unknown", "approve")).toBe(false);
    expect(approvals.respond("dynamic:call-2", "reject")).toBe(true);
    await expect(result).resolves.toBe(false);
  });
});
