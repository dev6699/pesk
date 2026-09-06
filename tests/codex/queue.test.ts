/** @jest-environment node */
import { CodexQueueManager } from "../../src/codex/queue";
import { CodexThreadManager } from "../../src/codex/thread-manager";
import type { JsonRpcResponse } from "../../src/codex/protocol";

test("refreshes every queue page through the owning thread manager", () => {
  const requests: Array<{
    request: unknown;
    callback: (message: JsonRpcResponse<unknown>) => void;
  }> = [];
  const threadManager = new CodexThreadManager();
  const publish = jest.fn();
  const manager = new CodexQueueManager({
    request: (request, callback) => {
      requests.push({ request, callback: callback as (message: JsonRpcResponse<unknown>) => void });
      return true;
    },
    threadManager,
    publishRendererState: publish,
  });

  manager.refresh("thread-1");
  expect(requests[0].request).toMatchObject({
    method: "thread/queue/list",
    params: { threadId: "thread-1", limit: 100 },
  });
  requests[0].callback({
    id: 1,
    result: {
      data: [{ id: "queued-1", input: [], clientUserMessageId: "client-1" }],
      nextCursor: "next",
    },
  });
  expect(requests[1].request).toMatchObject({
    method: "thread/queue/list",
    params: { threadId: "thread-1", cursor: "next", limit: 100 },
  });
  requests[1].callback({
    id: 2,
    result: {
      data: [{ id: "queued-2", input: [], clientUserMessageId: "client-2" }],
      nextCursor: null,
    },
  });

  expect(threadManager.thread("thread-1").state.queuedSubmissions).toHaveLength(2);
  expect(publish).toHaveBeenCalledTimes(2);
});

test("does not mutate state when the queue request is rejected", () => {
  const threadManager = new CodexThreadManager();
  const manager = new CodexQueueManager({
    request: () => false,
    threadManager,
    publishRendererState: jest.fn(),
  });

  manager.refresh("thread-1");

  expect(threadManager.thread("thread-1").state.queuedSubmissions).toEqual([]);
});

test("handles an empty queue response without requesting another page", () => {
  const requests: Array<(message: JsonRpcResponse<unknown>) => void> = [];
  const manager = new CodexQueueManager({
    request: (_request, callback) => {
      requests.push(callback as (message: JsonRpcResponse<unknown>) => void);
      return true;
    },
    threadManager: new CodexThreadManager(),
    publishRendererState: jest.fn(),
  });

  manager.refresh("thread-1");
  requests[0]({ id: 1, result: {} });

  expect(requests).toHaveLength(1);
});
