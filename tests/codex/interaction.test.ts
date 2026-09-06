/// <reference types="jest" />

import { CodexInteraction, type CodexInteractionDependencies } from "../../src/codex/interaction";
import { parsePrompt } from "../../src/codex/prompt";

function createInteraction() {
  const thread = {
    id: "thread-1",
    state: {
      status: "idle" as "idle" | "working" | "waiting",
      activeTurnId: undefined as string | undefined,
      pendingUserInput: undefined,
      pendingApprovals: new Map(),
      workingDirectory: "/workspace",
    },
    addUserMessage: jest.fn(),
    addMessage: jest.fn(),
    clearUserInput: jest.fn(),
    beginReview: jest.fn(),
    setActiveTurn: jest.fn(),
    completeTurn: jest.fn(),
    setStatus: jest.fn(),
    resolveApprovalSelection: jest.fn(() => ({ hasPending: false })),
    resolveQueuedSubmission: jest.fn(),
    addActivity: jest.fn(),
    queuePending: jest.fn(),
    prepareTurn: jest.fn(),
    rememberPrompt: jest.fn(),
    setCollaborationMode: jest.fn(),
  };
  const lifecycle = {
    compact: jest.fn(() => true),
    fork: jest.fn(() => true),
    archive: jest.fn(() => true),
    delete: jest.fn(() => true),
    startInitial: jest.fn(() => true),
    startNew: jest.fn(() => true),
    startShell: jest.fn(() => true),
  };
  const deps = {
    threadManager: {
      activeThread: thread,
      selectedThreadId: "thread-1",
      selectedThread: jest.fn(() => thread),
      thread: jest.fn(() => thread),
      withThread: jest.fn((_id: string, callback: (targetThread: typeof thread) => void) =>
        callback(thread),
      ),
      clearExecProcess: jest.fn(),
      trackExecProcess: jest.fn(),
    },
    lifecycle,
    request: jest.fn(() => true),
    requestWithId: jest.fn(() => true),
    sendResponse: jest.fn(() => true),
    startTurn: jest.fn(),
    onChanged: jest.fn(),
    clearAttention: jest.fn(),
  } as unknown as CodexInteractionDependencies;

  return { interaction: new CodexInteraction(deps), deps, lifecycle, thread };
}

