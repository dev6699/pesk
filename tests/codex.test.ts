/// <reference types="jest" />

import {
  CodexController,
  shouldReconcileOnIdle,
  shouldResumeOnActiveStatus,
} from "../src/codex";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  static shouldThrow = false;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

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
    for (const callback of this.listeners.get(event) ?? [])
      callback(eventValue);
  }
}

function lastMessage(socket: FakeWebSocket): Record<string, unknown> {
  return JSON.parse(socket.sent[socket.sent.length - 1].trim()) as Record<
    string,
    unknown
  >;
}

function options() {
  return {
    sendSettings: jest.fn(),
    showPetForUpdate: jest.fn(),
    showApproval: jest.fn(),
    debug: jest.fn(),
  };
}

function connectedController(turns: unknown[] = []) {
  const controllerOptions = options();
  const controller = new CodexController(controllerOptions);
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
    FakeWebSocket;
  (controller as unknown as { connect: () => void }).connect();
  const socket = FakeWebSocket.instances.at(-1) as FakeWebSocket;

  socket.emit("open");
  expect(lastMessage(socket)).toMatchObject({ method: "initialize", id: 1 });
  socket.emit("message", JSON.stringify({ id: 1, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({ id: 2, result: { data: ["thread-1"] } }),
  );
  socket.emit("message", JSON.stringify({ id: 3, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({
      id: 4,
      result: {
        thread: {
          id: "thread-1",
          canAcceptDirectInput: true,
          status: { type: "idle" },
          turns,
        },
      },
    }),
  );

  return { controller, socket, options: controllerOptions };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.shouldThrow = false;
});

describe("Codex session decisions", () => {
  test("resumes an active session when Pesk is disconnected", () => {
    expect(shouldResumeOnActiveStatus(false, { type: "active" })).toBe(true);
  });

  test("does not resume an active session when already connected", () => {
    expect(shouldResumeOnActiveStatus(true, { type: "active" })).toBe(false);
  });

  test("reconciles after a working session becomes idle", () => {
    expect(shouldReconcileOnIdle("working", { type: "idle" }, false)).toBe(
      true,
    );
  });

  test("reconciles an idle session with a pending Pesk turn", () => {
    expect(shouldReconcileOnIdle("idle", { type: "idle" }, true)).toBe(true);
  });

  test("does not reconcile an active session without a pending turn", () => {
    expect(shouldReconcileOnIdle("working", { type: "active" }, false)).toBe(
      false,
    );
  });
});

describe("CodexController", () => {
  test("logs connection and socket errors and retries after construction fails", () => {
    jest.useFakeTimers();
    FakeWebSocket.shouldThrow = true;
    const callbacks = options();
    const controller = new CodexController(callbacks);
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;

    (controller as unknown as { connect: () => void }).connect();
    expect(FakeWebSocket.instances).toHaveLength(0);
    jest.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(callbacks.debug).toHaveBeenCalledWith(
      "Codex connection failed",
      expect.any(Error),
    );
    jest.useRealTimers();
  });

  test("handles malformed messages and socket errors", () => {
    const callbacks = options();
    const controller = new CodexController(callbacks);
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
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

  test("clears the selected session and history when the socket closes", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      history: Array<{ role: string; text: string }>;
      threads: Array<{ id: string }>;
    };
    internal.history.push({ role: "assistant", text: "previous response" });
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

    const loadedListId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: loadedListId, result: { data: [] } }),
    );
    const threadListId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: threadListId, result: { data: [] } }),
    );

    expect(controller.getState()).toMatchObject({
      threadId: undefined,
      history: [],
      threads: [],
    });
  });

  test("covers controller guards and failed turn paths", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const state = controller as unknown as {
      threads: Array<{ id: string }>;
      prompts: Map<string, number>;
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
    internal.completeAssistant("   ");
    internal.completeAssistant("fallback assistant");
    internal.addMessage("user", "duplicate");
    internal.addMessage("user", "duplicate");
    internal.insertUser("duplicate");
    state.prompts.set("expired", Date.now() - 20_000);
    expect(internal.consume("expired")).toBe(false);

    controller.submitPrompt("failed turn");
    const turnId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({ id: turnId, error: { message: "failed" } }),
    );
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().threadId).toBe("thread-1");
  });

  test("waits for active status when the rollout is not ready", () => {
    jest.useFakeTimers();
    const { controller, socket } = connectedController();
    const internal = controller as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    (controller as unknown as { connected: boolean }).connected = false;

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

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "thread-1" },
    });

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
    const internal = controller as unknown as { connected: boolean };
    internal.connected = false;

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

  test("rejects invalid prompts and prompts while a turn is active", () => {
    const { controller } = connectedController();

    expect(controller.submitPrompt(null)).toBe(false);
    expect(controller.submitPrompt("   ")).toBe(false);
    expect(controller.submitPrompt("first prompt")).toBe(true);
    expect(controller.submitPrompt("second prompt")).toBe(false);
  });

  test("starts a new session when no session is selected", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));
    socket.emit("message", JSON.stringify({ id: 3, result: { data: [] } }));

    expect(controller.submitPrompt("start a session")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      id: 4,
    });

    socket.emit(
      "message",
      JSON.stringify({ id: 4, result: { thread: { id: "new-thread" } } }),
    );

    expect(lastMessage(socket)).toMatchObject({
      method: "turn/start",
      params: { threadId: "new-thread" },
    });
    expect(controller.getState().connected).toBe(true);
  });

  test("treats /new as a new-session command", () => {
    const { controller, socket } = connectedController([
      {
        items: [{ type: "userMessage", content: [{ text: "old message" }] }],
      },
    ]);

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

    expect(controller.submitPrompt("/new")).toBe(true);
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

    socket.emit(
      "message",
      JSON.stringify({ id: 5, result: { thread: { id: "new-thread" } } }),
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

  test("starts /new in the requested working directory", () => {
    const { controller, socket } = connectedController();

    expect(controller.submitPrompt("/new /workspace/other-project")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/workspace/other-project",
      },
    });
  });

  test("reuses the current thread working directory for /new", () => {
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

    expect(controller.submitPrompt("/new")).toBe(true);
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
            canAcceptDirectInput: true,
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
        .history.filter(
          (message) =>
            message.role === "user" && message.text === "same prompt",
        ),
    ).toHaveLength(2);
  });

  test("shows the same message when submitted again from Pesk", () => {
    const { controller } = connectedController();
    const internal = controller as unknown as {
      setStatus: (status: "idle" | "working" | "waiting") => void;
    };

    expect(controller.submitPrompt("repeat this message")).toBe(true);
    internal.setStatus("idle");
    expect(controller.submitPrompt("repeat this message")).toBe(true);
    expect(
      controller
        .getState()
        .history.filter(
          (message) =>
            message.role === "user" && message.text === "repeat this message",
        ),
    ).toHaveLength(2);
  });

  test("reconciles history when the active turn becomes idle", () => {
    const { controller, socket } = connectedController();

    controller.submitPrompt("reconcile me");
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

    expect(lastMessage(socket)).toMatchObject({
      method: "thread/read",
      params: { threadId: "thread-1" },
    });
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
            canAcceptDirectInput: true,
            status: { type: "idle" },
            turns: [
              {
                items: [
                  { type: "agentMessage", text: "partial server history" },
                ],
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
      JSON.stringify({ id: startId, result: { thread: { id: "local-thread" } } }),
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
      lastTurn: {
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
        result: { thread: { canAcceptDirectInput: true, turns: [] } },
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
      lastTurn: {
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
        params: { command: "npm test", reason: "Run the tests" },
      }),
    );

    expect(controller.getState().status).toBe("waiting");
  });

  test("retries after the WebSocket closes and reconnects", () => {
    jest.useFakeTimers();
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;

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
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];

    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));
    socket.emit("message", JSON.stringify({ id: 3, result: { data: [] } }));

    expect(controller.getState()).toMatchObject({
      connected: false,
      status: "idle",
      threads: [],
      history: [],
    });
  });

  test("lists active sessions when no single loaded session is available", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));
    socket.emit(
      "message",
      JSON.stringify({
        id: 3,
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
      { id: "active-1", preview: "Active", status: "active" },
      { id: "idle-1", status: "idle" },
    ]);
    expect(controller.getState().threadId).toBe("active-1");
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/resume",
      params: { threadId: "active-1" },
    });
  });

  test("removes a session rejected by an active writer", () => {
    const { controller, socket } = connectedController();

    (controller as unknown as { resume: (id: string) => void }).resume(
      "thread-1",
    );
    const resumeId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: resumeId,
        error: { message: "already has an active writer" },
      }),
    );

    expect(controller.getState().threadId).toBeUndefined();
    expect(controller.getState().connected).toBe(false);
  });


  test("clears a session that cannot accept direct input", () => {
    const { controller, socket } = connectedController();

    (controller as unknown as { read: (id: string) => void }).read("thread-1");
    const readId = lastMessage(socket).id;
    socket.emit(
      "message",
      JSON.stringify({
        id: readId,
        result: { thread: { canAcceptDirectInput: false } },
      }),
    );

    expect(controller.getState().threadId).toBeUndefined();
    expect(controller.getState().connected).toBe(false);
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
      method: "thread/read",
      id: 4,
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
      controller
        .getState()
        .history.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
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
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", text: "answer" }),
      ]),
    );
    expect(controller.getState().workingSince).toEqual(expect.any(Number));

    socket.emit(
      "message",
      JSON.stringify({ method: "turn/completed", params: {} }),
    );
    expect(controller.getState().workingSince).toBeUndefined();
  });

  test("continues streaming after history is trimmed", () => {
    const { controller } = connectedController();
    const internal = controller as unknown as {
      history: Array<{ role: "user" | "assistant"; text: string }>;
      appendDelta: (delta: string) => void;
    };
    internal.history = Array.from({ length: 40 }, (_, index) => ({
      role: "user",
      text: `message ${index}`,
    }));

    internal.appendDelta("first");
    internal.appendDelta(" second");

    expect(controller.getState().history.at(-1)).toMatchObject({
      role: "assistant",
      text: "first second",
    });
  });

  test("starts a new stream after the previous assistant item completes", () => {
    const { controller } = connectedController();
    const internal = controller as unknown as {
      appendDelta: (delta: string, itemId?: string) => void;
      completeAssistant: (text: string, itemId?: string) => void;
    };

    internal.appendDelta("first", "assistant-1");
    internal.completeAssistant("first complete", "assistant-1");
    internal.appendDelta("second", "assistant-2");

    expect(controller.getState().history).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "first complete",
        itemId: "assistant-1",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "second",
        itemId: "assistant-2",
      }),
    ]);
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
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "first prompt" }),
      ]),
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
    expect(
      history.filter((message) => message.itemId === "command-1"),
    ).toHaveLength(1);
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
      controller
        .getState()
        .history.filter((message) => message.itemId === "search-1"),
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
      expect.arrayContaining([
        expect.objectContaining({ itemId: "reasoning-1" }),
      ]),
    );
  });

  test("requests approval and sends the selected decision", () => {
    const { controller, socket, options: controllerOptions } =
      connectedController();

    socket.emit(
      "message",
      JSON.stringify({
        id: 88,
        method: "item/commandExecution/requestApproval",
        params: { command: "npm test", reason: "Run the tests" },
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
    expect(controllerOptions.sendSettings.mock.invocationCallOrder[0]).toBeLessThan(
      controllerOptions.showApproval.mock.invocationCallOrder[0],
    );
    expect(controller.getState().history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          text: "npm test\nRun the tests",
        }),
      ]),
    );
    expect(
      controller
        .getState()
        .history.filter((message) => message.approval?.requestId === 88),
    ).toHaveLength(1);

    socket.emit(
      "message",
      JSON.stringify({
        method: "turn/started",
        params: { turn: { id: "approval-turn" } },
      }),
    );
    expect(controller.getState().history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    );

    controller.respondPermission(88, "accept");

    expect(lastMessage(socket)).toEqual({
      id: 88,
      result: { decision: "accept" },
    });
    expect(controller.getState().status).toBe("working");
  });
});
