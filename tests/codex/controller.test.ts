/// <reference types="jest" />
/// <reference types="node" />

import { CodexController } from "../../src/codex";
import type { CodexThread } from "../../src/codex/thread";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  static shouldThrow = false;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public readonly url: string) {
    if (FakeWebSocket.shouldThrow) throw new Error("socket unavailable");
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, callback: (event: unknown) => void): void {
    const callbacks = this.listeners.get(event) ?? [];
    callbacks.push(callback);
    this.listeners.set(event, callbacks);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, value: unknown = {}): void {
    if (event === "open") this.readyState = FakeWebSocket.OPEN;
    const eventValue = event === "message" ? { data: value } : value;
    for (const callback of this.listeners.get(event) ?? []) callback(eventValue);
  }
}

function lastMessage(socket: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(socket.sent[socket.sent.length - 1].trim()) as Record<string, unknown>;
}

function respondHistoryPage(socket: FakeWebSocket, turns: unknown[]): void {
  socket.emit(
    "message",
    JSON.stringify({
      id: lastMessage(socket).id,
      result: { data: turns, nextCursor: null, backwardsCursor: null },
    }),
  );
}

function options() {
  return {
    publishRendererState: jest.fn(),
    publishStreamDelta: jest.fn(),
    handleNotification: jest.fn(),
    isChatVisible: jest.fn(() => false),
    clearNotification: jest.fn(),
    debug: jest.fn(),
  };
}

