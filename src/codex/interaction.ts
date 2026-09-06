import { randomUUID } from "node:crypto";
import type { FuzzyFileSearchResponse, RequestId } from "../codex-schema";
import type { CommandExecResponse, ReviewStartResponse } from "../codex-schema/v2";
import type { UserInput } from "../codex-schema/v2/UserInput";
import {
  requestIdKey,
  type JsonRpcResponse,
  type OutgoingRequestInput,
  type LocalQueueAddResponse,
} from "./protocol";
import { CodexThreadManager } from "./thread-manager";
import { CodexThreadLifecycle } from "./thread-lifecycle";
import { parsePrompt, type ParsedPrompt } from "./prompt";

export interface CodexInteractionDependencies {
  threadManager: CodexThreadManager;
  lifecycle: CodexThreadLifecycle;
  request: <T>(
    request: OutgoingRequestInput,
    callback: (message: JsonRpcResponse<T>) => void,
  ) => boolean;
  requestWithId: <T>(
    buildRequest: (id: number) => OutgoingRequestInput,
    callback: (message: JsonRpcResponse<T>) => void,
  ) => boolean;
  sendResponse: (id: RequestId, result: unknown) => boolean;
  startTurn: (threadId: string, prompt: string, extraInput?: UserInput[]) => void;
  onChanged: () => void;
  clearAttention: (threadId: string) => void;
  onAttentionCleared?: () => void;
}

/** Owns operations initiated directly by application clients. */
export class CodexInteraction {
  /** Creates the user-action coordinator with controller-owned collaborators. */
  constructor(private readonly deps: CodexInteractionDependencies) {}

  /** Executes an already-parsed prompt action. */
  submitPrompt(parsed: ParsedPrompt): boolean {
    switch (parsed.kind) {
      case "invalid":
        return false;
      case "compact":
        return this.deps.lifecycle.compact();
      case "mode":
        this.setCollaborationMode(parsed.mode);
        return true;
      case "fork":
        return this.deps.lifecycle.fork();
      case "archive":
        return this.deps.lifecycle.archive();
      case "delete":
        return this.deps.lifecycle.delete();
      case "shell":
        return this.submitShellCommand(parsed.command);
      case "exec":
        return this.submitExecCommand(parsed.commandText, parsed.argv);
      case "text":
        return this.submitText(parsed.text, parsed.inputs, parsed.metadata);
      default:
        return false;
    }
  }

  /** Changes the collaboration mode used by subsequent turns. */
  setCollaborationMode(mode: "default" | "plan"): void {
    this.deps.threadManager.activeThread.setCollaborationMode(mode);
    this.deps.onChanged();
  }

  /** Starts implementation either in the current thread or a fresh thread. */
  implementPlan(planText: string, clearContext: boolean): boolean {
    this.setCollaborationMode("default");
    if (!clearContext) return this.submitPrompt(parsePrompt("Implement the plan.", []));
    const prompt = [
      "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.",
      "",
      planText.trim(),
    ].join("\n");
    return this.deps.lifecycle.startNew(undefined, prompt);
  }

