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
    publishRendererState: jest.fn(),
    showPetForUpdate: jest.fn(),
    focusUserInput: jest.fn(),
    showApproval: jest.fn(),
    clearApproval: jest.fn(),
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
    expect(shouldReconcileOnIdle("working", { type: "idle" }, false)).toBe(false);
  });

  test("does not reconcile an idle session with a pending Pesk turn while disabled", () => {
    expect(shouldReconcileOnIdle("idle", { type: "idle" }, true)).toBe(false);
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
      reviewInProgress: boolean;
    };
    internal.history.push({ role: "assistant", text: "previous response" });
    internal.threads = [{ id: "thread-1" }];
    internal.reviewInProgress = true;

    socket.emit("close", { code: 1006, reason: "server restarted" });

    expect(controller.getState()).toMatchObject({
      threadId: undefined,
      threads: [],
      connected: false,
    });
    expect(controller.getState().history).toEqual([
      { role: "assistant", text: "previous response" },
    ]);
    expect(internal.reviewInProgress).toBe(false);
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

    expect(socket.sent.map((message) => JSON.parse(message.trim()))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/resume",
          params: { threadId: "thread-1" },
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

  test("rejects invalid prompts and queues prompts while a turn is active", () => {
    const { controller } = connectedController();

    expect(controller.submitPrompt("   ")).toBe(false);
    expect(controller.submitPrompt("first prompt")).toBe(true);
    expect(controller.submitPrompt("second prompt")).toBe(true);
  });

  test("wraps steer input and keeps the wrapped text in history", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      activeTurnId: string;
      status: "working" | "waiting";
    };
    internal.activeTurnId = "turn-1";
    internal.status = "working";

    expect(controller.steerPrompt("Change New York to Osaka instead.")).toBe(
      true,
    );

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
    expect(
      controller.getState().history.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  test("queues a normal prompt while a turn is active", () => {
    const { controller, socket } = connectedController();
    const internal = controller as unknown as {
      activeTurnId: string;
      status: "working" | "waiting";
    };
    internal.activeTurnId = "turn-1";
    internal.status = "working";

    expect(controller.submitPrompt("run this after the current turn")).toBe(
      true,
    );
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

  test("starts a new session when no session is selected", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    (controller as unknown as { connect: () => void }).connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("message", JSON.stringify({ id: 1, result: {} }));
    socket.emit("message", JSON.stringify({ id: 2, result: { data: [] } }));

    expect(controller.submitPrompt("start a session")).toBe(true);
    expect(lastMessage(socket)).toMatchObject({
      method: "thread/start",
      id: 3,
    });

    socket.emit(
      "message",
      JSON.stringify({ id: 3, result: { thread: { id: "new-thread" } } }),
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

    expect(controller.getState()).toMatchObject({
      connected: false,
      status: "idle",
      threads: [],
      history: [],
    });
  });

  test("lists all sessions returned by thread/list", () => {
    const controller = new CodexController(options());
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
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

  test("starts an inline custom review with the selected thread", () => {
    const { controller, socket } = connectedController();

    expect(
      controller.startReview("  Check for bugs and missing tests.  "),
    ).toBe(true);
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
    expect(controller.getState().history.filter((message) => message.role === "user")).toHaveLength(0);

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
    const reviewActivity = controller.getState().history.find(
      (message) => message.itemId === "review-exit",
    );
    expect(reviewActivity?.text).toContain("Review completed");
    expect(reviewActivity?.text).not.toContain("Review report should be shown once");
    const report = "finding ".repeat(1000).trim();
    socket.emit(
      "message",
      JSON.stringify({
        method: "item/completed",
        params: { item: { id: "review-report", type: "agentMessage", text: report } },
      }),
    );
    expect(
      controller.getState().history.find((message) => message.itemId === "review-report")?.text,
    ).toBe(report);

    socket.emit(
      "message",
      JSON.stringify({ method: "turn/completed", params: {} }),
    );
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
    expect(lastMessage(socket)).toMatchObject({
      method: "command/exec",
      params: {
        command: ["bash", "-lc", "printf hello"],
        processId: "pesk-exec-5",
      },
    });

    socket.emit(
      "message",
      JSON.stringify({
        id: 5,
        result: { exitCode: 0, stdout: "hello", stderr: "" },
      }),
    );
    expect(controller.getState().history.at(-1)).toMatchObject({
      activity: { kind: "command", status: "completed", output: "hello" },
    });
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
    const internal = controller as unknown as {
      history: Array<{ role: string; text: string }>;
    };
    internal.history.push({ role: "assistant", text: "completed plan" });

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
    const {
      controller,
      socket,
      options: controllerOptions,
    } = connectedController();

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
    expect(controllerOptions.focusUserInput).toHaveBeenCalled();
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
    const {
      controller,
      socket,
      options: controllerOptions,
    } = connectedController();

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
    expect(
      controllerOptions.publishRendererState.mock.invocationCallOrder[0],
    ).toBeLessThan(controllerOptions.showApproval.mock.invocationCallOrder[0]);
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
    expect(controller.getState().pendingApproval).toMatchObject({ requestId: 88 });

    controller.respondPermission(88, "accept");

    expect(lastMessage(socket)).toEqual({
      id: 88,
      result: { decision: "accept" },
    });
    expect(controllerOptions.clearApproval).toHaveBeenCalledTimes(1);
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
    expect(controller.submitPrompt("queue while approval is pending")).toBe(
      true,
    );

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
    expect(controller.getState().pendingApproval).toMatchObject({ requestId: 7 });
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
        params: { command: "first command", reason: "first permission" },
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
          command: "curl example.com",
          proposedExecpolicyAmendment: ["curl", "example.com"],
          proposedNetworkPolicyAmendments: [
            { host: "example.com", action: "allow" },
          ],
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
});