describe("CodexInteraction", () => {
  test("dispatches parsed prompt commands to their owners", () => {
    const { interaction, lifecycle, thread } = createInteraction();

    expect(interaction.submitPrompt(parsePrompt("/compact", []))).toBe(true);
    expect(interaction.submitPrompt(parsePrompt("/plan", []))).toBe(true);
    expect(interaction.submitPrompt(parsePrompt("/fork", []))).toBe(true);
    expect(interaction.submitPrompt(parsePrompt("/archive", []))).toBe(true);
    expect(interaction.submitPrompt(parsePrompt("/delete", []))).toBe(true);

    expect(lifecycle.compact).toHaveBeenCalledTimes(1);
    expect(lifecycle.fork).toHaveBeenCalledTimes(1);
    expect(lifecycle.archive).toHaveBeenCalledTimes(1);
    expect(lifecycle.delete).toHaveBeenCalledTimes(1);
    expect(thread.setCollaborationMode).toHaveBeenCalledWith("plan");
  });

  test("starts a normal prompt on the selected idle thread", () => {
    const { interaction, deps, thread } = createInteraction();

    expect(interaction.submitPrompt(parsePrompt("hello", []))).toBe(true);

    expect(thread.prepareTurn).toHaveBeenCalledTimes(1);
    expect(thread.addUserMessage).toHaveBeenCalledWith("hello", undefined, []);
    expect(deps.startTurn).toHaveBeenCalledWith("thread-1", "hello", []);
  });

  test("steers the active turn with the selected thread and turn ids", () => {
    const { interaction, deps, thread } = createInteraction();
    thread.state.status = "working";
    thread.state.activeTurnId = "turn-1";

    expect(interaction.steerPrompt("change this")).toBe(true);

    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/steer",
        params: expect.objectContaining({ threadId: "thread-1", expectedTurnId: "turn-1" }),
      }),
      expect.any(Function),
    );
    expect((deps.request as jest.Mock).mock.calls[0][0].params.input[0].text).toContain(
      "Steer message:\nchange this",
    );
  });

  test("does not record a steer when transport rejects it", () => {
    const { interaction, deps, thread } = createInteraction();
    thread.state.status = "working";
    thread.state.activeTurnId = "turn-1";
    (deps.request as jest.Mock).mockReturnValue(false);

    expect(interaction.steerPrompt("change this")).toBe(false);
    expect(thread.addUserMessage).not.toHaveBeenCalled();
    expect(thread.rememberPrompt).not.toHaveBeenCalled();
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  test("interrupts the active turn", () => {
    const { interaction, deps, thread } = createInteraction();
    thread.state.status = "working";
    thread.state.activeTurnId = "turn-1";

    expect(interaction.interruptTurn()).toBe(true);

    expect(deps.request).toHaveBeenCalledWith(
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
      expect.any(Function),
    );
  });

  test("rejects invalid or controller-owned prompt commands", () => {
    const { interaction } = createInteraction();

    expect(interaction.submitPrompt(parsePrompt("", []))).toBe(false);
    expect(interaction.submitPrompt(parsePrompt("/model", []))).toBe(false);
  });

  test("answers pending user input and clears its attention", () => {
    const { interaction, deps, thread } = createInteraction();
    (thread.state as { pendingUserInput?: unknown }).pendingUserInput = {
      requestId: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        { id: "name", header: "Name", question: "Your name?", isSecret: false },
        { id: "token", header: "", question: "Token?", isSecret: true },
      ],
    };

    expect(interaction.respondUserInput({ name: ["Ada"], token: ["secret"] })).toBe(true);
    expect(deps.sendResponse).toHaveBeenCalledWith(7, {
      answers: { name: { answers: ["Ada"] }, token: { answers: ["secret"] } },
    });
    expect(thread.addMessage).toHaveBeenCalledWith("user", "Name: Ada\nToken?: [hidden]", "turn-1");
    expect(thread.clearUserInput).toHaveBeenCalled();
    expect(deps.clearAttention).toHaveBeenCalledWith("thread-1");
  });

  test("handles fuzzy search and rejected requests", async () => {
    const { interaction, deps } = createInteraction();
    const request = deps.request as jest.Mock;
    request.mockImplementationOnce((_request: unknown, callback: (message: unknown) => void) => {
      callback({ result: { files: [{ path: "/workspace/file.ts" }] } });
      return true;
    });
    await expect(interaction.fuzzyFileSearch("file", ["/workspace"])).resolves.toEqual([
      { path: "/workspace/file.ts" },
    ]);
    request.mockReturnValueOnce(false);
    await expect(interaction.fuzzyFileSearch("file", ["/workspace"])).resolves.toEqual([]);
  });

  test("starts a review and completes it when the request fails", () => {
    const { interaction, deps, thread } = createInteraction();

    expect(interaction.startReview("  review this  ")).toBe(true);
    expect(thread.beginReview).toHaveBeenCalled();
    expect(thread.setStatus).toHaveBeenCalledWith("working");
    const callback = (deps.request as jest.Mock).mock.calls[0][1] as (message: unknown) => void;
    callback({ error: "review failed" });
    expect(thread.completeTurn).toHaveBeenCalledWith(false);
  });

  test("does not begin a review when transport rejects it", () => {
    const { interaction, deps, thread } = createInteraction();
    (deps.request as jest.Mock).mockReturnValue(false);

    expect(interaction.startReview("review this")).toBe(false);
    expect(thread.beginReview).not.toHaveBeenCalled();
    expect(thread.setStatus).not.toHaveBeenCalled();
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  test("runs shell and exec commands", () => {
    const { interaction, deps, thread, lifecycle } = createInteraction();

    expect(interaction.submitPrompt(parsePrompt("!echo hi", []))).toBe(true);
    expect(deps.request).toHaveBeenCalledWith(
      { method: "thread/shellCommand", params: { threadId: "thread-1", command: "echo hi" } },
      expect.any(Function),
    );
    expect(interaction.submitPrompt(parsePrompt('/exec printf "hello"', []))).toBe(true);
    expect(deps.requestWithId).toHaveBeenCalled();
    expect(thread.addActivity).toHaveBeenCalled();
    expect(lifecycle.startShell).not.toHaveBeenCalled();
  });

  test("queues prompt input and resolves the server submission", () => {
    const { interaction, deps, thread } = createInteraction();
    thread.state.status = "working";
    const request = deps.request as jest.Mock;
    request.mockImplementationOnce((_request: unknown, callback: (message: unknown) => void) => {
      callback({ result: { queuedSubmission: { id: "queued-1" } } });
      return true;
    });

    expect(
      interaction.submitPrompt(parsePrompt("queue this", [{ url: "image.png", name: "Image" }])),
    ).toBe(true);
    expect(thread.queuePending).toHaveBeenCalled();
    expect(thread.resolveQueuedSubmission).toHaveBeenCalled();
  });
});