  /** Answers and clears the selected thread's pending user-input request. */
  respondUserInput(answers: Record<string, string[]>): boolean {
    const thread = this.deps.threadManager.activeThread;
    const pending = thread.state.pendingUserInput;
    if (!pending) return false;
    const responseAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    );
    if (!this.deps.sendResponse(pending.requestId, { answers: responseAnswers })) return false;
    const answerText = pending.questions
      .map((question) => {
        const values = answers[question.id] ?? [];
        const displayed = question.isSecret ? values.map(() => "[hidden]") : values;
        return `${question.header || question.question}: ${displayed.join(", ") || "No answer"}`;
      })
      .join("\n");
    thread.addMessage("user", answerText || "No answer provided.", pending.turnId);
    thread.clearUserInput();
    this.deps.clearAttention(pending.threadId);
    this.deps.onChanged();
    return true;
  }

  /** Searches the requested roots using the app-server fuzzy-file API. */
  fuzzyFileSearch(
    query: string,
    roots: string[],
  ): Promise<import("../codex-schema").FuzzyFileSearchResult[]> {
    if (!roots.length) return Promise.resolve([]);
    return new Promise((resolve) => {
      const accepted = this.deps.request<FuzzyFileSearchResponse>(
        { method: "fuzzyFileSearch", params: { query, roots, cancellationToken: null } },
        (message) => {
          resolve(message.result?.files ?? []);
        },
      );
      if (!accepted) resolve([]);
    });
  }

  /** Interrupts the active turn in the selected thread. */
  interruptTurn(): boolean {
    const thread = this.deps.threadManager.activeThread;
    const turnId = thread.state.activeTurnId;
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!threadId || !turnId) return false;
    return this.deps.request(
      { method: "turn/interrupt", params: { threadId, turnId } },
      () => undefined,
    );
  }

  /** Starts an inline custom review on the selected idle thread. */
  startReview(instructions: string): boolean {
    const value = instructions.trim();
    const thread = this.deps.threadManager.activeThread;
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!value || !threadId || thread.state.status !== "idle") return false;
    const accepted = this.deps.request<ReviewStartResponse>(
      {
        method: "review/start",
        params: { threadId, delivery: "inline", target: { type: "custom", instructions: value } },
      },
      (message) => {
        this.deps.threadManager.withThread(threadId, (targetThread) => {
          targetThread.setActiveTurn(message.result?.turn.id);
          if (message.error) {
            targetThread.completeTurn(false);
            this.deps.onChanged();
          }
        });
      },
    );
    if (!accepted) return false;
    thread.beginReview();
    thread.setStatus("working");
    this.deps.onChanged();
    return true;
  }

  /** Sends a steer to the active turn in the selected thread. */
  steerPrompt(value: string): boolean {
    const prompt = value.trim();
    const thread = this.deps.threadManager.activeThread;
    const turnId = thread.state.activeTurnId;
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!prompt || !threadId || !turnId || !["working", "waiting"].includes(thread.state.status))
      return false;
    const steerInstructions = `Treat this message as a steer to the currently active request. Preserve all existing requirements, constraints, entities, and output formats unless this steer explicitly changes, removes, cancels, or replaces them. Apply only the requested change and continue the complete updated request. If the steer is materially ambiguous, ask one concise clarifying question. Otherwise, use the most natural interpretation and proceed. Steer message:\n`;
    const steerPrompt = `${steerInstructions}${prompt}`;
    const accepted = this.deps.request(
      {
        method: "turn/steer",
        params: {
          threadId,
          input: [{ type: "text", text: steerPrompt, text_elements: [] }],
          expectedTurnId: turnId,
          clientUserMessageId: randomUUID(),
        },
      },
      () => undefined,
    );
    if (!accepted) return false;
    thread.addUserMessage(steerPrompt);
    this.deps.onChanged();
    thread.rememberPrompt(prompt);
    thread.rememberPrompt(steerPrompt);
    return true;
  }

  /** Resolves one pending approval option for the selected thread. */
  respondPermission(requestId: RequestId, optionId: string): void {
    const thread = this.deps.threadManager.activeThread;
    const pending = thread.state.pendingApprovals.get(requestIdKey(requestId));
    const decision = pending?.decisions.get(optionId);
    if (!pending || decision === undefined) return;
    if (!this.deps.sendResponse(requestId, { decision })) return;
    const resolution = thread.resolveApprovalSelection(requestIdKey(requestId), optionId);
    if (!resolution) return;
    this.deps.clearAttention(thread.id);
    this.deps.onChanged();
    if (!resolution.hasPending) this.deps.onAttentionCleared?.();
    thread.setStatus("working");
    this.deps.onChanged();
  }

  /** Starts a normal turn or queues its input when a turn is already active. */
  private submitText(
    text: string,
    inputs: UserInput[],
    metadata: Array<{ url: string; name?: string }>,
  ): boolean {
    const thread = this.deps.threadManager.activeThread;
    if (thread.state.status !== "idle") return this.queuePromptInput(inputs, text, metadata);
    const extraInput = inputs.filter((input) => input.type === "image");
    thread.prepareTurn();
    thread.addUserMessage(text, undefined, metadata);
    this.deps.onChanged();
    thread.rememberPrompt(text);
    const threadId = this.deps.threadManager.selectedThreadId;
    if (threadId) {
      this.deps.startTurn(threadId, text, extraInput);
      return true;
    }
    return this.deps.lifecycle.startInitial((targetThread) =>
      this.deps.startTurn(targetThread.id, text, extraInput),
    );
  }

  /** Runs a shell command through the selected or newly created thread. */
  private submitShellCommand(command: string): boolean {
    const sendCommand = (threadId: string): void => {
      const accepted = this.deps.request(
        { method: "thread/shellCommand", params: { threadId, command } },
        () => undefined,
      );
      if (!accepted) return;
      this.deps.threadManager.thread(threadId).setStatus("working");
      this.deps.onChanged();
    };
    const selectedId = this.deps.threadManager.selectedThreadId;
    if (selectedId) {
      this.deps.threadManager.selectedThread().addUserMessage(`!${command}`);
      this.deps.onChanged();
      sendCommand(selectedId);
      return true;
    }
    const thread = this.deps.threadManager.activeThread;
    if (thread.state.status !== "idle") return false;
    thread.addUserMessage(`!${command}`);
    this.deps.onChanged();
    return this.deps.lifecycle.startShell((createdThread) => sendCommand(createdThread.id));
  }

  /** Runs a standalone command through the app-server sandbox. */
  private submitExecCommand(commandText: string, command: string[]): boolean {
    if (!command.length) return false;
    let processId = "";
    const thread = this.deps.threadManager.activeThread;
    const cwd = thread.state.workingDirectory ?? process.cwd();
    const accepted = this.deps.requestWithId<CommandExecResponse>(
      (id) => {
        processId = `pesk-exec-${id}`;
        return { method: "command/exec", params: { command, processId, cwd } };
      },
      (message) => {
        const result = message.result;
        thread.addActivity(
          {
            id: processId,
            type: "commandExecution",
            source: "unifiedExecStartup",
            userInitiated: true,
            command: command.join(" "),
            cwd,
            status: message.error ? "failed" : result?.exitCode === 0 ? "completed" : "failed",
            exitCode: result?.exitCode,
            aggregatedOutput: [result?.stdout, result?.stderr].filter(Boolean).join("\n"),
          },
          processId,
        );
        this.deps.threadManager.clearExecProcess(processId);
        if (!thread.state.activeTurnId) thread.setStatus("idle");
        this.deps.onChanged();
      },
    );
    if (!accepted) return false;
    this.deps.threadManager.trackExecProcess(processId, thread);
    thread.addUserMessage(`/exec ${commandText}`);
    thread.addActivity(
      {
        id: processId,
        type: "commandExecution",
        source: "unifiedExecStartup",
        userInitiated: true,
        command: command.join(" "),
        cwd,
        status: "inProgress",
      },
      processId,
    );
    thread.setStatus("working");
    this.deps.onChanged();
    return true;
  }

  /** Queues text and image input while preserving local attachment metadata. */
  private queuePromptInput(
    input: UserInput[],
    prompt: string,
    queuedImageMetadata: Array<{ url: string; name?: string }>,
  ): boolean {
    const thread = this.deps.threadManager.activeThread;
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!threadId || !["working", "waiting"].includes(thread.state.status)) return false;
    const clientUserMessageId = randomUUID();
    const accepted = this.deps.request<LocalQueueAddResponse>(
      {
        method: "thread/queue/add",
        params: { threadId, input: input as never, clientUserMessageId },
      },
      (message) => {
        const submission = message.result?.queuedSubmission;
        if (!submission) return;
        this.deps.threadManager.withThread(threadId, (targetThread) => {
          targetThread.resolveQueuedSubmission(clientUserMessageId, {
            id: submission.id,
            text: prompt,
            ...(queuedImageMetadata.length ? { images: queuedImageMetadata } : {}),
            clientUserMessageId,
          });
          this.deps.onChanged();
        });
      },
    );
    if (!accepted) return false;
    thread.queuePending({
      id: `pending-${clientUserMessageId}`,
      text: prompt,
      ...(queuedImageMetadata.length ? { images: queuedImageMetadata } : {}),
      clientUserMessageId,
    });
    this.deps.onChanged();
    return true;
  }
}
