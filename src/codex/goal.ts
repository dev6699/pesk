import type {
  ThreadGoal,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetResponse,
} from "../codex-schema/v2";
import type {
  JsonRpcResponse,
  ThreadGoalClearRequest,
  ThreadGoalGetRequest,
  ThreadGoalSetRequest,
} from "./protocol";

export type GoalRequestInput =
  | Omit<ThreadGoalSetRequest, "id">
  | Omit<ThreadGoalGetRequest, "id">
  | Omit<ThreadGoalClearRequest, "id">;

export interface GoalManagerOptions {
  request: <TResult>(
    request: GoalRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ) => void;
  setGoal: (threadId: string, goal: ThreadGoal | undefined) => void;
  publishRendererState: () => void;
  setCommandNotice: (notice: string) => void;
  setConnectionError: (error: string) => void;
  setCollaborationMode: (mode: "default" | "plan") => void;
}

/**
 * Coordinates the renderer's native goal commands with the app-server goal
 * lifecycle while keeping thread state updates behind controller callbacks.
 */
export class CodexGoalManager {
  constructor(private readonly options: GoalManagerOptions) {}

  /** Parses a `/goal` command and starts the corresponding lifecycle request. */
  manage(threadId: string | undefined, goal: ThreadGoal | undefined, command: string): boolean {
    if (!threadId) return false;

    const value = command.trim();
    if (!value) {
      this.options.setCommandNotice(
        goal
          ? [
              "Goal",
              `Status: ${goal.status}`,
              `Objective: ${goal.objective}`,
              `Time used: ${formatGoalDuration(goal.timeUsedSeconds)}`,
              `Tokens used: ${formatGoalTokens(goal.tokensUsed)}`,
              `Commands: ${goalCommands(goal.status)}`,
            ].join("\n")
          : "Usage: /goal [<objective>|clear|edit|pause|resume]\nNo goal is currently set.",
      );
      this.options.publishRendererState();
      return true;
    }

    if (value.toLowerCase() === "clear") return this.clear(threadId);
    if (value.toLowerCase() === "pause" || value.toLowerCase() === "resume") {
      this.set(threadId, undefined, value.toLowerCase() === "pause" ? "paused" : "active");
      return true;
    }

    const editMatch = value.match(/^edit(?:\s+(.+))?$/is);
    if (editMatch) {
      const objective = editMatch[1]?.trim();
      if (!objective) {
        this.options.setCommandNotice(
          goal
            ? "Usage: /goal edit <objective>\nEnter the replacement objective."
            : "No goal is currently set to edit.",
        );
        this.options.publishRendererState();
        return true;
      }
      if (!goal) {
        this.options.setCommandNotice("No goal is currently set to edit.");
        this.options.publishRendererState();
        return true;
      }
      this.set(threadId, objective, undefined, undefined, "Unable to edit the goal.");
      return true;
    }

    this.set(threadId, value, "active", () => this.options.setCollaborationMode("default"));
    return true;
  }

  /** Restores a thread's persisted goal after its thread state has been read. */
  restore(threadId: string): void {
    this.options.request<ThreadGoalGetResponse>(
      { method: "thread/goal/get", params: { threadId } },
      (message) => {
        this.options.setGoal(threadId, message.result?.goal ?? undefined);
        this.options.publishRendererState();
      },
    );
  }

  /** Applies a server notification announcing or updating a thread goal. */
  handleUpdated(threadId: string, goal: ThreadGoal): void {
    this.options.setGoal(threadId, goal);
    this.options.publishRendererState();
  }

  /** Applies a server notification clearing a thread goal. */
  handleCleared(threadId: string): void {
    this.options.setGoal(threadId, undefined);
    this.options.publishRendererState();
  }

  private set(
    threadId: string,
    objective: string | undefined,
    status: ThreadGoal["status"] | undefined,
    onSuccess?: () => void,
    failureMessage = "Unable to create the goal; implementation was not started.",
  ): void {
    this.options.request<ThreadGoalSetResponse>(
      {
        method: "thread/goal/set",
        params: { threadId, ...(objective ? { objective } : {}), ...(status ? { status } : {}) },
      },
      (message) => {
        const goal = message.result?.goal;
        if (message.error || !goal || (objective && goal.objective !== objective)) {
          this.options.setConnectionError(failureMessage);
          this.options.publishRendererState();
          return;
        }
        this.options.setGoal(threadId, goal);
        this.options.publishRendererState();
        onSuccess?.();
      },
    );
  }

  private clear(threadId: string): boolean {
    this.options.request<ThreadGoalClearResponse>(
      { method: "thread/goal/clear", params: { threadId } },
      (message) => {
        if (message.error || message.result?.cleared !== true) return;
        this.options.setGoal(threadId, undefined);
        this.options.publishRendererState();
      },
    );
    return true;
  }
}

export function formatGoalTokens(tokens: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(tokens);
}

export function formatGoalDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${remainderSeconds}s`;
}

export function goalCommands(status: ThreadGoal["status"]): string {
  if (status === "complete") return "/goal edit <objective>, /goal clear";
  if (status === "paused") return "/goal edit <objective>, /goal resume, /goal clear";
  return "/goal edit <objective>, /goal pause, /goal clear";
}
