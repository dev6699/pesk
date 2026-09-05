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
});
