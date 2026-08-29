/** @jest-environment node */
/// <reference types="jest" />

import {
  approvalDecisions,
  describeSocketError,
  isJsonRpcResponse,
  isRecord,
  isThread,
  messageThreadId,
  records,
  requestIdKey,
  shouldReconcileOnIdle,
  shouldResumeOnActiveStatus,
  stringValue,
} from "../../src/codex/protocol";
import type { ServerMessage } from "../../src/codex/protocol";

const startedThreadMessage: Extract<
  ServerMessage,
  { method: "thread/started" }
> = {
  method: "thread/started",
  params: {
    thread: {
      id: "thread-2",
      sessionId: "session-2",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "idle" },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
  },
};

const approvalMessage: Extract<
  ServerMessage,
  { method: "item/commandExecution/requestApproval" }
> = {
  method: "item/commandExecution/requestApproval",
  id: "approval-1",
  params: {
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 0,
    environmentId: null,
    command: "npm test",
    reason: "run tests",
    proposedExecpolicyAmendment: ["npm", "test"],
    proposedNetworkPolicyAmendments: [
      { host: "registry.npmjs.org", action: "allow" },
    ],
  },
};

describe("Codex protocol helpers", () => {
  test("resumes an active session when Pesk is disconnected", () => {
    expect(shouldResumeOnActiveStatus(false, { type: "active" })).toBe(true);
  });

  test("does not resume an active session when already connected", () => {
    expect(shouldResumeOnActiveStatus(true, { type: "active" })).toBe(false);
  });

  test("reconciles after a working session becomes idle", () => {
    expect(shouldReconcileOnIdle("working", { type: "idle" }, false)).toBe(
      false,
    );
  });

  test("does not reconcile an idle session with a pending Pesk turn while disabled", () => {
    expect(shouldReconcileOnIdle("idle", { type: "idle" }, true)).toBe(false);
  });

  test("does not reconcile an active session without a pending turn", () => {
    expect(shouldReconcileOnIdle("working", { type: "active" }, false)).toBe(
      false,
    );
  });

  test("narrows JSON-RPC responses and records safely", () => {
    expect(isJsonRpcResponse({ id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ id: 1, method: "thread/list" })).toBe(false);
    expect(isRecord({ value: true })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(records([{ value: 1 }, null, "text"])).toEqual([{ value: 1 }]);
    expect(stringValue("value")).toBe("value");
    expect(stringValue("")).toBeUndefined();
  });

  test("extracts thread ids from thread-scoped messages", () => {
    expect(
      messageThreadId({
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "active", activeFlags: [] },
        },
      }),
    ).toBe("thread-1");
    expect(messageThreadId(startedThreadMessage)).toBe("thread-2");
  });

  test("validates discovered threads", () => {
    expect(isThread({ id: "thread-1", status: { type: "idle" } })).toBe(true);
    expect(isThread({ id: "thread-1" })).toBe(false);
  });

  test("normalizes approval decisions including policy amendments", () => {
    const decisions = approvalDecisions(approvalMessage);

    expect([...decisions.keys()]).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment:0",
    ]);
  });

  test("keeps request ids type-safe and lifecycle predicates deterministic", () => {
    expect(requestIdKey(4)).toBe("number:4");
    expect(requestIdKey("4")).toBe("string:4");
    expect(shouldResumeOnActiveStatus(false, { type: "active" })).toBe(true);
    expect(shouldResumeOnActiveStatus(true, { type: "active" })).toBe(false);
    expect(shouldReconcileOnIdle("working", { type: "idle" }, true)).toBe(
      false,
    );
  });

  test("formats socket errors with useful context", () => {
    expect(describeSocketError(new Error("offline"), "ws://server")).toBe(
      "url=ws://server; name=Error; message=offline",
    );
    expect(
      describeSocketError(
        { type: "error", error: { name: "NetworkError", message: "reset" } },
        "ws://server",
      ),
    ).toContain("error=reset");
  });
});
