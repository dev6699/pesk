import type { TurnStartResponse } from "../codex-schema/v2";
import type { UserInput } from "../codex-schema/v2/UserInput";
import {
  isRecord,
  type JsonRpcResponse,
  type OutgoingRequestInput,
  type PlanTurnStartParams,
  type ServerMessage,
} from "./protocol";
import { CodexThread, parseTokenUsageValue } from "./thread";
import { CodexThreadManager } from "./thread-manager";

export interface TurnManagerOptions {
  threadManager: CodexThreadManager;
  request: <TResult>(
    request: OutgoingRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ) => boolean;
  onStateChanged: () => void;
}

export interface TurnCompletionResult {
  queueRefresh?: string;
}

/** Owns starting turns and reconciling the turn-start response with local state. */
export class CodexTurnManager {
  constructor(private readonly options: TurnManagerOptions) {}

  /** Applies a turn-started notification to its owning thread. */
  handleStarted(
    message: Extract<ServerMessage, { method: "turn/started" }>,
    thread: CodexThread,
  ): void {
    const turnId = message.params.turn.id;
    if (typeof message.params.threadId !== "string") {
      thread.setActiveTurn(turnId);
      thread.ensureWorking();
      thread.setStatus("working");
      return;
    }
    thread.startTurn(turnId);
  }

  /** Completes a turn and applies usage returned by the server. */
  handleCompleted(
    message: Extract<ServerMessage, { method: "turn/completed" }>,
    thread: CodexThread,
    ignoreUsage: boolean,
  ): TurnCompletionResult {
    const turn = isRecord(message.params.turn)
      ? (message.params.turn as Record<string, unknown>)
      : undefined;
    thread.completeTurn(message.params.turn?.status === "interrupted");
    if (typeof message.params.threadId === "string") {
      thread.clearUserInput();
      this.options.threadManager.clearAttention(message.params.threadId);
    } else {
      thread.setStatus("idle");
    }
    if (!ignoreUsage) {
      const usage = parseTokenUsageValue(turn?.tokenUsage ?? turn?.usage);
      if (usage) thread.setTokenUsage(usage);
    }
    return {
      queueRefresh:
        typeof message.params.threadId === "string" ? message.params.threadId : undefined,
    };
  }

  /** Starts a text turn and creates a temporary working message. */
  start(threadId: string, prompt: string, extraInput: UserInput[] = []): void {
    const thread = this.options.threadManager.thread(threadId);
    thread.prepareTurn();
    const params: PlanTurnStartParams = {
      threadId,
      input: [
        ...(prompt ? [{ type: "text" as const, text: prompt, text_elements: [] }] : []),
        ...extraInput,
      ],
    };
    const settings = {
      ...(thread.state.modelInfo?.model ? { model: thread.state.modelInfo.model } : {}),
      reasoning_effort: thread.state.collaborationMode === "plan" ? "medium" : null,
      developer_instructions: null,
    };
    params.collaborationMode = {
      mode: thread.state.collaborationMode,
      settings,
    } as PlanTurnStartParams["collaborationMode"];
    this.options.request<TurnStartResponse>({ method: "turn/start", params }, (message) => {
      this.options.threadManager.withThread(threadId, (targetThread) => {
        targetThread.setActiveTurn(message.result?.turn.id);
        if (message.error) {
          targetThread.setStatus("idle");
          this.options.onStateChanged();
        }
      });
    });
    if (!this.options.threadManager.isSelected(threadId)) {
      this.options.threadManager.trackBackgroundWork(threadId);
    }
    this.options.threadManager.withThread(threadId, (targetThread) => {
      targetThread.setStatus("working");
      this.options.onStateChanged();
    });
  }
}
