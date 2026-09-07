/** @jest-environment node */
/// <reference types="jest" />
import type { TurnStartResponse } from "../../src/codex-schema/v2";
import { CodexThreadManager } from "../../src/codex/thread-manager";
import { CodexTurnManager } from "../../src/codex/turn";
import type { JsonRpcResponse, OutgoingRequestInput } from "../../src/codex/protocol";

type PendingRequest = {
  request: OutgoingRequestInput;
  callback: (message: JsonRpcResponse<unknown>) => void;
};

function fixture() {
  const requests: PendingRequest[] = [];
  const threadManager = new CodexThreadManager();
  const publish = jest.fn();
  const manager = new CodexTurnManager({
    threadManager,
    request: (request, callback) => {
      requests.push({
        request,
        callback: callback as (message: JsonRpcResponse<unknown>) => void,
      });
      return true;
    },
    onStateChanged: publish,
  });
  return { manager, requests, publish, threadManager };
}

test("starts a turn with the thread collaboration mode and reconciles its response", () => {
  const { manager, requests, publish, threadManager } = fixture();
  const thread = threadManager.thread("thread-1");
  thread.setCollaborationMode("plan");
  thread.mergeModelInfo({ model: "gpt-test" });
  threadManager.select("thread-1");

  manager.start("thread-1", "make a plan");

  expect(requests[0].request).toMatchObject({
    method: "turn/start",
    params: {
      threadId: "thread-1",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-test", reasoning_effort: "medium" },
      },
    },
  });
  expect(thread.state.status).toBe("working");

  requests[0].callback({
    id: 1,
    result: { turn: { id: "turn-1" } } as TurnStartResponse,
  });

  expect(thread.state.activeTurnId).toBe("turn-1");
  expect(publish).toHaveBeenCalled();
});

test("completes a turn, applies usage, and requests queue refresh", () => {
  const { manager, threadManager } = fixture();
  const thread = threadManager.thread("thread-1");
  thread.setActiveTurn("turn-1");
  thread.setStatus("working");

  const result = manager.handleCompleted(
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
        },
      },
    } as never,
    thread,
    false,
  );

  expect(result).toEqual({ queueRefresh: "thread-1" });
  expect(thread.state.status).toBe("idle");
  expect(thread.state.tokenUsage).toMatchObject({ total: { inputTokens: 10 } });
});

test("preserves the prepared working state when its request is rejected", () => {
  const threadManager = new CodexThreadManager();
  const manager = new CodexTurnManager({
    threadManager,
    request: () => false,
    onStateChanged: jest.fn(),
  });

  manager.start("thread-1", "hello");

  expect(threadManager.thread("thread-1").state.status).toBe("working");
});

test("starts a default background turn without a selected model", () => {
  const { manager, requests, threadManager } = fixture();

  manager.start("thread-1", "hello");

  expect(requests[0].request).toMatchObject({
    method: "turn/start",
    params: {
      collaborationMode: { mode: "default", settings: { reasoning_effort: null } },
    },
  });
  expect(threadManager.hasBackgroundWork("thread-1")).toBe(true);
});

test("completes an unscoped turn without a queue refresh", () => {
  const { manager, threadManager } = fixture();
  const thread = threadManager.standaloneThread;

  const result = manager.handleCompleted(
    { method: "turn/completed", params: { turn: { status: "interrupted" } } } as never,
    thread,
    true,
  );

  expect(result).toEqual({ queueRefresh: undefined });
  expect(thread.state.status).toBe("idle");
});
