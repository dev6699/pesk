/** @jest-environment node */
/// <reference types="jest" />
/// <reference types="node" />

import { CodexThread } from "../../src/codex/thread";

describe("CodexThread", () => {
  test("exposes a renderer snapshot scoped to the owning thread", () => {
    const thread = new CodexThread("thread-1");
    thread.setWorkingDirectory("/workspace/thread-1");
    thread.addMessage("user", "thread prompt");
    thread.setConnected(true);

    expect(thread.snapshot()).toEqual({
      status: "idle",
      connected: true,
      history: [expect.objectContaining({ text: "thread prompt" })],
      workingDirectory: "/workspace/thread-1",
      workingSince: undefined,
      workedElapsed: undefined,
      interrupted: false,
      tokenUsage: undefined,
      modelInfo: undefined,
      collaborationMode: "default",
      pendingUserInput: undefined,
      pendingApproval: undefined,
      queuedSubmissions: [],
    });
  });

  test("does not retain caller-owned history arrays", () => {
    const history = [{ role: "user" as const, text: "initial" }];
    const thread = new CodexThread("thread-1");
    thread.reset(history);

    history.push({ role: "user", text: "outside mutation" });
    thread.addMessage("assistant", "thread-owned");

    expect(thread.state.history).toEqual([
      expect.objectContaining({ text: "initial" }),
      expect.objectContaining({ text: "thread-owned" }),
    ]);
    const snapshot = thread.snapshot();
    snapshot.history.push({ role: "user", text: "snapshot mutation" });
    expect(thread.state.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "snapshot mutation" })]),
    );
  });

  test("keeps turn, streaming, and history state isolated per runtime", () => {
    const first = new CodexThread("thread-1");
    const second = new CodexThread("thread-2");

    first.addMessage("user", "first prompt");
    first.startTurn("turn-1");
    first.appendAssistantDelta("first output", "item-1", "turn-1");
    second.addMessage("user", "second prompt");
    second.startTurn("turn-2");
    second.appendAssistantDelta("second output", "item-2", "turn-2");

    expect(first.state.activeTurnId).toBe("turn-1");
    expect(first.state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "first prompt" }),
        expect.objectContaining({ text: "first output" }),
      ]),
    );
    expect(first.state.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "second output" })]),
    );
    expect(second.state.activeTurnId).toBe("turn-2");
  });

  test("completes only its own turn and assistant stream", () => {
    const thread = new CodexThread("thread-1");
    thread.addMessage("user", "prompt");
    thread.startTurn("turn-1");
    thread.setUserInput({
      requestId: "request-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [],
      isBlocking: true,
    });
    thread.appendAssistantDelta("partial", "item-1", "turn-1");
    thread.completeAssistant("completed", "item-1");
    expect(thread.state.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "completed", itemId: "item-1" })]),
    );
    thread.completeTurn(false);
    expect(thread.state.activeTurnId).toBeUndefined();
    expect(thread.state.status).toBe("idle");
  });

  test("keeps approval supersession inside the thread runtime", () => {
    const thread = new CodexThread("thread-1");
    thread.addApproval(
      "approval-1",
      {
        requestId: "approval-1",
        command: "npm test",
        reason: "run tests",
        decisions: new Map([["accept", "accept"]]),
      },
      {
        requestId: "approval-1",
        command: "npm test",
        reason: "run tests",
        options: [{ id: "accept", label: "Approve", description: "Allow" }],
      },
    );
    thread.setStatus("waiting");

    thread.addUserMessage("continue");

    expect(thread.state.pendingApprovals.size).toBe(0);
    expect(thread.state.pendingApproval).toBeUndefined();
    expect(thread.state.status).toBe("working");
  });

  test("reset clears thread-local state without affecting another runtime", () => {
    const first = new CodexThread("thread-1");
    const second = new CodexThread("thread-2");

    first.state.workingDirectory = "/workspace/first";
    first.addMessage("user", "first prompt");
    second.state.workingDirectory = "/workspace/second";
    second.addMessage("user", "second prompt");

    first.reset();

    expect(first.state.history).toEqual([]);
    expect(first.state.workingDirectory).toBe(process.cwd());
    expect(second.state.history).toEqual([expect.objectContaining({ text: "second prompt" })]);
    expect(second.state.workingDirectory).toBe("/workspace/second");
  });

  test("resets transport state without losing the conversation", () => {
    const thread = new CodexThread("thread-1");
    thread.addMessage("user", "keep this message");
    thread.setConnected(true);
    thread.startTurn("turn-1");
    thread.queuePending({
      id: "queued-1",
      text: "queued prompt",
      clientUserMessageId: "client-1",
    });
    thread.resetTransportState();

    expect(thread.state.connected).toBe(false);
    expect(thread.state.status).toBe("idle");
    expect(thread.state.activeTurnId).toBeUndefined();
    expect(thread.state.pendingUserInput).toBeUndefined();
    expect(thread.state.queuedSubmissions).toEqual([]);
    expect(thread.state.history).toEqual([expect.objectContaining({ text: "keep this message" })]);
  });

  test("clears a standalone conversation and its activity indexes", () => {
    const thread = new CodexThread("standalone");
    thread.addActivity({ id: "activity-1", type: "commandExecution" });
    thread.addMessage("user", "temporary prompt");

    thread.clearConversation();

    expect(thread.state.history).toEqual([]);
    expect(thread.state.activityIndexes.size).toBe(0);
    expect(thread.state.streamingAssistant).toBe(-1);
  });

  test("normalizes started and completed items inside the owning runtime", () => {
    const thread = new CodexThread("thread-1");

    thread.processStartedItem(
      {
        id: "plan-1",
        type: "plan",
        content: [{ text: "user request" }],
      },
      "turn-1",
      false,
    );
    thread.processCompletedItem({
      id: "assistant-1",
      type: "agentMessage",
      content: [{ text: "finished" }],
    });

    expect(thread.state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "user request" }),
        expect.objectContaining({ role: "assistant", text: "finished" }),
        expect.objectContaining({
          itemId: "plan-1",
          activity: expect.objectContaining({ kind: "plan" }),
        }),
      ]),
    );
  });

  test("does not echo a locally remembered prompt when processing a started item", () => {
    const thread = new CodexThread("thread-1");
    thread.addMessage("user", "already shown");
    thread.rememberPrompt("already shown");

    thread.processStartedItem(
      { type: "userMessage", content: [{ text: "already shown" }] },
      "turn-1",
      false,
    );

    expect(thread.state.history.filter((message) => message.text === "already shown")).toHaveLength(
      1,
    );
  });

  test("records images from an echoed user message", () => {
    const thread = new CodexThread("thread-1");

    thread.processStartedItem(
      {
        type: "userMessage",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", url: "data:image/png;base64,abc" },
        ],
      },
      "turn-1",
      false,
    );

    expect(thread.state.history).toEqual([
      expect.objectContaining({
        text: "describe this",
        images: [{ url: "data:image/png;base64,abc" }],
      }),
    ]);
  });

  test("restores persisted turns without replacing a live unsaved user message", () => {
    const thread = new CodexThread("thread-1");
    thread.addMessage("user", "live prompt");
    thread.setStatus("working");

    thread.restoreTurns([
      {
        createdAt: 1_700_000_000,
        items: [
          { type: "userMessage", content: [{ text: "persisted prompt" }] },
          { type: "agentMessage", text: "persisted answer" },
        ],
      },
    ]);

    expect(thread.state.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "live prompt" })]),
    );
    expect(thread.state.history).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "persisted answer" })]),
    );
  });

  test("restores review items in persisted order and token usage", () => {
    const thread = new CodexThread("thread-1");

    thread.restoreTurns([
      {
        createdAt: 1_700_000_000,
        tokenUsage: {
          total: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          last: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
        items: [
          { type: "enteredReviewMode", review: "review this" },
          { type: "agentMessage", text: "review result" },
          { type: "userMessage", content: [{ text: "actual request" }] },
          { type: "userMessage", content: [{ text: "review this" }] },
        ],
      },
    ]);

    expect(thread.state.history[0]).toEqual(
      expect.objectContaining({
        activity: expect.objectContaining({ label: "enteredReviewMode" }),
      }),
    );
    expect(thread.state.history[1]).toEqual(expect.objectContaining({ text: "review result" }));
    expect(thread.state.history[2]).toEqual(expect.objectContaining({ text: "actual request" }));
    expect(thread.state.tokenUsage?.total.totalTokens).toBe(6);
  });

  test("maps server lifecycle status to isolated runtime status", () => {
    const thread = new CodexThread("thread-1");

    thread.applyServerStatus({ type: "active" });
    expect(thread.state.status).toBe("working");
    thread.applyServerStatus({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(thread.state.status).toBe("waiting");
    thread.applyServerStatus({ type: "idle" });
    expect(thread.state.status).toBe("idle");
  });

  test("normalizes model metadata without affecting another runtime", () => {
    const first = new CodexThread("thread-1");
    const second = new CodexThread("thread-2");

    expect(
      first.mergeModelInfoFromServer({
        model: "gpt-test",
        modelProvider: "openai",
        effort: "high",
        serviceTier: "priority",
      }),
    ).toBe(true);
    expect(first.state.modelInfo).toEqual({
      model: "gpt-test",
      provider: "openai",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    expect(second.state.modelInfo).toBeUndefined();
    expect(first.mergeModelInfoFromServer({ unknown: true })).toBe(false);
  });

  test("rebuilds activity indexes when persisted history is restored", () => {
    const thread = new CodexThread("thread-1");

    thread.restoreTurns([
      {
        items: [
          {
            id: "command-1",
            type: "commandExecution",
            command: "npm test",
          },
        ],
      },
    ]);
    thread.appendActivityOutput("command-1", "tests passed");

    expect(thread.state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "command-1",
          activity: expect.objectContaining({ output: "tests passed" }),
        }),
      ]),
    );
  });

  test("resolves approvals and advances only its own approval queue", () => {
    const thread = new CodexThread("thread-1");
    thread.addApproval(
      "approval-1",
      {
        requestId: "approval-1",
        command: "npm test",
        reason: "Run the test suite",
        decisions: new Map([["accept", "accept"]]),
      },
      {
        requestId: "approval-1",
        command: "npm test",
        reason: "Run the test suite",
        options: [],
      },
    );

    const resolution = thread.resolveApprovalSelection("approval-1", "accept");

    expect(resolution).toEqual({ decision: "accept", hasPending: false });
    expect(thread.state.pendingApproval).toBeUndefined();
    expect(thread.state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          approval: expect.objectContaining({
            requestId: "approval-1",
            state: "approved",
          }),
        }),
      ]),
    );
  });

  test("normalizes only valid queued submissions from server data", () => {
    const thread = new CodexThread("thread-1");

    thread.replaceQueueFromServer([
      {
        id: "queued-1",
        clientUserMessageId: "client-1",
        input: [{ type: "text", text: "run later" }],
      },
      { id: "missing-client-id", input: [] },
      "invalid submission",
    ]);

    expect(thread.state.queuedSubmissions).toEqual([
      {
        id: "queued-1",
        clientUserMessageId: "client-1",
        text: "run later",
      },
    ]);
  });

  test("preserves images when normalizing queued submissions", () => {
    const thread = new CodexThread("thread-1");

    thread.replaceQueueFromServer([
      {
        id: "queued-1",
        clientUserMessageId: "client-1",
        input: [
          { type: "text", text: "inspect later" },
          { type: "image", url: "data:image/jpeg;base64,def" },
        ],
      },
    ]);

    expect(thread.state.queuedSubmissions).toEqual([
      expect.objectContaining({
        text: "inspect later",
        images: [{ url: "data:image/jpeg;base64,def" }],
      }),
    ]);
  });

  test("continues streaming after history is trimmed", () => {
    const thread = new CodexThread("thread-1");
    thread.state.history = Array.from({ length: 40 }, (_, index) => ({
      role: "user",
      text: `message ${index}`,
    }));

    thread.appendAssistantDelta("first");
    thread.appendAssistantDelta(" second");

    expect(thread.state.history.at(-1)).toMatchObject({
      role: "assistant",
      text: "first second",
    });
  });

  test("starts a new stream after the previous assistant item completes", () => {
    const thread = new CodexThread("thread-1");

    thread.appendAssistantDelta("first", "assistant-1");
    thread.completeAssistant("first complete", "assistant-1");
    thread.appendAssistantDelta("second", "assistant-2");

    expect(thread.state.history).toEqual([
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

  test("handles duplicate, blank, and expired prompt state locally", () => {
    const thread = new CodexThread("thread-1");

    thread.completeAssistant("   ");
    thread.completeAssistant("fallback assistant");
    thread.addMessage("user", "duplicate");
    thread.addMessage("user", "duplicate");
    thread.insertUser("duplicate");
    thread.state.prompts.set("expired", Date.now() - 20_000);

    expect(thread.consumePrompt("expired")).toBe(false);
    expect(thread.state.history).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "fallback assistant" })]),
    );
  });
});
