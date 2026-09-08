/// <reference types="jest" />

import { CodexProjectManager } from "../../src/codex/projects";
import {
  CodexThreadLifecycle,
  type ThreadLifecycleRequestInput,
} from "../../src/codex/thread-lifecycle";
import { CodexThreadManager } from "../../src/codex/thread-manager";
import type { JsonRpcResponse } from "../../src/codex/protocol";

function fixture(requestAccepted = true) {
  const threadManager = new CodexThreadManager();
  const projectManager = new CodexProjectManager({
    request: jest.fn(() => true),
    onStateChanged: jest.fn(),
    setCommandNotice: jest.fn(),
    setConnectionError: jest.fn(),
  });
  const requests: Array<{
    message: ThreadLifecycleRequestInput;
    callback: (message: JsonRpcResponse<unknown>) => void;
  }> = [];
  const onStateChanged = jest.fn();
  const lifecycle = new CodexThreadLifecycle({
    threadManager,
    projectManager,
    request: (message, callback) => {
      requests.push({
        message,
        callback: callback as (message: JsonRpcResponse<unknown>) => void,
      });
      return requestAccepted;
    },
    onStateChanged,
    onThreadHydrated: jest.fn(),
    cancelModelPicker: jest.fn(),
    setStarting: jest.fn(),
    startTurn: jest.fn(),
  });
  return { lifecycle, threadManager, requests, onStateChanged };
}

test("removes a deleted thread and selects the next thread", () => {
  const { lifecycle, threadManager } = fixture();
  threadManager.threads.push({ id: "thread-1" } as never, { id: "thread-2" } as never);
  threadManager.thread("thread-1");
  threadManager.thread("thread-2");
  threadManager.select("thread-1");

  lifecycle.handleThreadRemoved("thread-1");

  expect(threadManager.selectedThreadId).toBe("thread-2");
  expect(threadManager.hasThread("thread-1")).toBe(false);
});

test("retains the model returned while resuming a thread", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.thread("thread-1");

  lifecycle.resumeThread("thread-1");
  requests[0].callback({
    id: 1,
    result: {
      model: "gpt-5",
      modelProvider: "openai",
      reasoningEffort: "medium",
    },
  });

  expect(threadManager.thread("thread-1").state.modelInfo).toEqual({
    model: "gpt-5",
    provider: "openai",
    reasoningEffort: "medium",
  });
});

test("refreshing a selected thread does not change its display position", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.threads.push(
    { id: "thread-1", status: { type: "idle" } } as never,
    { id: "thread-2", status: { type: "idle" } } as never,
  );
  threadManager.thread("thread-2");
  threadManager.select("thread-2");

  lifecycle.readThread("thread-2");
  requests[0].callback({
    id: 1,
    result: { thread: { id: "thread-2", status: { type: "idle" } } },
  });

  expect(threadManager.threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
});

test("starts a new thread using the active working directory", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.activeThread.setWorkingDirectory("/workspace/project");

  expect(lifecycle.startNew(undefined)).toBe(true);
  expect(requests[0].message).toMatchObject({
    method: "thread/start",
    params: { cwd: "/workspace/project", serviceName: "pesk" },
  });
});

test("sends archive and delete requests for the selected thread", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.select("thread-1");

  expect(lifecycle.archive()).toBe(true);
  expect(lifecycle.delete()).toBe(true);
  expect(requests.map(({ message }) => message.method)).toEqual([
    "thread/archive",
    "thread/delete",
  ]);
  requests[0].callback({ id: 1 });
  requests[1].callback({ id: 2 });
});

test("starts compaction for the selected idle thread", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.thread("thread-1");
  threadManager.select("thread-1");

  expect(lifecycle.compact()).toBe(true);
  expect(requests[0].message).toMatchObject({
    method: "thread/compact/start",
    params: { threadId: "thread-1" },
  });
  expect(threadManager.activeThread.state.status).toBe("working");
});

