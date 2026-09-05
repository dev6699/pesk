/// <reference types="jest" />
/// <reference types="node" />

import {
  CodexGoalManager,
  formatGoalDuration,
  formatGoalTokens,
  type GoalManagerOptions,
  type GoalRequestInput,
} from "../../src/codex/goal";
import { CodexController } from "../../src/codex";
import type { CodexThread } from "../../src/codex/thread";
import type { ThreadGoal } from "../../src/codex-schema/v2";
import type { JsonRpcResponse } from "../../src/codex/protocol";

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

function lastMessage(socket: FakeWebSocket): Record<string, any> {
  return JSON.parse(socket.sent[socket.sent.length - 1].trim()) as Record<string, any>;
}

function controllerOptions() {
  return {
    publishRendererState: jest.fn(),
    publishStreamDelta: jest.fn(),
    handleNotification: jest.fn(),
    isChatVisible: jest.fn(() => false),
    clearNotification: jest.fn(),
    debug: jest.fn(),
  };
}

function connectedController() {
  const options = controllerOptions();
  const controller = new CodexController(options);
  (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  controller.start();
  const socket = FakeWebSocket.instances.at(-1) as FakeWebSocket;

  socket.emit("open");
  expect(lastMessage(socket)).toMatchObject({ method: "initialize", id: 1 });
  socket.emit("message", JSON.stringify({ id: 1, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({
      id: 2,
      result: { data: [{ id: "thread-1", status: { type: "idle" } }] },
    }),
  );
  socket.emit("message", JSON.stringify({ id: 3, result: {} }));
  socket.emit(
    "message",
    JSON.stringify({
      id: 4,
      result: { thread: { id: "thread-1", status: { type: "idle" } } },
    }),
  );
  socket.emit(
    "message",
    JSON.stringify({ id: 5, result: { data: [], nextCursor: null, backwardsCursor: null } }),
  );

  return { controller, socket, options };
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

function makeManager() {
  let goal: ThreadGoal | undefined;
  let pending:
    | {
        request: GoalRequestInput;
        callback: (message: JsonRpcResponse<unknown>) => void;
      }
    | undefined;
  const options: GoalManagerOptions = {
    request: (request, callback) => {
      pending = { request, callback: callback as (message: JsonRpcResponse<unknown>) => void };
    },
    setGoal: (_threadId, nextGoal) => {
      goal = nextGoal;
    },
    publishRendererState: jest.fn(),
    setCommandNotice: jest.fn(),
    setConnectionError: jest.fn(),
    setCollaborationMode: jest.fn(),
  };
  return {
    manager: new CodexGoalManager(options),
    options,
    getGoal: () => goal,
    getPending: () => pending,
  };
}

describe("CodexGoalManager", () => {
  test("creates a goal and switches to default mode after the server accepts it", () => {
    const { manager, options, getGoal, getPending } = makeManager();

    expect(manager.manage("thread-1", undefined, "ship the verified feature")).toBe(true);
    expect(getPending()?.request).toEqual({
      method: "thread/goal/set",
      params: { threadId: "thread-1", objective: "ship the verified feature", status: "active" },
    });

    const createdGoal = {
      threadId: "thread-1",
      objective: "ship the verified feature",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    } satisfies ThreadGoal;
    getPending()?.callback({ id: 1, result: { goal: createdGoal } });

    expect(getGoal()).toEqual(createdGoal);
    expect(options.setCollaborationMode).toHaveBeenCalledWith("default");
  });

  test("restores and routes server goal lifecycle updates by thread", () => {
    const { manager, getGoal, getPending } = makeManager();
    const restoredGoal = {
      threadId: "thread-1",
      objective: "restored",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 4,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    } satisfies ThreadGoal;

    manager.restore("thread-1");
    expect(getPending()?.request).toEqual({
      method: "thread/goal/get",
      params: { threadId: "thread-1" },
    });
    getPending()?.callback({ id: 1, result: { goal: restoredGoal } });
    expect(getGoal()).toEqual(restoredGoal);

    manager.handleCleared("thread-1");
    expect(getGoal()).toBeUndefined();
  });

  test("formats goal usage at minute and compact-token boundaries", () => {
    expect(formatGoalDuration(59.9)).toBe("59s");
    expect(formatGoalDuration(60)).toBe("1m 0s");
    expect(formatGoalDuration(3661)).toBe("1h 1m 1s");
    expect(formatGoalTokens(9710)).toBe("9.71K");
  });

  test("handles missing thread and missing goal edit context", () => {
    const { manager, options } = makeManager();

    expect(manager.manage(undefined, undefined, "new objective")).toBe(false);
    expect(manager.manage("thread-1", undefined, "edit replacement")).toBe(true);
    expect(options.setCommandNotice).toHaveBeenCalledWith("No goal is currently set to edit.");
  });

  test("accepts a clear response and restores an empty goal", () => {
    const { manager, getPending, getGoal, options } = makeManager();

    expect(manager.manage("thread-1", undefined, "clear")).toBe(true);
    getPending()?.callback({ id: 1, result: { cleared: true } });
    expect(getGoal()).toBeUndefined();

    manager.restore("thread-1");
    getPending()?.callback({ id: 2, result: { goal: null } });
    expect(getGoal()).toBeUndefined();
    expect(options.publishRendererState).toHaveBeenCalled();
  });

  test("rejects a missing or mismatched goal-set response", () => {
    const { manager, getPending, options } = makeManager();
    const existingGoal = {
      threadId: "thread-1",
      objective: "old",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    } satisfies ThreadGoal;

    expect(manager.manage("thread-1", existingGoal, "edit replacement")).toBe(true);
    getPending()?.callback({ id: 1, result: {} });
    expect(options.setConnectionError).toHaveBeenCalledWith("Unable to edit the goal.");

    expect(manager.manage("thread-1", existingGoal, "edit replacement")).toBe(true);
    getPending()?.callback({
      id: 2,
      result: {
        goal: { ...existingGoal, objective: "different" },
      },
    });
    expect(options.setConnectionError).toHaveBeenCalledTimes(2);
  });

  test("formats command availability for paused and active goals", () => {
    const { manager, options } = makeManager();
    const goal = (status: ThreadGoal["status"]): ThreadGoal => ({
      threadId: "thread-1",
      objective: "objective",
      status,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    });

    manager.manage("thread-1", goal("paused"), "");
    expect(options.setCommandNotice).toHaveBeenLastCalledWith(
      expect.stringContaining("/goal resume"),
    );
    manager.manage("thread-1", goal("active"), "");
    expect(options.setCommandNotice).toHaveBeenLastCalledWith(
      expect.stringContaining("/goal pause"),
    );
  });
});

describe("CodexController goal integration", () => {
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
});