function connectedController(turns: unknown[] = [], nextCursor: string | null = null) {
  const controllerOptions = options();
  const controller = new CodexController(controllerOptions);
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  (controller as unknown as { connect: () => void }).connect();
  const socket = FakeWebSocket.instances.at(-1) as FakeWebSocket;

  socket.emit("open");
  expect(lastMessage(socket)).toMatchObject({ method: "initialize", id: 1 });
  socket.emit("message", JSON.stringify({ id: 1, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({
      id: 2,
      result: {
        data: [{ id: "thread-1", status: { type: "idle" } }],
      },
    }),
  );
  socket.emit("message", JSON.stringify({ id: 3, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({
      id: 4,
      result: {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
        },
      },
    }),
  );
  socket.emit(
    "message",
    JSON.stringify({
      id: 5,
      result: { data: turns, nextCursor, backwardsCursor: null },
    }),
  );

  return { controller, socket, options: controllerOptions };
}

function threadState(
  controller: CodexController,
  id = "thread-1",
): {
  activeTurnId?: string;
  status: "idle" | "working" | "waiting";
  connected: boolean;
  history: Array<{ role: string; text: string }>;
  prompts: Map<string, number>;
} {
  const internal = controller as unknown as {
    threadControllers: Map<string, { state: ReturnType<typeof threadState> }>;
  };
  return internal.threadControllers.get(id)!.state;
}

function threadRuntime(controller: CodexController, id = "thread-1"): CodexThread {
  const internal = controller as unknown as {
    threadControllers: Map<string, CodexThread>;
  };
  return internal.threadControllers.get(id)!;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldThrow = false;
});

describe("CodexController", () => {
  test("sends project CRUD mutations and accepts empty move/delete responses", async () => {
    const { controller, socket } = connectedController();
    const project = {
      id: "project-1",
      name: "Workspace",
      roots: [{ path: "/workspace" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    };
    const create = controller.createProject("Workspace", ["/workspace"], {}, "key-1");
    expect(lastMessage(socket)).toMatchObject({
      method: "project/create",
      params: { name: "Workspace", roots: [{ path: "/workspace" }], idempotencyKey: "key-1" },
    });
    socket.emit("message", JSON.stringify({ id: lastMessage(socket).id, result: { project } }));
    await expect(create).resolves.toBe(true);
    expect(controller.getState().projects).toEqual([project]);

    const move = controller.moveProject("project-1", null);
    expect(lastMessage(socket)).toMatchObject({
      method: "project/move",
      params: { projectId: "project-1", beforeProjectId: null },
    });
    socket.emit("message", JSON.stringify({ id: lastMessage(socket).id, result: {} }));
    await expect(move).resolves.toBe(true);

    const deletion = controller.deleteProject("project-1");
    expect(lastMessage(socket)).toMatchObject({
      method: "project/delete",
      params: { projectId: "project-1" },
    });
    socket.emit("message", JSON.stringify({ id: lastMessage(socket).id, result: {} }));
    await expect(deletion).resolves.toBe(true);
    expect(controller.getState().projects).toEqual([]);
  });

  test("starts a new thread with the selected project and root", async () => {
    const { controller, socket } = connectedController();
    const project = {
      id: "project-1",
      name: "Workspace",
      roots: [{ path: "/workspace" }, { path: "/shared" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    };
    const listing = controller.listProjects();
    expect(lastMessage(socket)).toMatchObject({ method: "project/list" });
    socket.emit(
      "message",
      JSON.stringify({ id: lastMessage(socket).id, result: { data: [project] } }),
    );
    expect(await listing).toBe(true);

    expect(controller.startProjectThread("project-1", "/shared")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: { projectId: "project-1", cwd: "/shared", serviceName: "pesk" },
    });
    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: startId, result: { thread: { id: "project-thread" } } }),
    );
    expect(controller.getState()).toMatchObject({
      threadId: "project-thread",
      projectId: "project-1",
      cwd: "/shared",
    });
  });

  test("rejects an unconfigured project root and reports start errors", async () => {
    const { controller, socket } = connectedController();
    const project = {
      id: "project-1",
      name: "Workspace",
      roots: [{ path: "/workspace" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    };
    const listing = controller.listProjects();
    socket.emit(
      "message",
      JSON.stringify({ id: lastMessage(socket).id, result: { data: [project] } }),
    );
    await listing;

    expect(controller.startProjectThread("project-1", "/missing")).toBe(false);
    expect(controller.getState().commandNotice).toContain("not configured");
    expect(controller.startProjectThread("project-1", "/workspace")).toBe(true);
    const startId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: startId, error: "start failed" }));
    expect(controller.getState().commandNotice).toBe("start failed");
  });

  test("logs connection and socket errors and retries after construction fails", () => {
    jest.useFakeTimers();
    FakeWebSocket.shouldThrow = true;
    const callbacks = options();
    const controller = new CodexController(callbacks);
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;

    (controller as unknown as { connect: () => void }).connect();
    expect(FakeWebSocket.instances).toHaveLength(0);
    jest.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(callbacks.debug).toHaveBeenCalledWith("Codex connection failed", expect.any(Error));
    jest.useRealTimers();
  });

  test("handles malformed messages and socket errors", () => {
    const callbacks = options();
    const controller = new CodexController(callbacks);
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];

    socket.emit("message", "not-json");
    socket.emit("error", {
      type: "error",
      message: "socket failed",
    });

    expect(callbacks.debug).toHaveBeenCalledWith(
      "Codex socket error",
      expect.stringContaining("message=socket failed"),
    );
    expect(controller.getState().error).toContain("message=socket failed");
    socket.emit("error", {
      type: "error",
      message: "socket failed",
    });
    expect(controller.getState().error).toContain("message=socket failed");
    socket.emit("open");
    expect(controller.getState().error).toBeUndefined();
  });

  test("ignores events from an obsolete socket after replacement", () => {
    const callbacks = options();
    const controller = new CodexController(callbacks);
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const first = FakeWebSocket.instances[0];
    const internal = controller as unknown as {
      socket: FakeWebSocket | null;
      connect: () => void;
    };
    internal.socket = null;
    internal.connect();
    const second = FakeWebSocket.instances[1];

    first.emit("close", { code: 1006, reason: "obsolete" });
    first.emit("error", { message: "obsolete error" });

    expect(internal.socket).toBe(second);
    expect(callbacks.debug).not.toHaveBeenCalledWith("Codex socket closed", expect.anything());
  });

  test("does not reconnect after an explicit stop", () => {
    jest.useFakeTimers();
    try {
      const controller = new CodexController(options());
      (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
      (controller as unknown as { connect: () => void }).connect();
      const socket = FakeWebSocket.instances[0];

      socket.emit("close", { code: 1006, reason: "server restarted" });
      controller.stop();
      jest.advanceTimersByTime(3000);

      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("clears the selected session and history when the socket closes", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string }>;
    };
    threadState(controller).history.push({
      role: "assistant",
      text: "previous response",
    });
    internal.threads = [{ id: "thread-1" }];

    socket.emit("close", { code: 1006, reason: "server restarted" });

    expect(controller.getState()).toMatchObject({
      threadId: undefined,
      threads: [],
      connected: false,
    });
    expect(controller.getState().history).toEqual([
      { role: "assistant", text: "previous response" },
    ]);
    controller.stop();
  });

  test("ignores responses that arrive from a closed socket", () => {
    const { controller, socket } = connectedController();
    controller.refreshRateLimits();
    const requestId = lastMessage(socket).id;

    socket.emit("close", { code: 1006, reason: "server restarted" });
    socket.emit(
      "message",
      JSON.stringify({
        id: requestId,
        result: { rateLimits: { primary: { usedPercent: 99 } } },
      }),
    );

    expect(controller.getState().rateLimits).toBeUndefined();
    controller.stop();
  });

  test("clears stale history after reconnect when no active session exists", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      history: Array<{ role: string; text: string }>;
      threadId: string;
      discover: () => void;
    };
    internal.history = [{ role: "assistant", text: "stale response" }];
    internal.threadId = "stale-thread";
    internal.discover();

    const threadListId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: threadListId, result: { data: [] } }));

    expect(controller.getState()).toMatchObject({
      threadId: undefined,
      history: [],
      threads: [],
    });
  });

  test("covers controller guards and failed turn paths", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as Record<string, (...args: unknown[]) => unknown>;
    const state = controller as unknown as {
      threads: Array<{ id: string }>;
    };

    controller.setSocketUrl("ws://example.test:4500");
    internal.connect();
    controller.selectThread("missing-thread");
    controller.selectThread("thread-1");
    state.threads = [{ id: "thread-1" }];
    controller.selectThread("missing-thread");
    controller.selectThread("thread-1");
    controller.respondPermission(1, "invalid");
    controller.respondPermission("missing", "allow");
    controller.submitPrompt("failed turn");
    const turnId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: turnId, error: { message: "failed" } }));
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().threadId).toBe("thread-1");
  });

  test("publishes a successful rate-limit refresh and suppresses duplicates", () => {
    const { controller, socket, options: callbacks } = connectedController();

    controller.refreshRateLimits();
    const requestId = lastMessage(socket).id;
    controller.refreshRateLimits();
    expect(
      socket.sent.filter((message) => message.includes('"account/rateLimits/read"')),
    ).toHaveLength(1);

    socket.emit(
      "message",
      JSON.stringify({
        id: requestId,
        result: { rateLimits: { primary: { usedPercent: 42 } } },
      }),
    );

    expect(controller.getState().rateLimits).toEqual({
      primary: { usedPercent: 42 },
    });
    expect(callbacks.publishRendererState).toHaveBeenCalled();
  });

  test("returns fuzzy-search results and handles server failures", async () => {
    const { controller, socket, options: callbacks } = connectedController();

    const search = controller.fuzzyFileSearch("codex", ["/workspace"]);
    const requestId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: requestId,
        result: { files: [{ path: "/workspace/codex.ts" }] },
      }),
    );
    await expect(search).resolves.toEqual([{ path: "/workspace/codex.ts" }]);

    const failedSearch = controller.fuzzyFileSearch("missing", ["/workspace"]);
    const failedRequestId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: failedRequestId, error: { message: "failed" } }));
    await expect(failedSearch).resolves.toEqual([]);
    expect(callbacks.debug).toHaveBeenCalledWith(
      "Fuzzy file search failed",
      expect.objectContaining({ message: "failed" }),
    );
    await expect(controller.fuzzyFileSearch("ignored", [])).resolves.toEqual([]);
  });

  test("finishes a review as idle when the review request fails", () => {
    const { controller, socket } = connectedController();

    expect(controller.startReview("inspect this")).toBe(true);
    const requestId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: requestId, error: { message: "review failed" } }));

    expect(controller.getState()).toMatchObject({
      status: "idle",
    });
  });

  test("records failed exec output and decodes streamed output", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/exec printf hello")).toBe(true);
    const execRequestId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        method: "command/exec/outputDelta",
        params: {
          processId: "pesk-exec-" + execRequestId,
          deltaBase64: Buffer.from("partial").toString("base64"),
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        id: execRequestId,
        error: { message: "command failed" },
      }),
    );

    expect(controller.getState().history.at(-1)).toMatchObject({
      activity: { kind: "command", status: "failed", output: "partial" },
    });
  });

  test("does not interrupt or start a thread while disconnected or busy", () => {
    const { controller, socket } = connectedController();

    socket.emit("close", { code: 1006, reason: "offline" });
    expect(controller.interruptTurn()).toBe(false);
    expect(controller.startNewThread("/workspace/next")).toBe(false);
    controller.stop();
  });

  test("waits for active status when the rollout is not ready", () => {
    jest.useFakeTimers();
    const { controller, socket } = connectedController();
    const internal = controller as unknown as Record<string, (...args: unknown[]) => unknown>;
    threadState(controller).connected = false;

    internal.resume("thread-1");
    const resumeId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: resumeId,
        error: { message: "no rollout found" },
      }),
    );
    jest.advanceTimersByTime(3000);

    expect(socket.sent.map((message) => JSON.parse(message.trim()))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/resume",
          params: expect.objectContaining({ threadId: "thread-1" }),
        }),
      ]),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-1" },
    });
    jest.useRealTimers();
  });

  test("resumes a disconnected controller on an active status", () => {
    const { controller, socket } = connectedController();
    threadState(controller).connected = false;

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-1" },
    });
  });

  test("rejects invalid prompts and queues prompts while a turn is active", () => {
    const { controller } = connectedController();

    expect(controller.submitPrompt("   ")).toBe(false);
    expect(controller.submitPrompt("first prompt")).toBe(true);
    expect(controller.submitPrompt("second prompt")).toBe(true);
  });

  test("does not prepare a turn for a mode-only command", () => {
    const { controller } = connectedController();

    expect(controller.submitPrompt("/plan")).toBe(true);
    expect(controller.getState()).toMatchObject({
      status: "idle",
      collaborationMode: "plan",
      workingSince: undefined,
    });
  });

  test("sets a native goal without echoing the objective as a user message", () => {
    const { controller, socket } = connectedController();
    const objective = "Prepare a verified weekend itinerary with a complete budget";

    expect(controller.submitPrompt(`/goal ${objective}`)).toBe(true);
    const goalRequest = lastMessage(socket);
    expect(goalRequest).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-1", objective, status: "active" },
    });

    socket.emit(
      "message",
      JSON.stringify({
        id: goalRequest.id,
        result: {
          goal: {
            threadId: "thread-1",
            objective,
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
      }),
    );

    expect(socket.sent.map((entry) => JSON.parse(entry).method)).not.toContain("turn/start");
    expect(controller.getState().goal).toMatchObject({ objective, status: "active" });
  });

  test("maps goal pause, resume, and clear commands to native lifecycle requests", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/goal pause")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "paused" },
    });

    expect(controller.submitPrompt("/goal resume")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "active" },
    });

    expect(controller.submitPrompt("/goal clear")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/goal/clear",
      params: { threadId: "thread-1" },
    });
  });

  test("starts manual compaction for the selected idle thread", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/compact")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/compact/start",
      params: { threadId: "thread-1" },
    });
    expect(threadState(controller).status).toBe("working");

    socket.emit("message", JSON.stringify({ id: lastMessage(socket).id, result: {} }));
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "compact-turn",
          item: { id: "compact-item", type: "contextCompaction" },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "compact-turn",
          item: { id: "compact-item", type: "contextCompaction" },
        },
      }),
    );
    const compactedItem = threadState(controller).history.find(
      (item) => (item as { itemId?: string }).itemId === "compact-item",
    ) as { activity?: { status?: string } } | undefined;
    expect(compactedItem?.activity?.status).toBe("completed");
    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "compact-turn", status: "completed" } },
      }),
    );
    expect(threadState(controller).status).toBe("idle");
  });

  test("rejects manual compaction without an idle selected thread", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as { threadId: string | undefined };
    internal.threadId = undefined;

    expect(controller.submitPrompt("/compact")).toBe(false);
    expect(controller.getState().commandNotice).toBe("No active thread to compact.");
    expect(socket.sent.map((entry) => JSON.parse(entry).method)).not.toContain(
      "thread/compact/start",
    );

    internal.threadId = "thread-1";
    threadRuntime(controller).setStatus("working");
    expect(controller.submitPrompt("/compact")).toBe(false);
    expect(controller.getState().commandNotice).toBe(
      "Wait for the current turn to finish before compacting.",
    );
    expect(socket.sent.map((entry) => JSON.parse(entry).method)).not.toContain(
      "thread/compact/start",
    );
  });

  test("reports a manual compaction request failure", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/compact")).toBe(true);
    const requestId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: requestId, error: { message: "compaction unavailable" } }),
    );

    expect(threadState(controller).status).toBe("idle");
    expect(controller.getState().commandNotice).toBe("Unable to compact the current thread.");
  });

  test("routes background goal notifications to the owning thread", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/goal/updated",
        params: {
          threadId: "other-thread",
          goal: { threadId: "other-thread", objective: "background goal", status: "active" },
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(threadRuntime(controller, "other-thread").state.goal?.objective).toBe("background goal");
    expect(threadRuntime(controller).state.goal).toBeUndefined();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/goal/cleared",
        params: { threadId: "other-thread" },
      }),
    );

    expect(threadRuntime(controller, "other-thread").state.goal).toBeUndefined();
  });

  test("edits an existing goal through thread/goal/set", () => {
    const { controller, socket } = connectedController();
    threadRuntime(controller).setGoal({
      threadId: "thread-1",
      objective: "old objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 12,
      timeUsedSeconds: 4,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(controller.submitPrompt("/goal edit new objective")).toBe(true);
    const request = lastMessage(socket);
    expect(request).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-1", objective: "new objective" },
    });
    expect(request.params).not.toHaveProperty("status");
  });

  test("shows current goal details for bare goal command", () => {
    const { controller, socket } = connectedController();
    threadRuntime(controller).setGoal({
      threadId: "thread-1",
      objective: "say hi",
      status: "complete",
      tokenBudget: null,
      tokensUsed: 9710,
      timeUsedSeconds: 3,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(controller.submitPrompt("/goal")).toBe(true);
    expect(controller.getState().commandNotice).toBe(
      [
        "Goal",
        "Status: complete",
        "Objective: say hi",
        "Time used: 3s",
        "Tokens used: 9.71K",
        "Commands: /goal edit <objective>, /goal clear",
      ].join("\n"),
    );
    expect(socket.sent.map((entry) => JSON.parse(entry).method)).not.toContain("turn/start");
  });

  test("handles goal edit and lifecycle request failures", () => {
    const { controller, socket, options: callbacks } = connectedController();
    const runtime = threadRuntime(controller);
    runtime.setGoal({
      threadId: "thread-1",
      objective: "old objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(controller.submitPrompt("/goal edit")).toBe(true);
    expect(controller.getState().commandNotice).toContain("Usage: /goal edit");
    runtime.setGoal(undefined);
    expect(controller.submitPrompt("/goal edit")).toBe(true);
    expect(controller.getState().commandNotice).toContain("No goal is currently set");

    expect(controller.submitPrompt("/goal replacement")).toBe(true);
    const failedSetId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: failedSetId, error: { message: "denied" } }));
    expect(controller.getState().error).toContain("Unable to create the goal");
    expect(callbacks.publishRendererState).toHaveBeenCalled();

    expect(controller.submitPrompt("/goal clear")).toBe(true);
    const clearId = lastMessage(socket).id;
    socket.emit("message", JSON.stringify({ id: clearId, result: { cleared: false } }));
    expect(controller.getState().goal).toBeUndefined();

    const internal = controller as unknown as { restoreGoal: (threadId: string) => void };
    internal.restoreGoal("thread-1");
    const restoreId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: restoreId,
        result: { goal: { threadId: "thread-1", objective: "restored", status: "active" } },
      }),
    );
    expect(controller.getState().goal?.objective).toBe("restored");
  });

  test("rejects thread lifecycle commands without a selected thread", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as { threadId?: string; threads: unknown[] };
    internal.threadId = undefined;
    internal.threads = [];

    expect(controller.submitPrompt("/archive")).toBe(false);
    expect(controller.submitPrompt("/delete")).toBe(false);
    expect(controller.submitPrompt("/fork")).toBe(false);

    expect(controller.submitPrompt("!echo hello")).toBe(true);
    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: startId,
        result: { thread: { id: "shell-thread", status: { type: "idle" } } },
      }),
    );
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/shellCommand",
      params: { threadId: "shell-thread", command: "echo hello" },
    });
  });

  test("sends archive and delete requests for the selected thread", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/archive")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/archive",
      params: { threadId: "thread-1" },
    });

    expect(controller.submitPrompt("/delete")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/delete",
      params: { threadId: "thread-1" },
    });
  });

  test("does not synthesize a visible continuation prompt after an idle turn", () => {
    const { controller, socket } = connectedController();
    const runtime = threadRuntime(controller);
    runtime.setGoal({
      threadId: "thread-1",
      objective: "Produce a verified final report",
      status: "active",
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 1,
    });
    runtime.setStatus("working");

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { status: "completed" } },
      }),
    );

    expect(socket.sent.map((entry) => JSON.parse(entry).method)).not.toContain("turn/start");
  });

  test("wraps steer input and keeps the wrapped text in history", () => {
    const { controller, socket } = connectedController();
    const state = threadState(controller);
    state.activeTurnId = "turn-1";
    state.status = "working";

    expect(controller.steerPrompt("Change New York to Osaka instead.")).toBe(true);

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/steer",
      params: {
        input: [
          {
            type: "text",
            text: expect.stringContaining(
              "Preserve all existing requirements, constraints, entities, and output formats",
            ),
          },
        ],
      },
    });
    expect(lastMessage(socket).params).toEqual(
      expect.objectContaining({
        input: [
          expect.objectContaining({
            text: expect.stringContaining("Change New York to Osaka instead."),
          }),
        ],
      }),
    );
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: expect.stringContaining(
            "Treat this message as a steer to the currently active request.",
          ),
        }),
      ]),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: {
            type: "userMessage",
            content: [{ text: "Change New York to Osaka instead." }],
          },
        },
      }),
    );
    expect(controller.getState().history.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
  });

  test("queues a normal prompt while a turn is active", () => {
    const { controller, socket } = connectedController();
    const state = threadState(controller);
    state.activeTurnId = "turn-1";
    state.status = "working";

    expect(controller.submitPrompt("run this after the current turn")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/queue/add",
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "run this after the current turn",
          },
        ],
      },
    });
    expect(controller.getState().queuedSubmissions).toEqual([
      expect.objectContaining({
        text: "run this after the current turn",
      }),
    ]);
  });

  test("sends images with an idle turn and keeps them in history", () => {
    const { controller, socket } = connectedController();
    const image = { url: "data:image/png;base64,abc", name: "screen.png" };

    expect(controller.submitPromptWithImages("inspect this", [image])).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          { type: "text", text: "inspect this" },
          { type: "image", url: image.url },
        ],
      },
    });
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "inspect this",
          images: [{ url: image.url, name: image.name }],
        }),
      ]),
    );
  });

  test("preserves images in an active-turn queue and when it starts", () => {
    const { controller, socket } = connectedController();
    const state = threadState(controller);
    state.activeTurnId = "turn-1";
    state.status = "working";
    const image = { url: "data:image/png;base64,queued", name: "queued.png" };

    expect(controller.submitPromptWithImages("inspect later", [image])).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/queue/add",
      params: {
        input: [
          { type: "text", text: "inspect later" },
          { type: "image", url: image.url },
        ],
      },
    });
    expect(controller.getState().queuedSubmissions).toEqual([
      expect.objectContaining({ images: [{ url: image.url, name: image.name }] }),
    ]);

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-2",
          item: {
            type: "userMessage",
            content: [
              { type: "text", text: "inspect later" },
              { type: "image", url: image.url },
            ],
          },
        },
      }),
    );
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "inspect later",
          images: [{ url: image.url }],
        }),
      ]),
    );
  });

  test("starts a new session when no session is selected", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));

    expect(controller.submitPrompt("start a session")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      id: 3,
      params: { cwd: process.cwd() },
    });

    socket.emit(
      "message",
      JSON.stringify({
        id: 3,
        result: { thread: { id: "new-thread", cwd: "/workspace/new-project" } },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: { threadId: "new-thread" },
    });
    expect(controller.getState().connected).toBe(true);
    expect(
      (threadState(controller, "new-thread") as { workingDirectory?: string }).workingDirectory,
    ).toBe("/workspace/new-project");
  });

  test("treats /new as a new-session command", () => {
    const { controller, socket } = connectedController(
      [
        {
          items: [{ type: "userMessage", content: [{ text: "old message" }] }],
        },
      ],
      "older",
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { totalTokens: 1650 },
          },
        },
      }),
    );
    expect(controller.getState().tokenUsage?.total.totalTokens).toBe(1650);

    expect(controller.startNewThread()).toBe(true);
    expect(controller.getState().tokenUsage).toBeUndefined();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: { total: { totalTokens: 2200 } },
        },
      }),
    );
    expect(controller.getState().tokenUsage).toBeUndefined();
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: { serviceName: "pesk" },
    });

    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: startId, result: { thread: { id: "new-thread" } } }),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: { total: { totalTokens: 2300 } },
        },
      }),
    );
    expect(controller.getState().tokenUsage).toBeUndefined();

    expect(controller.getState()).toMatchObject({
      threadId: "new-thread",
      history: [],
      connected: true,
    });
  });

  test("forks and selects the current thread with copied history", () => {
    const { controller, socket } = connectedController();
    controller.submitPrompt("/plan");

    expect(controller.submitPrompt("/fork")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/fork",
      params: { threadId: "thread-1", excludeTurns: true },
    });

    socket.emit(
      "message",
      JSON.stringify({
        id: lastMessage(socket).id,
        result: {
          thread: {
            id: "forked-thread",
            cwd: "/workspace/project",
            status: { type: "idle" },
            turns: [
              {
                items: [
                  { type: "userMessage", content: [{ text: "copied prompt" }] },
                  { type: "agentMessage", text: "copied response" },
                ],
              },
            ],
          },
          model: "gpt-5",
          modelProvider: "openai",
          reasoningEffort: "high",
        },
      }),
    );

    const pageId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: pageId,
        result: {
          data: [
            {
              id: "fork-turn",
              createdAt: 1,
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "copied-user",
                  clientId: null,
                  content: [{ text: "copied prompt" }],
                },
                {
                  type: "agentMessage",
                  id: "copied-agent",
                  text: "copied response",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                },
              ],
              itemsView: "full",
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        },
      }),
    );

    expect(controller.getState()).toMatchObject({
      threadId: "forked-thread",
      connected: true,
      collaborationMode: "plan",
      modelInfo: {
        model: "gpt-5",
        provider: "openai",
        reasoningEffort: "high",
      },
      commandNotice: "Thread forked — switched to forked-thread",
      history: [
        expect.objectContaining({ role: "user", text: "copied prompt" }),
        expect.objectContaining({ role: "assistant", text: "copied response" }),
      ],
    });
  });

  test("starts a new thread in the requested working directory", () => {
    const { controller, socket } = connectedController();

    expect(controller.startNewThread("/workspace/other-project")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/workspace/other-project",
      },
    });
  });

  test("starts a new thread while the selected thread is working", () => {
    const { controller, socket } = connectedController();
    threadState(controller).status = "working";
    threadState(controller).activeTurnId = "turn-1";

    expect(controller.startNewThread()).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: { serviceName: "pesk" },
    });
    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: startId, result: { thread: { id: "new-thread" } } }),
    );
    expect(controller.getState().threadId).toBe("new-thread");
  });

  test("reuses the current thread working directory for a new thread", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "current-thread",
            cwd: "/workspace/current-project",
          },
        },
      }),
    );

    expect(controller.startNewThread()).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/workspace/current-project",
      },
    });
  });

  test("restores user and assistant history from a session", () => {
    const { controller } = connectedController([
      {
        createdAt: 1_700_000_000,
        tokenUsage: {
          total: { totalTokens: 1650 },
        },
        items: [
          {
            type: "userMessage",
            content: [{ text: "Remember this" }],
          },
          {
            type: "agentMessage",
            content: [{ text: "I remember it" }],
          },
        ],
      },
    ]);

    expect(controller.getState().history).toEqual([
      expect.objectContaining({ role: "user", text: "Remember this" }),
      expect.objectContaining({ role: "assistant", text: "I remember it" }),
    ]);
    expect(controller.getState().tokenUsage?.total.totalTokens).toBe(1650);
  });

  test("keeps generic activity after idle history reconciliation", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      read: (threadId: string) => void;
    };

    internal.read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
        result: {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                items: [
                  {
                    id: "search-1",
                    type: "webSearch",
                    status: "completed",
                    query: "weather today",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    respondHistoryPage(socket, [
      {
        items: [{ id: "search-1", type: "webSearch", status: "completed", query: "weather today" }],
      },
    ]);

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "search-1",
          activity: expect.objectContaining({ kind: "webSearch" }),
        }),
      ]),
    );
  });

  test("preserves repeated user messages from separate turns", () => {
    const { controller } = connectedController([
      {
        items: [
          { type: "userMessage", content: [{ text: "same prompt" }] },
          { type: "agentMessage", text: "working" },
          { type: "userMessage", content: [{ text: "same prompt" }] },
        ],
      },
    ]);

    expect(
      controller
        .getState()
        .history.filter((message) => message.role === "user" && message.text === "same prompt"),
    ).toHaveLength(2);
  });

  test("shows the same message when submitted again from Pesk", () => {
    const { controller } = connectedController();
    expect(controller.submitPrompt("repeat this message")).toBe(true);
    threadRuntime(controller).setStatus("idle");
    expect(controller.submitPrompt("repeat this message")).toBe(true);
    expect(
      controller
        .getState()
        .history.filter(
          (message) => message.role === "user" && message.text === "repeat this message",
        ),
    ).toHaveLength(2);
  });

  test("reconciles history when the active turn becomes idle", () => {
    const { controller, socket } = connectedController();

    controller.submitPrompt("reconcile me");
    const sentBeforeStatusChanges = socket.sent.length;
    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "idle" } },
      }),
    );

    expect(
      socket.sent.slice(sentBeforeStatusChanges).map((message) => JSON.parse(message.trim())),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/read",
          params: { threadId: "thread-1" },
        }),
      ]),
    );
  });

  test("keeps a locally submitted message during incomplete reconciliation", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      read: (threadId: string) => void;
    };

    controller.submitPrompt("message from Pesk");
    internal.read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
        result: {
          thread: {
            status: { type: "idle" },
            turns: [
              {
                items: [{ type: "agentMessage", text: "partial server history" }],
              },
            ],
          },
        },
      }),
    );

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "message from Pesk" }),
      ]),
    );
  });

  test("handles thread notifications, user items, output deltas, and completion", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "started-thread" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-2",
          item: { content: [{ text: "remote prompt" }] },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: "standalone output" },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "completed output" } },
      }),
    );

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "remote prompt" }),
        expect.objectContaining({
          role: "assistant",
          text: "completed output",
        }),
      ]),
    );
  });

  test("publishes assistant completion before the next tool item update", () => {
    const { socket, options: callbacks } = connectedController();
    callbacks.publishRendererState.mockClear();
    callbacks.publishStreamDelta.mockClear();

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "assistant-1",
          delta: "first **world**",
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: { id: "assistant-1", type: "agentMessage", text: "first **world**" },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "command-1", type: "commandExecution", command: "npm test" },
        },
      }),
    );

    expect(callbacks.publishStreamDelta).toHaveBeenCalledWith({
      threadId: "thread-1",
      itemId: "assistant-1",
      kind: "assistant",
      delta: "",
      completed: true,
    });
    expect(callbacks.publishStreamDelta.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.publishRendererState.mock.invocationCallOrder.at(-1) ?? Infinity,
    );
  });

  test("waits for active status before resuming an externally announced thread", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "external-thread" } },
      }),
    );

    expect(lastMessage(socket).method).not.toBe("thread/resume");
    expect(controller.getState().threadId).toBe("external-thread");

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          threadId: "external-thread",
          status: { type: "active", activeFlags: [] },
        },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "external-thread" },
    });
  });

  test("does not resume a thread created by the local thread/start request", () => {
    const { controller, socket } = connectedController();

    expect(controller.startNewThread()).toBe(true);
    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: startId,
        result: { thread: { id: "local-thread" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "local-thread" } },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: { serviceName: "pesk" },
    });
  });

  test("exposes model information nested in the thread/start response", () => {
    const { controller, socket } = connectedController();

    expect(controller.startNewThread()).toBe(true);
    const startId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: startId,
        result: {
          thread: {
            id: "model-thread",
            modelProvider: "openai",
          },
          model: "gpt-5",
          reasoningEffort: "high",
          serviceTier: "fast",
        },
      }),
    );

    expect(controller.getState().modelInfo).toEqual({
      model: "gpt-5",
      provider: "openai",
      reasoningEffort: "high",
      serviceTier: "fast",
    });
  });

  test("stores thread token usage updates for the renderer", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            totalTokenUsage: {
              inputTokens: 1200,
              cachedInputTokens: 300,
              outputTokens: 450,
              totalTokens: 1650,
            },
            lastTurnUsage: { totalTokens: 900 },
            modelContextWindow: 128000,
          },
        },
      }),
    );

    expect(controller.getState().tokenUsage).toEqual({
      total: {
        inputTokens: 1200,
        cachedInputTokens: 300,
        outputTokens: 450,
        reasoningOutputTokens: undefined,
        totalTokens: 1650,
      },
      last: {
        inputTokens: undefined,
        cachedInputTokens: undefined,
        outputTokens: undefined,
        reasoningOutputTokens: undefined,
        totalTokens: 900,
      },
      modelContextWindow: 128000,
    });
  });

  test("stores token usage included in turn completion", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: {
          turn: {
            tokenUsage: {
              totalTokenUsage: { totalTokens: 2100 },
              modelContextWindow: 128000,
            },
          },
        },
      }),
    );

    expect(controller.getState().tokenUsage?.total.totalTokens).toBe(2100);
    expect(controller.getState().tokenUsage?.modelContextWindow).toBe(128000);
  });

  test("stores token usage included in an interrupted turn completion", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "other-thread",
          turn: {
            status: "interrupted",
            usage: { total: { totalTokens: 900 } },
          },
        },
      }),
    );

    expect(controller.getState().tokenUsage).toBeUndefined();
    expect(threadRuntime(controller, "other-thread").state.tokenUsage?.total.totalTokens).toBe(900);
  });

  test("does not clear live token usage when history has no persisted usage", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: { total: { totalTokens: 3200 } },
        },
      }),
    );

    (controller as unknown as { read: (id: string) => void }).read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
      }),
    );

    expect(controller.getState().tokenUsage?.total.totalTokens).toBe(3200);
  });

  test("accepts the current app-server token usage shape", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 3200,
              inputTokens: 2000,
              cachedInputTokens: 500,
              cacheWriteInputTokens: 100,
              outputTokens: 1200,
              reasoningOutputTokens: 300,
            },
            last: {
              totalTokens: 1600,
              inputTokens: 1000,
              cachedInputTokens: 200,
              cacheWriteInputTokens: 50,
              outputTokens: 600,
              reasoningOutputTokens: 150,
            },
            modelContextWindow: 128000,
          },
        },
      }),
    );

    expect(controller.getState().tokenUsage).toEqual({
      total: {
        totalTokens: 3200,
        inputTokens: 2000,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 100,
        outputTokens: 1200,
        reasoningOutputTokens: 300,
      },
      last: {
        totalTokens: 1600,
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteInputTokens: 50,
        outputTokens: 600,
        reasoningOutputTokens: 150,
      },
      modelContextWindow: 128000,
    });
  });

  test("uses waiting status for approval-active sessions", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          threadId: "thread-1",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "npm test",
          reason: "Run the tests",
        },
      }),
    );

    expect(controller.getState().status).toBe("waiting");
  });

  test("retries after the WebSocket closes and reconnects", () => {
    jest.useFakeTimers();
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;

    controller.start();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.emit("open");
    firstSocket.emit("close");

    expect(FakeWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(3000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    controller.stop();
    jest.useRealTimers();
  });

  test("stays healthy when connected without an active session", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];

    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));

    expect(controller.getState()).toMatchObject({
      connected: false,
      status: "idle",
      threads: [],
      history: [],
    });
  });

  test("lists all sessions returned by thread/list", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit(
      "message",
      JSON.stringify({
        id: 2,
        result: {
          data: [
            { id: "active-1", preview: "Active", status: { type: "active" } },
            { id: "idle-1", status: { type: "idle" } },
            { id: "ignored", status: { type: "closed" } },
            "invalid",
          ],
        },
      }),
    );

    expect(controller.getState().threads).toEqual([
      { id: "active-1", preview: "Active", status: { type: "active" } },
      { id: "idle-1", status: { type: "idle" } },
      { id: "ignored", status: { type: "closed" } },
    ]);
    expect(controller.getState().threadId).toBe("active-1");
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "active-1" },
    });
  });

  test("counts an active discovered session as background work until selected", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances.at(-1) as FakeWebSocket;

    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit(
      "message",
      JSON.stringify({
        id: 2,
        result: {
          data: [
            { id: "selected", status: { type: "idle" } },
            { id: "already-active", status: { type: "active" } },
          ],
        },
      }),
    );

    expect(controller.getState().threadId).toBe("selected");
    expect(controller.getState().backgroundWork).toEqual({ completed: 0, total: 1 });
  });

  test("keeps a session rejected by an active writer", () => {
    const { controller, socket } = connectedController();

    (controller as unknown as { resume: (id: string) => void }).resume("thread-1");
    const resumeId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: resumeId,
        error: { message: "already has an active writer" },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controller.getState().connected).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/read",
      params: { threadId: "thread-1" },
    });
  });

  test("discovers and resumes the loaded Codex session", () => {
    const { controller, socket } = connectedController();

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controller.getState()).toMatchObject({
      connected: true,
      status: "idle",
      threads: [{ id: "thread-1" }],
    });
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/turns/list",
      id: 5,
      params: {
        threadId: "thread-1",
        limit: 5,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
  });

  test("submits a prompt and renders streamed assistant output", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("  hello Codex  ")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: { threadId: "thread-1" },
    });
    expect(controller.getState().status).toBe("working");

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/started",
        params: { turn: { id: "turn-1" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Hello back" },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", text: "Hello back completed" },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: {},
      }),
    );

    expect(controller.getState()).toMatchObject({ status: "idle" });
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "hello Codex" }),
        expect.objectContaining({
          role: "assistant",
          text: "Hello back completed",
        }),
      ]),
    );
    expect(
      controller.getState().history.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  test("starts an inline custom review with the selected thread", () => {
    const { controller, socket } = connectedController();

    expect(controller.startReview("  Check for bugs and missing tests.  ")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "review/start",
      params: {
        threadId: "thread-1",
        delivery: "inline",
        target: {
          type: "custom",
          instructions: "Check for bugs and missing tests.",
        },
      },
    });
    expect(controller.getState().status).toBe("working");

    socket.emit(
      "message",
      JSON.stringify({
        id: 5,
        result: { turn: { id: "review-turn" }, reviewThreadId: "thread-1" },
      }),
    );
    expect(controller.getState().history).toEqual([]);

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "review-turn",
          item: {
            id: "review-user",
            type: "userMessage",
            content: [{ type: "text", text: "Generated review prompt" }],
          },
        },
      }),
    );
    expect(controller.getState().history.filter((message) => message.role === "user")).toHaveLength(
      0,
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "review-exit",
            type: "exitedReviewMode",
            review: "Review report should be shown once",
          },
        },
      }),
    );
    const reviewActivity = controller
      .getState()
      .history.find((message) => message.itemId === "review-exit");
    expect(reviewActivity?.text).toContain("Review completed");
    expect(reviewActivity?.text).not.toContain("Review report should be shown once");
    const report = "finding ".repeat(1000).trim();
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: { id: "review-report", type: "agentMessage", text: report },
        },
      }),
    );
    expect(
      controller.getState().history.find((message) => message.itemId === "review-report")?.text,
    ).toBe(report);

    socket.emit("message", JSON.stringify({ method: "turn/completed", params: {} }));
    expect(controller.getState().status).toBe("idle");
  });

  test("rejects a review while a turn is active", () => {
    const { controller } = connectedController();

    controller.submitPrompt("work first");
    expect(controller.startReview("review this")).toBe(false);
  });

  test("normalizes restored review history order and removes duplicate prompts", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      read: (threadId: string) => void;
    };

    internal.read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
        result: {
          thread: {
            id: "thread-1",
            status: { type: "idle" },
            turns: [
              {
                items: [
                  {
                    id: "review-enter",
                    type: "enteredReviewMode",
                    review: "review styles.css changes",
                  },
                  {
                    id: "review-exit",
                    type: "exitedReviewMode",
                    review: "full review report",
                  },
                  {
                    id: "review-user-1",
                    type: "userMessage",
                    content: [{ type: "text", text: "review styles.css changes" }],
                  },
                  {
                    id: "review-user-2",
                    type: "userMessage",
                    content: [{ type: "text", text: "review styles.css changes" }],
                  },
                  {
                    id: "review-report",
                    type: "agentMessage",
                    text: "The review is complete.",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    respondHistoryPage(socket, [
      {
        items: [
          { id: "review-enter", type: "enteredReviewMode", review: "review styles.css changes" },
          { id: "review-exit", type: "exitedReviewMode", review: "full review report" },
          {
            id: "review-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "review styles.css changes" }],
          },
          {
            id: "review-user-2",
            type: "userMessage",
            content: [{ type: "text", text: "review styles.css changes" }],
          },
          { id: "review-report", type: "agentMessage", text: "The review is complete." },
        ],
      },
    ]);

    const history = controller.getState().history;
    expect(history.filter((message) => message.role === "user")).toHaveLength(0);
    expect(history[0]?.itemId).toBe("review-enter");
    expect(history[1]?.itemId).toBe("review-exit");
    expect(history[2]).toMatchObject({
      role: "assistant",
      text: "The review is complete.",
    });
  });

  test("removes persisted review prompts when activities span turns", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      read: (threadId: string) => void;
    };

    internal.read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
        result: {
          thread: {
            id: "thread-1",
            status: { type: "idle" },
            turns: [
              {
                items: [
                  {
                    id: "review-enter",
                    type: "enteredReviewMode",
                    review: "review a.txt",
                  },
                ],
              },
              {
                items: [
                  {
                    id: "review-exit",
                    type: "exitedReviewMode",
                    review: "review a.txt",
                  },
                  {
                    id: "review-user",
                    type: "userMessage",
                    content: [{ type: "text", text: "review a.txt" }],
                  },
                  {
                    id: "review-report",
                    type: "agentMessage",
                    text: "Full review comments",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    respondHistoryPage(socket, [
      {
        items: [
          { id: "review-exit", type: "exitedReviewMode", review: "review a.txt" },
          {
            id: "review-user",
            type: "userMessage",
            content: [{ type: "text", text: "review a.txt" }],
          },
          { id: "review-report", type: "agentMessage", text: "Full review comments" },
        ],
      },
      {
        items: [{ id: "review-enter", type: "enteredReviewMode", review: "review a.txt" }],
      },
    ]);

    const history = controller.getState().history;
    expect(history.filter((message) => message.role === "user")).toHaveLength(0);
    expect(history.map((message) => message.itemId)).toEqual([
      "review-enter",
      "review-exit",
      "review-report",
    ]);
  });

  test.each([
    ["/plan", "plan"],
    ["/default", "default"],
  ])("handles %s as a local mode command", (command, mode) => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt(command)).toBe(true);
    expect(controller.getState().collaborationMode).toBe(mode);
    expect(lastMessage(socket)).not.toMatchObject({ method: "turn/start" });
  });

  test("runs ! commands through the current thread shell API", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("!git status --short")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/shellCommand",
      params: {
        threadId: "thread-1",
        command: "git status --short",
      },
    });
  });

  test("runs /exec commands through standalone command/exec", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt('/exec bash -lc "printf hello"')).toBe(true);
    const execProcessId = (lastMessage(socket).params as { processId: string }).processId;
    expect(lastMessage(socket)).toMatchObject({
      method: "command/exec",
      params: {
        command: ["bash", "-lc", "printf hello"],
        processId: execProcessId,
      },
    });

    socket.emit(
      "message",
      JSON.stringify({
        id: lastMessage(socket).id,
        result: { exitCode: 0, stdout: "hello", stderr: "" },
      }),
    );
    expect(controller.getState().history.at(-1)).toMatchObject({
      activity: { kind: "command", status: "completed", output: "hello" },
    });
  });

  test("completes /exec commands in the thread where they started", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];

    expect(controller.submitPrompt('/exec bash -lc "printf hello"')).toBe(true);
    const execId = lastMessage(socket).id;
    const processId = (lastMessage(socket).params as { processId: string }).processId;

    controller.selectThread("other-thread");
    socket.emit(
      "message",
      JSON.stringify({
        method: "command/exec/outputDelta",
        params: {
          processId,
          stream: "stdout",
          deltaBase64: Buffer.from("hello").toString("base64"),
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        id: execId,
        result: { exitCode: 0, stdout: "", stderr: "" },
      }),
    );

    expect(threadState(controller, "thread-1").history.at(-1)).toMatchObject({
      activity: { kind: "command", status: "completed", output: "hello" },
    });
    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ activity: expect.anything() })]),
    );
  });

  test("starts the next turn in Plan mode when selected", () => {
    const { controller, socket } = connectedController();

    controller.setCollaborationMode("plan");
    expect(controller.submitPrompt("plan this change")).toBe(true);

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: {
        collaborationMode: {
          mode: "plan",
          settings: {
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
      },
    });
  });

  test("follows collaboration mode changes made in the Codex terminal", () => {
    const { controller, socket } = connectedController();

    expect(controller.getState().collaborationMode).toBe("default");

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: {
            collaborationMode: {
              mode: "plan",
              settings: {},
            },
          },
        },
      }),
    );
    expect(controller.getState().collaborationMode).toBe("plan");

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: {
            collaborationMode: {
              mode: "default",
              settings: {},
            },
          },
        },
      }),
    );
    expect(controller.getState().collaborationMode).toBe("default");
  });

  test("ignores collaboration mode changes for another thread", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/settings/updated",
        params: {
          threadId: "other-thread",
          threadSettings: { collaborationMode: { mode: "plan", settings: {} } },
        },
      }),
    );

    expect(controller.getState().collaborationMode).toBe("default");
  });

  test("clears cached history when selecting another thread", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/settings/updated",
        params: {
          threadId: "other-thread",
          threadSettings: {
            collaborationMode: { mode: "plan", settings: {} },
          },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "other-thread",
          turnId: "other-turn",
          itemId: "other-item",
          delta: "background output",
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "background output" })]),
    );

    controller.selectThread("other-thread");
    expect(controller.getState().collaborationMode).toBe("plan");
    expect(controller.getState().history).toEqual([]);
    expect(controller.getState().historyLoading).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "other-thread", excludeTurns: true },
    });
  });

  test("does not select a thread started by another client", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "external-thread",
            cwd: "/workspace/external",
            status: { type: "idle" },
          },
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    controller.selectThread("external-thread");
    expect(controller.getState().cwd).toBe("/workspace/external");
  });

  test("counts an active thread started by another client as background work", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: {
          thread: {
            id: "active-external-thread",
            cwd: "/workspace/external",
            status: { type: "active" },
          },
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controller.getState().backgroundWork).toEqual({ completed: 0, total: 1 });
  });

  test("refreshes the queue for a background thread without selecting it", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "active" } }];

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/queue/changed",
        params: { threadId: "other-thread" },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/queue/list",
      params: { threadId: "other-thread" },
    });
    const firstPageId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: firstPageId,
        result: { data: [], nextCursor: "queue-next" },
      }),
    );
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/queue/list",
      params: { threadId: "other-thread", cursor: "queue-next" },
    });
    socket.emit(
      "message",
      JSON.stringify({
        id: lastMessage(socket).id,
        result: { data: [], nextCursor: null },
      }),
    );
    expect(controller.getState().threadId).toBe("thread-1");
  });

  test("starts the next turn in Default mode explicitly", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("continue normally")).toBe(true);

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: {
        collaborationMode: {
          mode: "default",
          settings: {
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
  });

  test("implements the completed plan in the current thread with a short prompt", () => {
    const { controller, socket } = connectedController();
    threadState(controller).history.push({
      role: "assistant",
      text: "completed plan",
    });

    expect(controller.implementPlan("1. Make the change", false)).toBe(true);

    const request = lastMessage(socket);
    expect(request).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Implement the plan.",
            text_elements: [],
          },
        ],
        collaborationMode: {
          mode: "default",
          settings: {
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
    expect(JSON.stringify(request)).not.toContain("1. Make the change");
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        { role: "assistant", text: "completed plan" },
        expect.objectContaining({
          role: "user",
          text: "Implement the plan.",
        }),
      ]),
    );
  });

  test("includes the completed plan when implementing in a clear-context thread", () => {
    const { controller, socket } = connectedController();
    const planText = "1. Make the change";

    expect(controller.implementPlan(planText, true)).toBe(true);
    const startRequest = lastMessage(socket);
    expect(startRequest).toMatchObject({
      method: "thread/start",
      params: { cwd: expect.any(String), serviceName: "pesk" },
    });

    const startId = startRequest.id;
    socket.emit(
      "message",
      JSON.stringify({
        id: startId,
        result: { thread: { id: "fresh-thread", status: { type: "idle" } } },
      }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "fresh-thread",
        input: [
          {
            type: "text",
            text: `A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.\n\n${planText}`,
            text_elements: [],
          },
        ],
        collaborationMode: {
          mode: "default",
          settings: {
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    });
  });

  test("streams and completes plan activity", () => {
    const { controller, socket } = connectedController();

    controller.submitPrompt("plan this change");
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "plan-1", type: "plan" },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/plan/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan-1",
          delta: "1. Inspect the code",
        },
      }),
    );
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "plan-1",
          activity: expect.objectContaining({
            kind: "plan",
            status: "inProgress",
            details: "1. Inspect the code",
          }),
        }),
      ]),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "plan-1",
            type: "plan",
            text: "1. Inspect the code\n2. Implement the change",
          },
        },
      }),
    );
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "plan-1",
          activity: expect.objectContaining({
            kind: "plan",
            status: "completed",
          }),
        }),
      ]),
    );
  });

  test("answers an app-server user-input request", () => {
    const { controller, socket, options: controllerOptions } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        id: "request-1",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: "choice",
              header: "Mode",
              question: "Which mode?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "Plan", description: "Plan first" },
                { label: "Default", description: "Act directly" },
              ],
            },
          ],
        },
      }),
    );

    expect(controller.getState().pendingUserInput).toMatchObject({
      requestId: "request-1",
      isBlocking: true,
    });
    expect(controllerOptions.handleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "userInputRequested",
        threadId: "thread-1",
      }),
    );
    expect(controller.respondUserInput({ choice: ["Plan"] })).toBe(true);
    expect(lastMessage(socket)).toEqual({
      id: "request-1",
      result: { answers: { choice: { answers: ["Plan"] } } },
    });
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: "Mode: Plan",
          turnId: "turn-1",
        }),
      ]),
    );
    expect(controller.getState().pendingUserInput).toBeUndefined();
  });

  test("switches to a background user-input request", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];
    controllerOptions.handleNotification.mockClear();

    socket.emit(
      "message",
      JSON.stringify({
        id: "background-request",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "other-thread",
          turnId: "other-turn",
          itemId: "question-2",
          isBlocking: true,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Choose one",
              isOther: false,
              isSecret: false,
              options: [],
            },
          ],
        },
      }),
    );

    expect(controller.getState().threadId).toBe("other-thread");
    expect(controller.getState().pendingUserInput).toMatchObject({
      requestId: "background-request",
    });
    expect(controllerOptions.handleNotification).toHaveBeenCalledWith(
      expect.objectContaining({ event: "userInputRequested" }),
    );

    expect(controller.respondUserInput({ choice: ["one"] })).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      id: "background-request",
      result: { answers: { choice: { answers: ["one"] } } },
    });
  });

  test("keeps the selected thread for a background approval while chat is visible", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];
    controllerOptions.isChatVisible.mockReturnValue(true);

    socket.emit(
      "message",
      JSON.stringify({
        id: "background-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "other-thread",
          command: "npm test",
          reason: "Run the tests",
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controllerOptions.handleNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "approvalRequested",
        threadId: "other-thread",
        selectedThreadId: "thread-1",
      }),
    );
  });

  test("switches to a background approval when chat is hidden", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];

    socket.emit(
      "message",
      JSON.stringify({
        id: "background-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "other-thread",
          command: "npm test",
          reason: "Run the tests",
        },
      }),
    );

    expect(controller.getState().threadId).toBe("other-thread");
    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: "background-approval",
    });
  });

  test("keeps the selected thread for background user input while chat is visible", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];
    controllerOptions.isChatVisible.mockReturnValue(true);

    socket.emit(
      "message",
      JSON.stringify({
        id: "background-input",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "other-thread",
          turnId: "other-turn",
          itemId: "question-2",
          isBlocking: true,
          questions: [],
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
  });

  test("aggregates background thread activity without changing selected chat context", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: {
          threadId: "other-thread",
          status: { type: "active", activeFlags: [] },
        },
      }),
    );

    expect(controller.getState().threadId).toBe("thread-1");
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().aggregateStatus).toBe("working");
    expect(controller.getState().threadActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "other-thread",
          status: "working",
        }),
      ]),
    );
  });

  test("retains completed background work until its thread is selected", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];
    controllerOptions.isChatVisible.mockReturnValue(true);

    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/status/changed",
        params: { threadId: "other-thread", status: { type: "active", activeFlags: [] } },
      }),
    );
    expect(controller.getState().backgroundWork).toEqual({ completed: 0, total: 1 });

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "other-thread", turn: { status: "completed" } },
      }),
    );
    expect(controller.getState().backgroundWork).toEqual({ completed: 1, total: 1 });

    controller.selectThread("other-thread");
    expect(controller.getState().backgroundWork).toEqual({ completed: 0, total: 0 });
  });

  test("counts one background work entry per thread until selection", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];
    controllerOptions.isChatVisible.mockReturnValue(true);

    const statusChanged = () =>
      socket.emit(
        "message",
        JSON.stringify({
          method: "thread/status/changed",
          params: { threadId: "other-thread", status: { type: "active", activeFlags: [] } },
        }),
      );
    const completed = () =>
      socket.emit(
        "message",
        JSON.stringify({
          method: "turn/completed",
          params: { threadId: "other-thread", turn: { status: "completed" } },
        }),
      );

    statusChanged();
    completed();
    statusChanged();
    expect(controller.getState().backgroundWork).toEqual({ completed: 1, total: 1 });

    controller.selectThread("other-thread");
    controller.selectThread("thread-1");
    statusChanged();
    expect(controller.getState().backgroundWork).toEqual({ completed: 0, total: 1 });
  });

  test("switches to and focuses a background thread after turn completion", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "active" } }];
    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "other-thread",
          turn: { status: "completed" },
        },
      }),
    );

    expect(controller.getState().threadId).toBe("other-thread");
    expect(controllerOptions.handleNotification).toHaveBeenCalledWith(
      expect.objectContaining({ event: "turnCompleted" }),
    );
  });

  test("resolves background user input without clearing the selected thread", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threads: Array<{ id: string; status: { type: string } }>;
    };
    internal.threads = [...internal.threads, { id: "other-thread", status: { type: "idle" } }];

    const request = (id: string, threadId: string): void => {
      socket.emit(
        "message",
        JSON.stringify({
          id,
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId: `${threadId}-turn`,
            itemId: `${threadId}-question`,
            isBlocking: true,
            questions: [],
          },
        }),
      );
    };
    request("selected-request", "thread-1");
    request("background-request", "other-thread");

    socket.emit(
      "message",
      JSON.stringify({
        method: "serverRequest/resolved",
        params: {
          threadId: "other-thread",
          requestId: "background-request",
        },
      }),
    );

    expect(controller.getState().pendingUserInput).toMatchObject({
      requestId: "selected-request",
    });
    controller.selectThread("other-thread");
    expect(controller.getState().pendingUserInput).toBeUndefined();
  });

  test("interrupts the active turn with its thread and turn ids", () => {
    const { controller, socket } = connectedController();

    controller.submitPrompt("stop this");
    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/started",
        params: { turn: { id: "turn-interrupt" } },
      }),
    );

    expect(controller.interruptTurn()).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "turn-interrupt",
      },
    });
  });

  test("marks an interrupted turn in controller state", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { status: "interrupted" } },
      }),
    );

    expect(controller.getState().interrupted).toBe(true);
  });

  test("keeps working state separate from streamed assistant history", () => {
    const { controller, socket } = connectedController();

    controller.submitPrompt("hello");
    expect(controller.getState().workingSince).toEqual(expect.any(Number));
    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ temporary: true })]),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "assistant-1", turnId: "turn-1", delta: "answer" },
      }),
    );

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "answer" })]),
    );
    expect(controller.getState().workingSince).toEqual(expect.any(Number));

    socket.emit("message", JSON.stringify({ method: "turn/completed", params: {} }));
    expect(controller.getState().workingSince).toBeUndefined();
  });

  test("keeps the first prompt visible while its new thread starts", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      threadId: string | undefined;
      threads: unknown[];
    };
    internal.threadId = undefined;
    internal.threads = [];

    expect(controller.submitPrompt("first prompt")).toBe(true);
    socket.emit(
      "message",
      JSON.stringify({
        method: "thread/started",
        params: { thread: { id: "new-thread" } },
      }),
    );

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", text: "first prompt" })]),
    );
  });

  test("renders command and file activity as distinct history entries", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "npm test",
            cwd: "/workspace",
            status: "inProgress",
          },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/commandExecution/outputDelta",
        params: { itemId: "command-1", delta: "passed\n" },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "npm test",
            status: "completed",
          },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "file-1",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                kind: "update",
                path: "src/app.ts",
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
            ],
          },
        },
      }),
    );

    const history = controller.getState().history;
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "command-1",
          activity: expect.objectContaining({ output: "passed\n" }),
        }),
        expect.objectContaining({
          itemId: "file-1",
          activity: expect.objectContaining({
            changes: ["update: src/app.ts\n  @@ -1 +1 @@\n  -old\n  +new"],
          }),
          text: expect.stringContaining("+new"),
        }),
      ]),
    );
    expect(history.filter((message) => message.itemId === "command-1")).toHaveLength(1);
  });

  test("renders web search and unknown activity items", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "search-1",
            type: "webSearch",
            query: "Kuala Lumpur weather today",
            status: "inProgress",
          },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "search-1",
            type: "webSearch",
            query: "Kuala Lumpur weather today",
            status: "completed",
            results: [{ title: "Weather forecast" }],
          },
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "custom-1",
            type: "customToolCall",
            status: "completed",
            input: { value: "visible" },
          },
        },
      }),
    );

    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "search-1",
          activity: expect.objectContaining({ kind: "webSearch" }),
          text: expect.stringContaining("Kuala Lumpur weather today"),
        }),
        expect.objectContaining({
          itemId: "custom-1",
          activity: expect.objectContaining({ kind: "tool" }),
          text: expect.stringContaining("visible"),
        }),
      ]),
    );
    expect(
      controller.getState().history.filter((message) => message.itemId === "search-1"),
    ).toHaveLength(1);
  });

  test("does not render reasoning items as activity", () => {
    const { controller, socket } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "reasoning-1",
            type: "reasoning",
            status: "completed",
            summary: ["internal reasoning"],
          },
        },
      }),
    );

    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: "reasoning-1" })]),
    );
  });

  test("requests approval and sends the selected decision", () => {
    const { controller, socket, options: controllerOptions } = connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "npm test",
          reason: "Run the tests",
        },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test", reason: "Run the tests" },
      }),
    );

    expect(controller.getState().status).toBe("waiting");
    expect(controllerOptions.publishRendererState.mock.invocationCallOrder[0]).toBeLessThan(
      controllerOptions.handleNotification.mock.invocationCallOrder[0],
    );
    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: 88,
      command: "npm test",
      reason: "Run the tests",
    });
    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ approval: expect.anything() })]),
    );

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/started",
        params: { turn: { id: "approval-turn" } },
      }),
    );
    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: 88,
    });

    controller.respondPermission(88, "accept");

    expect(lastMessage(socket)).toEqual({
      id: 88,
      result: { decision: "accept" },
    });
    expect(controllerOptions.clearNotification).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("working");
  });

  test("keeps independent string and numeric approvals actionable", () => {
    const { controller, socket } = connectedController();

    for (const [id, command] of [
      ["approval-1", "first command"],
      [7, "second command"],
    ] as const) {
      socket.emit(
        "message",
        JSON.stringify({
          id,
          method: "item/commandExecution/requestApproval",
          params: { command, reason: "needs permission" },
        }),
      );
    }
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/started",
        params: { item: { id: "command-1", type: "commandExecution" } },
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/commandExecution/outputDelta",
        params: { itemId: "command-1", delta: "output" },
      }),
    );

    expect(controller.getState().status).toBe("waiting");
    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: 7,
    });
    expect(controller.submitPrompt("queue while approval is pending")).toBe(true);

    controller.respondPermission("approval-1", "decline");
    expect(lastMessage(socket)).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approval: expect.objectContaining({
            requestId: "approval-1",
            state: "denied",
          }),
        }),
      ]),
    );
    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: 7,
    });
    expect(controller.getState().status).toBe("waiting");

    controller.respondPermission(7, "accept");
    expect(lastMessage(socket)).toEqual({
      id: 7,
      result: { decision: "accept" },
    });
    expect(controller.getState().status).toBe("working");
  });

  test("shows the next approval when it arrives after the current one is answered", () => {
    const { controller, socket } = connectedController();
    socket.emit(
      "message",
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "first command",
          reason: "first permission",
        },
      }),
    );

    controller.respondPermission("approval-1", "decline");

    socket.emit(
      "message",
      JSON.stringify({
        id: "approval-2",
        method: "item/fileChange/requestApproval",
        params: { reason: "second permission", changes: ["file.txt"] },
      }),
    );

    expect(controller.getState().pendingApproval).toMatchObject({
      requestId: "approval-2",
      reason: "second permission",
    });
    expect(controller.getState().status).toBe("waiting");

    controller.respondPermission("approval-2", "accept");
    expect(controller.getState().pendingApproval).toBeUndefined();
    expect(controller.getState().status).toBe("working");
  });

  test("exposes and sends schema-backed command approval options", () => {
    const { controller, socket } = connectedController();
    socket.emit(
      "message",
      JSON.stringify({
        id: "command-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "curl example.com",
          proposedExecpolicyAmendment: ["curl", "example.com"],
          proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }],
        },
      }),
    );

    const approval = controller.getState().pendingApproval;
    expect(approval?.options.map((option) => option.id)).toEqual(
      expect.arrayContaining([
        "accept",
        "acceptForSession",
        "applyNetworkPolicyAmendment:0",
        "acceptWithExecpolicyAmendment",
        "decline",
        "cancel",
      ]),
    );

    controller.respondPermission("command-approval", "acceptForSession");
    expect(lastMessage(socket)).toEqual({
      id: "command-approval",
      result: { decision: "acceptForSession" },
    });
  });

  test("sends structured command amendment decisions unchanged", () => {
    const { controller, socket } = connectedController();
    socket.emit(
      "message",
      JSON.stringify({
        id: 99,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          command: "npm test",
          proposedExecpolicyAmendment: ["npm", "test"],
        },
      }),
    );

    controller.respondPermission(99, "acceptWithExecpolicyAmendment");
    expect(lastMessage(socket)).toEqual({
      id: 99,
      result: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["npm", "test"],
          },
        },
      },
    });
  });

  test("removes unresolved approvals when a later assistant message supersedes them", () => {
    const { controller, socket } = connectedController();
    socket.emit(
      "message",
      JSON.stringify({
        id: "stale-1",
        method: "item/fileChange/requestApproval",
        params: { reason: "edit files", changes: [] },
      }),
    );
    expect(controller.getState().status).toBe("waiting");

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { delta: "The turn continued.", itemId: "assistant-1" },
      }),
    );

    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approval: { requestId: "stale-1", state: "pending" },
        }),
      ]),
    );
    expect(controller.getState().status).toBe("working");
  });

  test("loads older history through cursor pagination", async () => {
    const { controller, socket } = connectedController(
      [
        {
          id: "new-turn",
          items: [{ id: "new-item", type: "userMessage", content: [{ text: "new" }] }],
        },
      ],
      "older",
    );

    const request = controller.loadOlderHistory();
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/turns/list",
      params: { threadId: "thread-1", cursor: "older", limit: 5, sortDirection: "desc" },
    });
    socket.emit(
      "message",
      JSON.stringify({
        id: lastMessage(socket).id,
        result: {
          data: [
            {
              id: "old-turn",
              items: [{ id: "old-item", type: "userMessage", content: [{ text: "old" }] }],
            },
          ],
          nextCursor: null,
          backwardsCursor: "newer",
        },
      }),
    );
    await request;

    expect(controller.getState().history.map((message) => message.text)).toEqual(["old", "new"]);
    expect(controller.getState()).toMatchObject({
      hasOlderHistory: false,
      historyLoading: false,
    });
  });

  test("does not publish selected state for background streaming deltas", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    controllerOptions.publishRendererState.mockClear();

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "background-thread", itemId: "assistant-1", delta: "background" },
      }),
    );

    expect(controllerOptions.publishRendererState).not.toHaveBeenCalled();
  });

  test("publishes selected assistant deltas without a full state snapshot", () => {
    const { controller, socket, options: controllerOptions } = connectedController();
    controllerOptions.publishRendererState.mockClear();
    controllerOptions.publishStreamDelta.mockClear();

    socket.emit(
      "message",
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", itemId: "assistant-1", delta: "selected" },
      }),
    );

    expect(controllerOptions.publishStreamDelta).toHaveBeenCalledWith({
      threadId: "thread-1",
      kind: "assistant",
      itemId: "assistant-1",
      delta: "selected",
    });
    expect(controllerOptions.publishRendererState).not.toHaveBeenCalled();
  });

  test("bounds inactive runtime history retention", () => {
    const { controller } = connectedController();
    const internal = controller as unknown as {
      runtime: (threadId: string) => CodexThread;
      threadControllers: Map<string, CodexThread>;
      backgroundWork: Map<string, "working" | "completed">;
    };
    internal.backgroundWork.set("completed-thread", "completed");
    internal.runtime("completed-thread");
    for (let index = 0; index < 32; index += 1) {
      internal.runtime(`inactive-${index}`);
    }

    expect(internal.threadControllers.size).toBeLessThanOrEqual(16);
    expect(internal.threadControllers.has("thread-1")).toBe(true);
    expect(controller.getState().backgroundWork).toEqual({ completed: 1, total: 1 });
  });
});