test("rejects compaction without an idle selected thread", () => {
  const { lifecycle, threadManager } = fixture();

  expect(lifecycle.compact()).toBe(false);

  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.thread("thread-1").setStatus("working");
  threadManager.select("thread-1");
  expect(lifecycle.compact()).toBe(false);
});

test("updates model metadata from lifecycle notifications", () => {
  const { lifecycle, threadManager } = fixture();
  const thread = threadManager.thread("thread-1");

  lifecycle.handleModelRerouted(
    {
      method: "model/rerouted",
      params: { threadId: "thread-1", fromModel: "gpt-4", toModel: "gpt-5" },
    } as never,
    thread,
  );
  lifecycle.handleSettingsUpdated(
    {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5",
          modelProvider: "openai",
          effort: "high",
          collaborationMode: { mode: "plan" },
        },
      },
    } as never,
    thread,
  );

  expect(thread.state.modelInfo).toMatchObject({
    model: "gpt-5",
    provider: "openai",
    reasoningEffort: "high",
  });
  expect(thread.state.collaborationMode).toBe("plan");
});

test("updates a thread project assignment from a lifecycle notification", () => {
  const { lifecycle, threadManager } = fixture();
  const thread = threadManager.thread("thread-1");

  lifecycle.handleProjectUpdated(
    {
      method: "thread/project/updated",
      params: { threadId: "thread-1", projectId: "project-1" },
    } as never,
    thread,
  );

  expect(thread.state.projectId).toBe("project-1");
});

test("resumes a selected disconnected thread", () => {
  const { lifecycle, threadManager, requests } = fixture();
  const thread = threadManager.thread("thread-1");
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.select("thread-1");

  lifecycle.select("thread-1");

  expect(requests[0].message.method).toBe("thread/resume");
});

test("rejects an invalid project root", () => {
  const { lifecycle } = fixture();

  expect(lifecycle.startProject("", "relative/path")).toBe(false);
});

test("publishes when a non-selected thread is removed", () => {
  const { lifecycle, threadManager } = fixture();
  threadManager.threads.push({ id: "thread-1" } as never, { id: "thread-2" } as never);
  threadManager.select("thread-1");

  lifecycle.handleThreadRemoved("thread-2");

  expect(threadManager.hasThread("thread-2")).toBe(false);
});

test("finishes a failed history page without publishing turns", () => {
  const { lifecycle, threadManager, requests } = fixture();
  threadManager.thread("thread-1");
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.select("thread-1");
  threadManager.beginHistoryPage("thread-1", true);
  threadManager.finishHistoryPage("thread-1", "cursor", true);

  const loading = lifecycle.loadOlderHistory();
  requests[0].callback({ id: 1 });

  return expect(loading).resolves.toBe(false);
});

test("publishes and finishes history loading when the server returns an error", async () => {
  const { lifecycle, threadManager, requests, onStateChanged } = fixture();
  threadManager.thread("thread-1");
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.select("thread-1");
  threadManager.beginHistoryPage("thread-1", true);
  threadManager.finishHistoryPage("thread-1", "cursor", true);

  const loading = lifecycle.loadOlderHistory();
  requests[0].callback({ id: 1, error: { code: -1, message: "unavailable" } });

  await expect(loading).resolves.toBe(false);
  expect(threadManager.historyState("thread-1").loading).toBe(false);
  expect(onStateChanged).toHaveBeenCalled();
});

test("finishes history loading when the request is rejected", async () => {
  const { lifecycle, threadManager, onStateChanged } = fixture(false);
  threadManager.thread("thread-1");
  threadManager.threads.push({ id: "thread-1" } as never);
  threadManager.select("thread-1");
  threadManager.beginHistoryPage("thread-1", true);
  threadManager.finishHistoryPage("thread-1", "cursor", true);

  await expect(lifecycle.loadOlderHistory()).resolves.toBe(false);
  expect(threadManager.historyState("thread-1").loading).toBe(false);
  expect(onStateChanged).toHaveBeenCalled();
});
