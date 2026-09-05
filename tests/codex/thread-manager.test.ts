/// <reference types="jest" />
/// <reference types="node" />

import { CodexThreadManager } from "../../src/codex/thread-manager";

describe("CodexThreadManager", () => {
  test("keeps selected and background threadInstances isolated", () => {
    const manager = new CodexThreadManager();
    manager.selectedThreadId = "selected";
    const selected = manager.activeThread;
    const background = manager.thread("background");

    selected.addMessage("user", "selected message");
    background.addMessage("user", "background message");

    expect(manager.activeThread).toBe(selected);
    expect(selected.state.history).toHaveLength(1);
    expect(background.state.history).toHaveLength(1);
    expect(selected.state.history[0].text).toBe("selected message");
  });

  test("retains completed background work until selection", () => {
    const manager = new CodexThreadManager();

    manager.completeBackgroundWork("thread-1");
    expect(manager.backgroundWorkSnapshot()).toEqual({ completed: 1, total: 1 });

    manager.selectedThreadId = "thread-1";
    manager.clearBackgroundWork("thread-1");
    expect(manager.backgroundWorkSnapshot()).toEqual({ completed: 0, total: 0 });
  });

  test("evicts only idle inactive threadInstances and keeps the selected thread", () => {
    const manager = new CodexThreadManager();
    manager.selectedThreadId = "selected";
    manager.thread("selected");

    for (let index = 0; index < 20; index += 1) {
      manager.thread(`inactive-${index}`);
    }
    const working = manager.thread("working");
    working.setStatus("working");
    for (let index = 20; index < 24; index += 1) {
      manager.thread(`inactive-${index}`);
    }

    expect(manager.getThreadMap().size).toBeLessThanOrEqual(16);
    expect(manager.getThreadMap().has("selected")).toBe(true);
    expect(manager.getThreadMap().has("working")).toBe(true);
  });

  test("passes background threads without changing selection", () => {
    const manager = new CodexThreadManager();
    manager.selectedThreadId = "selected";
    manager.thread("background");

    manager.withThread("background", (targetThread) => {
      expect(targetThread.id).toBe("background");
      expect(manager.activeThread.id).toBe("selected");
    });

    expect(manager.activeThread.id).toBe("selected");
  });

  test("correlates local thread start responses and notifications in either order", () => {
    const manager = new CodexThreadManager();

    manager.noteThreadStartRequest();
    manager.noteThreadStartResponse("thread-1");
    expect(manager.consumeLocalThreadStarted("thread-1")).toBe(true);

    manager.noteThreadStartRequest();
    expect(manager.consumeLocalThreadStarted("thread-2")).toBe(true);
    manager.noteThreadStartResponse("thread-2");
    expect(manager.consumeLocalThreadStarted("thread-2")).toBe(false);
  });

  test("owns history hydration and pending resume state", () => {
    const manager = new CodexThreadManager();

    manager.markHistoryPending("thread-1");
    expect(manager.selectedHistoryIsLoading()).toBe(false);
    manager.select("thread-1");
    expect(manager.selectedHistoryIsLoading()).toBe(true);

    const state = manager.beginHistoryPage("thread-1", true);
    expect(state?.loading).toBe(true);
    expect(manager.beginHistoryPage("thread-1", false)).toBeUndefined();
    manager.finishHistoryPage("thread-1", "next", true);
    expect(manager.selectedHistoryIsLoading()).toBe(false);
    expect(manager.selectedHistoryState()).toMatchObject({
      loading: false,
      nextCursor: "next",
      hasOlderHistory: true,
    });

    manager.setPendingResume("thread-1");
    expect(manager.consumePendingResume("other")).toBe(false);
    expect(manager.consumePendingResume("thread-1")).toBe(true);
    expect(manager.consumePendingResume("thread-1")).toBe(false);
  });

  test("clears read-only and exec ownership during thread removal and transport reset", () => {
    const manager = new CodexThreadManager();
    const thread = manager.thread("thread-1");

    manager.setReadOnly("thread-1", true);
    manager.trackExecProcess("process-1", thread);
    expect(manager.execThread("process-1")).toBe(thread);
    manager.remove("thread-1");
    expect(manager.execThread("process-1")).toBeUndefined();

    manager.trackExecProcess("process-2", thread);
    manager.clearTransportState();
    expect(manager.execThread("process-2")).toBeUndefined();
    expect(manager.selectedThreadId).toBeUndefined();
  });
});
