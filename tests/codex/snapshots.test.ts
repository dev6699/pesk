import { CodexThreadManager } from "../../src/codex/thread-manager";
import { CodexProjectManager } from "../../src/codex/projects";

describe("Codex component snapshots", () => {
  test("preserves the standalone conversation before a server thread is selected", () => {
    const manager = new CodexThreadManager();
    manager.activeThread.addMessage("user", "pending prompt");

    const snapshot = manager.snapshot();

    expect(snapshot.selectedId).toBeUndefined();
    expect(snapshot.current.thread.messages).toEqual([
      expect.objectContaining({ role: "user", text: "pending prompt" }),
    ]);
    expect(snapshot.current.history).toEqual({ loading: false, hasOlder: false });
  });

  test("reports pagination for the selected thread and retains background work", () => {
    const manager = new CodexThreadManager();
    manager.select("selected");
    manager.setReadOnly("selected", true);
    manager.beginHistoryPage("selected", true);
    manager.completeBackgroundWork("background");

    expect(manager.snapshot()).toMatchObject({
      selectedId: "selected",
      current: { readOnly: true, history: { loading: true, hasOlder: false } },
      backgroundWork: { completed: 1, total: 1 },
    });

    manager.finishHistoryPage("selected", "older-page", true);
    expect(manager.snapshot().current.history).toEqual({ loading: false, hasOlder: true });
  });

  test("isolates nested activity data in both directions while streaming continues", () => {
    const manager = new CodexThreadManager();
    manager.select("selected");
    const thread = manager.activeThread;
    thread.addActivity({ id: "command", type: "commandExecution", command: "pwd" }, "command");
    thread.appendActivityOutput("command", "first");
    const before = manager.snapshot();

    thread.appendActivityOutput("command", " second");
    expect(before.current.thread.messages[0].activity?.output).toBe("first");

    before.current.thread.messages[0].activity!.output = "consumer change";
    expect(manager.snapshot().current.thread.messages[0].activity?.output).toBe("first second");
  });

  test("does not expose the project cache through its snapshot", () => {
    const manager = new CodexProjectManager({
      request: () => false,
      onStateChanged: () => undefined,
      setCommandNotice: () => undefined,
      setConnectionError: () => undefined,
    });
    const snapshot = manager.snapshot();
    snapshot.items.length = 1;
    expect(manager.snapshot().items).toEqual([]);
  });
});
