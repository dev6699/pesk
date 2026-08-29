import type {
  ClientNotification,
  InitializeResponse,
  RequestId,
} from "../codex-schema";
import {
  describeSocketError,
  approvalDecisions,
  isJsonRpcResponse,
  isRecord,
  isThread,
  messageThreadId,
  records,
  requestIdKey,
  shouldReconcileOnIdle,
  shouldResumeOnActiveStatus,
} from "./protocol";
import type { NotificationRequest } from "../notification";
import type {
  IncomingMessage,
  JsonRpcResponse,
  PermissionApprovalResponse,
  ServerMessage,
} from "./protocol";
import { CodexThread, parseTokenUsageValue, approvalOptions } from "./thread";
import { randomUUID } from "node:crypto";
import type {
  Thread,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadReadResponse,
  ThreadStartResponse,
  TurnStartResponse,
  ReviewStartResponse,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  CommandExecResponse,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
} from "../codex-schema/v2";
import type {
  FuzzyFileSearchResponse,
  FuzzyFileSearchResult,
} from "../codex-schema";
import type { CodexState, CodexThreadActivity } from "./types";
import type {
  AccountRateLimitsRequest,
  CommandExecRequest,
  FuzzyFileSearchRequest,
  InitializeRequest,
  LocalQueueAddResponse,
  LocalQueueListResponse,
  OutgoingMessage,
  PlanTurnStartParams,
  ReviewStartRequest,
  ThreadListRequest,
  ThreadReadRequest,
  ThreadArchiveRequest,
  ThreadDeleteRequest,
  ThreadResumeRequest,
  ThreadShellCommandRequest,
  ThreadStartRequest,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnSteerRequest,
} from "./protocol";

const STEER_INSTRUCTIONS = `Treat this message as a steer to the currently active request.

Preserve all existing requirements, constraints, entities, and output formats unless this steer explicitly changes, removes, cancels, or replaces them. Apply only the requested change and continue the complete updated request.

If the steer is materially ambiguous, ask one concise clarifying question. Otherwise, use the most natural interpretation and proceed.

Steer message:
`;

/** Codex-related settings persisted alongside the pet settings. */
interface Options {
  publishRendererState: () => void;
  handleNotification: (request: NotificationRequest) => void;
  isChatVisible: () => boolean;
  clearNotification?: () => void;
  debug: (...values: unknown[]) => void;
}

/**
 * Owns the Codex app-server connection and translates protocol events into
 * renderer-friendly conversation and status state.
 *
 * Window management remains in main.ts; callbacks notify it about UI changes.
 */
export class CodexController {
  /** Active WebSocket transport, or null while disconnected. */
  private socket: WebSocket | null = null;
  /** App-server endpoint used for the current and future connections. */
  private url = "ws://127.0.0.1:4500";
  /** Currently selected thread in the renderer. */
  private threadId: string | undefined;
  /** Human-readable transport error shown by the renderer. */
  private connectionError: string | undefined;
  /** Known selectable threads returned by app-server discovery. */
  private threads: Thread[] = [];
  /** True while /new is replacing the selected thread. */
  private startingNewThread = false;
  /** Latest account-wide ChatGPT rate-limit snapshot. */
  private rateLimits: RateLimitSnapshot | undefined;
  /** Prevents duplicate initial rate-limit reads from multiple renderer windows. */
  private rateLimitsReadPending = false;
  /** Whether initialize/initialized completed on the current socket. */
  private initialized = false;
  /** Monotonic JSON-RPC request id for this controller instance. */
  private nextId = 0;
  /** Delayed reconnect task after a transport close or failure. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Prevents close/error paths from reconnecting after an explicit stop. */
  private stopped = false;
  /** Prevents duplicate thread discovery requests. */
  private discoveryPending = false;
  /** Locally requested thread starts awaiting their responses/events. */
  private pendingThreadStarts = 0;
  /** Thread id announced as active and awaiting resume. */
  private pendingThreadResumeId: string | undefined;
  /** Correlates local thread/start responses with thread/started events. */
  private readonly locallyStartedThreads = new Set<string>();
  /** Callbacks waiting for JSON-RPC responses keyed by request id. */
  private readonly requests = new Map<
    number,
    (message: JsonRpcResponse) => void
  >();
  /** Isolated runtime state for every known or active thread. */
  private readonly threadControllers = new Map<string, CodexThread>();
  /** Local command/exec activity before a Codex thread exists. */
  private readonly standaloneThread = new CodexThread("standalone");
  /** Runtime owning each standalone command/exec process. */
  private readonly execRuntimes = new Map<string, CodexThread>();
  /** Runtime currently being applied while routing a background event. */
  private routedThreadId: string | undefined;
  private readonlyThreadIds = new Set<string>();
  /** Suppresses renderer publication while a background runtime is updated. */
  private suppressedPublication = 0;
  /** Pending background requests, retained in first-arrival order. */
  private readonly attentionQueue = new Map<string, "approval" | "userInput">();

  /** Creates a controller with callbacks for renderer and window updates. */
  constructor(options: Options) {
    this.options = {
      ...options,
      publishRendererState: () => {
        if (this.suppressedPublication === 0) {
          options.publishRendererState();
        }
      },
      handleNotification: (request) => {
        if (this.suppressedPublication === 0)
          options.handleNotification(request);
      },
    };
  }

  private readonly options: Options;

  /** Returns the runtime selected for UI work or currently routed background work. */
  private threadRuntime(): CodexThread {
    const threadId = this.routedThreadId ?? this.threadId;
    return threadId ? this.runtime(threadId) : this.standaloneThread;
  }

  /** Gets or creates the isolated runtime for a server thread ID. */
  private runtime(threadId: string): CodexThread {
    let runtime = this.threadControllers.get(threadId);
    if (!runtime) {
      runtime = new CodexThread(threadId);
      this.threadControllers.set(threadId, runtime);
    }
    return runtime;
  }

  /** Runs a notification against its own runtime without changing the UI selection. */
  private withRuntime<T>(threadId: string, callback: () => T): T {
    if (this.threadId === threadId) return callback();
    const previousRoutedThreadId = this.routedThreadId;
    this.routedThreadId = threadId;
    this.suppressedPublication += 1;
    try {
      return callback();
    } finally {
      this.suppressedPublication -= 1;
      this.routedThreadId = previousRoutedThreadId;
    }
  }

  /** Returns the current state snapshot for renderer IPC responses. */
  getState(): CodexState {
    const thread = this.threadRuntime().snapshot();
    const threadActivities = this.getThreadActivities();
    const aggregateStatus: CodexState["status"] = threadActivities.some(
      (activity) => activity.status === "waiting",
    )
      ? "waiting"
      : threadActivities.some((activity) => activity.status === "working")
        ? "working"
        : "idle";
    return {
      threadId: this.threadId,
      readOnly: Boolean(this.threadId && this.readonlyThreadIds.has(this.threadId)),
      cwd: thread.workingDirectory ?? process.cwd(),
      error: this.connectionError,
      status: thread.status,
      aggregateStatus,
      connected: thread.connected,
      history: thread.history,
      threads: this.threads,
      threadActivities,
      workingSince: thread.workingSince,
      workedElapsed: thread.workedElapsed,
      interrupted: thread.interrupted,
      tokenUsage: thread.tokenUsage,
      modelInfo: thread.modelInfo,
      rateLimits: this.rateLimits,
      collaborationMode: thread.collaborationMode,
      pendingUserInput: thread.pendingUserInput,
      pendingApproval: thread.pendingApproval,
      queuedSubmissions: thread.queuedSubmissions,
    };
  }

  /** Returns normalized activity for every known or currently materialized thread. */
  private getThreadActivities(): CodexThreadActivity[] {
    const known = new Map<string, Thread | undefined>(
      this.threads.map((thread) => [thread.id, thread]),
    );
    for (const id of this.threadControllers.keys()) {
      if (!known.has(id)) known.set(id, undefined);
    }
    return [...known.entries()].map(([threadId, thread]) => {
      const runtime = this.threadControllers.get(threadId);
      const snapshot = runtime?.snapshot();
      const attention = runtime?.state.pendingUserInput
        ? "userInput"
        : runtime?.state.pendingApproval
          ? "approval"
          : undefined;
      return {
        threadId,
        preview: thread?.preview ?? threadId,
        status: snapshot?.status ?? "idle",
        workingSince: snapshot?.workingSince,
        attention,
      };
    });
  }

  /** Changes the app-server endpoint before the controller starts. */
  setSocketUrl(url: string): void {
    this.url = url;
  }

  /** Starts the WebSocket connection and reconnect lifecycle. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Stops the connection and cancels pending reconnect timers. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
  }

  /** Selects a known Codex thread and resumes it. */
  selectThread(id: string): void {
    this.switchThread(id);
  }

  /** Selects the collaboration mode used for the next turn. */
  setCollaborationMode(mode: "default" | "plan"): void {
    this.threadRuntime().setCollaborationMode(mode);
    this.options.publishRendererState();
  }

  /** Starts implementation from a completed plan confirmation. */
  implementPlan(planText: string, clearContext: boolean): boolean {
    this.setCollaborationMode("default");
    if (!clearContext) {
      return this.submitPrompt("Implement the plan.");
    }
    const prompt = [
      "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.",
      "",
      planText.trim(),
    ].join("\n");
    return this.startNewThread(undefined, prompt);
  }

  /** Answers an app-server request_user_input request. */
  respondUserInput(answers: Record<string, string[]>): boolean {
    const runtime = this.threadRuntime();
    const pending = runtime.state.pendingUserInput;
    if (!pending || !this.initialized) return false;
    const responseAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [
        questionId,
        { answers: values },
      ]),
    );
    this.send({
      id: pending.requestId,
      result: { answers: responseAnswers },
    });
    const answerText = pending.questions
      .map((question) => {
        const values = answers[question.id] ?? [];
        const displayed = question.isSecret
          ? values.map(() => "[hidden]")
          : values;
        return `${question.header || question.question}: ${displayed.join(", ") || "No answer"}`;
      })
      .join("\n");
    runtime.addMessage(
      "user",
      answerText || "No answer provided.",
      pending.turnId,
    );
    runtime.clearUserInput();
    this.clearAttention(pending.threadId);
    this.options.publishRendererState();
    this.routeNextAttention();
    return true;
  }

  /** Requests the complete account-wide rate-limit snapshot. */
  refreshRateLimits(): void {
    if (!this.initialized || this.rateLimitsReadPending) return;
    this.rateLimitsReadPending = true;
    const id = ++this.nextId;
    this.setRequest<GetAccountRateLimitsResponse>(id, (message) => {
      this.rateLimitsReadPending = false;
      if (message.result?.rateLimits) {
        this.rateLimits = message.result.rateLimits;
        this.options.publishRendererState();
      }
    });
    this.send({
      method: "account/rateLimits/read",
      id,
      params: undefined,
    } satisfies AccountRateLimitsRequest);
  }

  /** Searches files below the requested roots for the renderer's picker. */
  fuzzyFileSearch(
    query: string,
    roots: string[],
  ): Promise<FuzzyFileSearchResult[]> {
    if (
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !roots.length
    ) {
      return Promise.resolve([]);
    }
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.setRequest<FuzzyFileSearchResponse>(id, (message) => {
        if (message.error) {
          this.options.debug("Fuzzy file search failed", message.error);
        } else {
          this.options.debug("Fuzzy file search completed", {
            query,
            roots,
            count: message.result?.files.length ?? 0,
          });
        }
        resolve(message.result?.files ?? []);
      });
      this.options.debug("Fuzzy file search requested", { query, roots });
      this.send({
        method: "fuzzyFileSearch",
        id,
        params: {
          query,
          roots,
          cancellationToken: null,
        },
      } satisfies FuzzyFileSearchRequest);
    });
  }

  /** Requests cancellation of the currently running turn. */
  interruptTurn(): boolean {
    const activeTurnId = this.threadRuntime().state.activeTurnId;
    if (
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.threadId ||
      !activeTurnId
    ) {
      return false;
    }
    const id = ++this.nextId;
    this.send({
      method: "turn/interrupt",
      id,
      params: {
        threadId: this.threadId,
        turnId: activeTurnId,
      },
    } satisfies TurnInterruptRequest);
    return true;
  }

  /** Starts an inline custom review on the selected thread. */
  startReview(instructions: string): boolean {
    const value = instructions.trim();
    if (
      !value ||
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.threadId ||
      this.threadRuntime().state.status !== "idle"
    ) {
      return false;
    }
    this.threadRuntime().beginReview();
    const threadId = this.threadId;
    if (!threadId) return false;
    const id = ++this.nextId;
    this.setRequest<ReviewStartResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        this.threadRuntime().setActiveTurn(message.result?.turn.id);
        if (message.error) {
          this.threadRuntime().completeTurn(false);
          this.options.publishRendererState();
        }
      });
    });
    this.send({
      method: "review/start",
      id,
      params: {
        threadId: this.threadId,
        delivery: "inline",
        target: { type: "custom", instructions: value },
      },
    } satisfies ReviewStartRequest);
    this.threadRuntime().setStatus("working");
    this.options.publishRendererState();
    return true;
  }

  /** Steers the active turn, falling back to queueing when its ID is stale. */
  steerPrompt(value: string): boolean {
    const prompt = value.trim();
    const activeTurnId = this.threadRuntime().state.activeTurnId;
    if (
      !prompt ||
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.threadId ||
      !activeTurnId ||
      (this.threadRuntime().state.status !== "working" &&
        this.threadRuntime().state.status !== "waiting")
    ) {
      return false;
    }
    const steerPrompt = `${STEER_INSTRUCTIONS}${prompt}`;
    this.threadRuntime().addUserMessage(steerPrompt);
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.threadRuntime().rememberPrompt(prompt);
    this.threadRuntime().rememberPrompt(steerPrompt);
    this.send({
      method: "turn/steer",
      id,
      params: {
        threadId: this.threadId,
        input: [{ type: "text", text: steerPrompt, text_elements: [] }],
        expectedTurnId: activeTurnId,
        clientUserMessageId: randomUUID(),
      },
    } satisfies TurnSteerRequest);
    return true;
  }

  /** Starts a turn while idle or persists a follow-up while a turn is active. */
  submitPrompt(value: string): boolean {
    if (!value.trim() || !this.initialized) {
      return false;
    }

    const prompt = value.trim();
    const modeCommand = prompt.match(/^\/(plan|default)$/i);
    if (modeCommand) {
      this.setCollaborationMode(
        modeCommand[1].toLowerCase() as "plan" | "default",
      );
      return true;
    }
    const newThreadMatch = prompt.match(/^\/new(?:\s+(.+))?$/);
    if (newThreadMatch) {
      return this.startNewThread(newThreadMatch[1]);
    }
    if (/^\/archive$/i.test(prompt)) {
      return this.archiveThread();
    }
    if (/^\/delete$/i.test(prompt)) {
      return this.deleteThread();
    }

    const shellCommand = prompt.match(/^!(.+)$/s)?.[1].trim();
    if (shellCommand) {
      return this.submitShellCommand(shellCommand);
    }
    const execCommand = prompt.match(/^\/exec\s+(.+)$/s)?.[1].trim();
    if (execCommand) {
      return this.submitExecCommand(execCommand);
    }

    if (this.threadRuntime().state.status !== "idle") {
      return this.queuePrompt(prompt);
    }

    this.threadRuntime().prepareTurn();
    this.threadRuntime().addUserMessage(prompt);
    this.options.publishRendererState();
    this.threadRuntime().rememberPrompt(prompt);
    const threadId = this.threadId;
    if (threadId) {
      this.startTurn(threadId, prompt);
      return true;
    }

    const id = ++this.nextId;
    this.options.debug("Pesk starting new Codex thread", {
      cwd: this.threadRuntime().state.workingDirectory ?? process.cwd(),
      reason: "first prompt",
    });
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: this.threadRuntime().snapshot().workingDirectory ?? ".",
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const thread = message.result?.thread;
      if (typeof thread?.id === "string") {
        const runtime = this.runtime(thread.id);
        const pendingHistory = this.standaloneThread.state.history;
        this.threadId = thread.id;
        runtime.reset(pendingHistory);
        this.withRuntime(thread.id, () => {
          this.noteThreadStartResponse(thread.id);
          this.updateModelInfo(message);
          runtime.setConnected(true);
          runtime.syncServerThread(thread);
          this.options.publishRendererState();
          this.startTurn(thread.id, prompt);
        });
      }
    });
    return true;
  }

  /** Archives the currently selected thread through the app server. */
  private archiveThread(): boolean {
    if (!this.threadId) return false;
    const threadId = this.threadId;
    const id = ++this.nextId;
    this.setRequest<ThreadArchiveResponse>(id, () => undefined);
    this.send({
      method: "thread/archive",
      id,
      params: { threadId },
    } satisfies ThreadArchiveRequest);
    return true;
  }

  /** Permanently deletes the currently selected thread through the app server. */
  private deleteThread(): boolean {
    if (!this.threadId) return false;
    const threadId = this.threadId;
    const id = ++this.nextId;
    this.setRequest<ThreadDeleteResponse>(id, () => undefined);
    this.send({
      method: "thread/delete",
      id,
      params: { threadId },
    } satisfies ThreadDeleteRequest);
    return true;
  }

  /** Runs a user-entered shell string through the current thread. */
  private submitShellCommand(command: string): boolean {
    if (!this.initialized) return false;
    const sendCommand = (threadId: string): void => {
      const id = ++this.nextId;
      this.send({
        method: "thread/shellCommand",
        id,
        params: { threadId, command },
      } satisfies ThreadShellCommandRequest);
      this.threadRuntime().setStatus("working");
      this.options.publishRendererState();
    };
    if (this.threadId) {
      this.threadRuntime().addUserMessage(`!${command}`);
      this.options.publishRendererState();
      sendCommand(this.threadId);
      return true;
    }
    if (this.threadRuntime().state.status !== "idle") return false;
    this.threadRuntime().addUserMessage(`!${command}`);
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: this.threadRuntime().snapshot().workingDirectory ?? ".",
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const thread = message.result?.thread;
      if (typeof thread?.id !== "string") return;
      this.noteThreadStartResponse(thread.id);
      this.threadId = thread.id;
      const runtime = this.runtime(thread.id);
      runtime.setConnected(true);
      runtime.syncServerThread(thread);
      this.options.publishRendererState();
      sendCommand(thread.id);
    });
    return true;
  }

  /** Runs a standalone argv command through the app-server sandbox. */
  private submitExecCommand(commandText: string): boolean {
    if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const command = commandText
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
    if (!command?.length) return false;
    const id = ++this.nextId;
    const processId = `pesk-exec-${id}`;
    const runtime = this.threadRuntime();
    const cwd = runtime.state.workingDirectory ?? process.cwd();
    this.execRuntimes.set(processId, runtime);
    runtime.addUserMessage(`/exec ${commandText}`);
    runtime.addActivity(
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
    this.setRequest<CommandExecResponse>(id, (message) => {
      const result = message.result;
      runtime.addActivity(
        {
          id: processId,
          type: "commandExecution",
          source: "unifiedExecStartup",
          userInitiated: true,
          command: command.join(" "),
          cwd,
          status: message.error
            ? "failed"
            : result?.exitCode === 0
              ? "completed"
              : "failed",
          exitCode: result?.exitCode,
          aggregatedOutput: [result?.stdout, result?.stderr]
            .filter(Boolean)
            .join("\n"),
        },
        processId,
      );
      this.execRuntimes.delete(processId);
      if (!runtime.state.activeTurnId) {
        runtime.setStatus("idle");
      }
      this.options.publishRendererState();
    });
    this.send({
      method: "command/exec",
      id,
      params: {
        command,
        processId,
        cwd,
      },
    } satisfies CommandExecRequest);
    runtime.setStatus("working");
    this.options.publishRendererState();
    return true;
  }
  /** Queues a follow-up prompt on the selected active thread. */
  private queuePrompt(prompt: string): boolean {
    if (
      !this.threadId ||
      this.socket?.readyState !== WebSocket.OPEN ||
      (this.threadRuntime().state.status !== "working" &&
        this.threadRuntime().state.status !== "waiting")
    )
      return false;
    const clientUserMessageId = randomUUID();
    const id = ++this.nextId;
    const threadId = this.threadId;
    this.setRequest<LocalQueueAddResponse>(id, (message) => {
      const submission = message.result?.queuedSubmission;
      if (!submission) return;
      this.withRuntime(threadId, () => {
        this.runtime(threadId).resolveQueuedSubmission(clientUserMessageId, {
          id: submission.id,
          text: prompt,
          clientUserMessageId,
        });
        this.options.publishRendererState();
      });
    });
    this.send({
      method: "thread/queue/add",
      id,
      params: {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        clientUserMessageId,
      },
    });
    this.runtime(threadId).queuePending({
      id: `pending-${clientUserMessageId}`,
      text: prompt,
      clientUserMessageId,
    });
    this.options.publishRendererState();
    return true;
  }

  /** Requests the first page of the queue for one thread. */
  private refreshQueue(threadId: string): void {
    if (!this.initialized || this.socket?.readyState !== WebSocket.OPEN) return;
    const id = ++this.nextId;
    this.setRequest<LocalQueueListResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        this.runtime(threadId).replaceQueueFromServer(
          message.result?.data ?? [],
        );
        this.options.publishRendererState();
        if (message.result?.nextCursor) {
          this.refreshQueuePage(threadId, message.result.nextCursor);
        }
      });
    });
    this.send({
      method: "thread/queue/list",
      id,
      params: { threadId, limit: 100 },
    });
  }

  /** Requests a subsequent queue page for one thread. */
  private refreshQueuePage(threadId: string, cursor: string): void {
    const id = ++this.nextId;
    this.setRequest<LocalQueueListResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        this.runtime(threadId).appendQueueFromServer(
          message.result?.data ?? [],
        );
        this.options.publishRendererState();
        if (message.result?.nextCursor)
          this.refreshQueuePage(threadId, message.result.nextCursor);
      });
    });
    this.send({
      method: "thread/queue/list",
      id,
      params: { threadId, cursor, limit: 100 },
    });
  }

  /** Starts and selects a fresh Codex session without sending a prompt. */
  startNewThread(workingDirectory?: string, initialPrompt?: string): boolean {
    if (!this.initialized) {
      return false;
    }
    const cwd = (
      workingDirectory ??
      this.threadRuntime().state.workingDirectory ??
      process.cwd()
    ).trim();
    if (!cwd) {
      return false;
    }
    this.startingNewThread = true;
    this.threadRuntime().setTokenUsage(undefined);
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.options.debug("Pesk starting new Codex thread", {
      cwd,
      reason: "new command",
    });
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd,
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);

    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const thread = message.result?.thread;
      if (typeof thread?.id !== "string") {
        this.startingNewThread = false;
        return;
      }
      this.startingNewThread = false;
      this.noteThreadStartResponse(thread.id);
      this.threadId = thread.id;
      const runtime = this.runtime(thread.id);
      runtime.reset([], cwd);
      runtime.setConnected(true);
      runtime.syncServerThread(thread);
      this.updateModelInfo(message);
      this.threads = [
        thread,
        ...this.threads.filter((candidate) => candidate.id !== thread.id),
      ];
      this.options.publishRendererState();
      if (initialPrompt) {
        runtime.addUserMessage(initialPrompt);
        this.options.publishRendererState();
        this.threadRuntime().rememberPrompt(initialPrompt);
        this.startTurn(thread.id, initialPrompt);
      }
    });
    return true;
  }

  /** Sends an approval response for an app-server request. */
  respondPermission(requestId: RequestId, optionId: string): void {
    const key = requestIdKey(requestId);
    const runtime = this.threadRuntime();
    const pending = runtime.state.pendingApprovals.get(key);
    const decision = pending?.decisions.get(optionId);
    if (!pending || decision === undefined) return;
    this.send({
      id: requestId,
      result: {
        decision,
      },
    } satisfies JsonRpcResponse<PermissionApprovalResponse>);
    const resolution = runtime.resolveApprovalSelection(key, optionId);
    if (!resolution) return;
    this.clearAttention(runtime.id);
    this.options.publishRendererState();
    if (!resolution.hasPending) {
      this.options.clearNotification?.();
    }
    runtime.setStatus("working");
    this.options.publishRendererState();
    this.routeNextAttention();
  }

  /** Sends one newline-delimited JSON-RPC message to the app server. */
  private send(message: OutgoingMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(`${JSON.stringify(message)}\n`);
    }
  }
  /** Registers a response callback with the expected generated result type. */
  private setRequest<TResult>(
    id: number,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): void {
    this.requests.set(id, (message) => {
      callback(message as JsonRpcResponse<TResult>);
    });
  }

  /** Opens the socket and wires protocol, close, and error events. */
  private connect(): void {
    if (this.stopped) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const socket = new WebSocket(this.url);
      this.requests.clear();
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.socket !== socket) return;
        this.connectionError = undefined;
        this.options.publishRendererState();
        const id = ++this.nextId;
        this.setRequest<InitializeResponse>(id, () => {
          if (this.socket !== socket) return;
          this.send({
            method: "initialized",
          } satisfies ClientNotification);
          this.initialized = true;
          this.threadRuntime().resetTransportState();
          this.threadId = undefined;
          this.pendingThreadResumeId = undefined;
          this.options.publishRendererState();
          this.discover();
        });
        this.send({
          method: "initialize",
          id,
          params: {
            clientInfo: {
              name: "pesk",
              title: "Pesk",
              version: "0.1.0",
            },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
            },
          },
        } satisfies InitializeRequest);
      });
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (isRecord(value)) {
            this.handle(value as IncomingMessage);
          }
        } catch (error) {
          this.options.debug("Invalid Codex message", error);
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.handleSocketClose(event);
      });
      socket.addEventListener("error", (error) => {
        if (this.socket !== socket) return;
        const details = describeSocketError(error, this.url);
        if (this.connectionError === details) {
          return;
        }
        this.connectionError = details;
        this.options.debug("Codex socket error", details);
        this.options.publishRendererState();
      });
      return;
    } catch (error) {
      this.options.debug("Codex connection failed", error);
      if (!this.stopped) this.scheduleReconnect();
      return;
    }
  }

  /** Clears transport state after a socket closes and schedules reconnection. */
  private handleSocketClose(event: unknown): void {
    const closeEvent = event as {
      code?: unknown;
      reason?: unknown;
      wasClean?: unknown;
    };
    this.options.debug("Codex socket closed", {
      url: this.url,
      code: closeEvent.code,
      reason: closeEvent.reason,
      wasClean: closeEvent.wasClean,
    });
    const selectedRuntime = this.threadId
      ? this.runtime(this.threadId)
      : this.standaloneThread;
    if (this.threadId) {
      this.standaloneThread.replaceHistory(selectedRuntime.state.history);
    }
    this.socket = null;
    this.initialized = false;
    this.requests.clear();
    this.discoveryPending = false;
    this.rateLimitsReadPending = false;
    selectedRuntime.resetTransportState();
    this.threadId = undefined;
    this.threads = [];
    this.pendingThreadStarts = 0;
    this.pendingThreadResumeId = undefined;
    this.locallyStartedThreads.clear();
    this.threadControllers.clear();
    this.standaloneThread.resetTransportState();
    selectedRuntime.setStatus("idle");
    this.options.publishRendererState();
    if (!this.stopped) this.scheduleReconnect();
  }

  /** Finds the most recent Codex session after initialization. */
  private discover(): void {
    if (!this.initialized || this.discoveryPending) {
      return;
    }
    this.discoveryPending = true;
    const choose = (id: string): void => {
      this.discoveryPending = false;
      this.switchThread(id);
    };
    const id = ++this.nextId;
    this.setRequest<ThreadListResponse>(id, (message) => {
      const threads = (message.result?.data ?? []).filter(isThread);
      this.threads = threads;
      for (const thread of threads) {
        const runtime = this.runtime(thread.id);
        runtime.syncServerThread(thread);
        runtime.applyServerStatus(thread.status ?? {});
      }
      if (!threads.length) {
        this.threadId = undefined;
        this.standaloneThread.clearConversation();
      }
      this.options.publishRendererState();
      const firstSession = threads[0];
      if (firstSession) {
        choose(firstSession.id);
      }
    });
    this.send({
      method: "thread/list",
      id,
      params: {
        limit: 10,
        sortKey: "recency_at",
        sortDirection: "desc",
      },
    } satisfies ThreadListRequest);
  }

  /** Replaces the selected session and optionally resumes it. */
  private switchThread(
    id: string,
    resume = true,
    preserveHistory = false,
  ): void {
    if (
      !id ||
      (this.threads.length > 0 &&
        !this.threads.some((thread) => thread.id === id))
    ) {
      return;
    }
    if (this.threadId === id) {
      if (resume && !this.threadRuntime().state.connected) {
        this.resume(id);
      }
      this.options.publishRendererState();
      return;
    }
    const pendingHistory = preserveHistory
      ? this.threadRuntime().state.history
      : undefined;
    this.threadId = id;
    const existing = this.threadControllers.has(id);
    if (!existing) {
      this.runtime(id).reset(preserveHistory ? (pendingHistory ?? []) : []);
    }
    this.options.publishRendererState();
    if (resume) {
      this.resume(id);
    }
  }

  /** Tracks the response/notification pair for a locally created thread. */
  private noteThreadStartResponse(threadId: string): void {
    if (this.locallyStartedThreads.delete(threadId)) {
      return;
    }
    this.pendingThreadStarts = Math.max(0, this.pendingThreadStarts - 1);
    this.locallyStartedThreads.add(threadId);
  }

  /** Returns whether a thread/started notification belongs to local start. */
  private consumeLocalThreadStarted(threadId: string): boolean {
    if (this.locallyStartedThreads.delete(threadId)) {
      return true;
    }
    if (this.pendingThreadStarts > 0) {
      this.pendingThreadStarts -= 1;
      this.locallyStartedThreads.add(threadId);
      return true;
    }
    return false;
  }

  /** Resumes a thread after the app server has announced it is active. */
  private resume(threadId: string): void {
    if (!this.initialized) {
      return;
    }
    const id = ++this.nextId;
    this.setRequest<ThreadResumeResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        if (!message.error) {
          this.readonlyThreadIds.delete(threadId);
          this.updateModelInfo(message);
          this.read(threadId);
          return;
        }
        const text =
          typeof (message.error as Record<string, unknown>).message === "string"
            ? ((message.error as Record<string, unknown>).message as string)
            : "";
        if (text.includes("already has an active writer")) {
          this.readonlyThreadIds.add(threadId);
          this.options.publishRendererState();
          this.read(threadId);
        }
      });
    });
    this.send({
      method: "thread/resume",
      id,
      params: {
        threadId,
      },
    } satisfies ThreadResumeRequest);
  }

  /** Reads persisted turns and converts them into renderer messages. */
  private read(threadId: string): void {
    const id = ++this.nextId;
    this.setRequest<ThreadReadResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        const thread = message.result?.thread;
        if (isThread(thread)) {
          this.threads = [
            thread,
            ...this.threads.filter((candidate) => candidate.id !== thread.id),
          ];
        }
        this.threadRuntime().syncServerThread(thread);
        this.threadRuntime().setConnected(true);
        this.threadRuntime().applyServerStatus(thread?.status ?? {});
        this.options.publishRendererState();
        setTimeout(() => this.refreshQueue(threadId), 0);
        const turns = records(thread?.turns);
        this.threadRuntime().restoreTurns(turns);
        this.options.publishRendererState();
      });
    });
    this.send({
      method: "thread/read",
      id,
      params: {
        threadId,
        includeTurns: true,
      },
    } satisfies ThreadReadRequest);
  }

  /** Dispatches JSON-RPC responses and app-server notifications. */
  private handle(message: IncomingMessage): void {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    this.handleServerMessage(message as ServerMessage);
  }

  /** Resolves and invokes a callback waiting for a JSON-RPC response. */
  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") return;
    const callback = this.requests.get(message.id);
    if (callback) {
      this.requests.delete(message.id);
      callback(message);
    }
  }

  /** Routes a thread-scoped event into the owning runtime. */
  private handleServerMessage(message: ServerMessage): void {
    const threadId = messageThreadId(message);
    if (threadId && message.method !== "thread/started") {
      const previousSelectedThread = this.threadId;
      const wasBackgroundThread = previousSelectedThread !== threadId;
      const runtime = this.runtime(threadId);
      const previousStatus = runtime.state.status;
      this.withRuntime(threadId, () =>
        this.handleServerMessageInternal(message),
      );
      const nextStatus = runtime.state.status;
      if (nextStatus !== previousStatus) {
        this.options.debug("Pesk thread status transition", {
          threadId,
          event: message.method,
          previousStatus,
          nextStatus,
          activeFlags:
            message.method === "thread/status/changed"
              ? message.params.status?.type === "active"
                ? message.params.status.activeFlags
                : undefined
              : undefined,
        });
      }
      if (wasBackgroundThread && message.method === "turn/completed") {
        if (!this.options.isChatVisible()) this.switchThread(threadId, false);
      }
      if (message.method === "turn/completed") {
        this.options.handleNotification({
          event: "turnCompleted",
          threadId,
          selectedThreadId: previousSelectedThread,
        });
      } else if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        this.options.handleNotification({
          event: "approvalRequested",
          threadId,
          selectedThreadId: previousSelectedThread,
          requestId: message.id,
        });
      } else if (message.method === "item/tool/requestUserInput") {
        this.options.handleNotification({
          event: "userInputRequested",
          threadId,
          selectedThreadId: previousSelectedThread,
        });
      }
      this.options.publishRendererState();
      return;
    }
    this.handleServerMessageInternal(message);
  }

  /** Routes an app-server notification or request to its protocol handler. */
  private handleServerMessageInternal(message: ServerMessage): void {
    const method = message.method;
    if (!method.startsWith("item")) {
      this.options.debug(message);
    }

    switch (method) {
      case "thread/started":
        this.handleThreadStarted(message);
        break;
      case "thread/queue/changed":
        this.refreshQueue(message.params.threadId);
        break;
      case "thread/archived":
        this.handleThreadRemoved(message.params.threadId);
        break;
      case "thread/deleted":
        this.handleThreadRemoved(message.params.threadId);
        break;
      case "turn/started":
        this.handleTurnStarted(message);
        break;
      case "item/started":
        this.handleItemStarted(message);
        break;
      case "turn/completed":
        this.handleTurnCompleted(message);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(message);
        break;
      case "account/rateLimits/updated":
        this.rateLimits = message.params.rateLimits;
        this.options.publishRendererState();
        break;
      case "model/rerouted":
        this.handleModelRerouted(message);
        break;
      case "thread/settings/updated":
        this.handleThreadSettingsUpdated(message);
        break;
      case "thread/status/changed":
        this.handleThreadStatusChanged(message);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(message);
        break;
      case "item/plan/delta":
        this.threadRuntime().appendPlanDelta(
          message.params.itemId,
          message.params.delta,
        );
        this.options.publishRendererState();
        break;
      case "item/commandExecution/outputDelta":
        this.handleCommandOutputDelta(message);
        break;
      case "command/exec/outputDelta":
        this.handleExecOutputDelta(message);
        break;
      case "item/completed":
        this.handleItemCompleted(message);
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.handleApprovalRequest(message);
        break;
      case "item/tool/requestUserInput":
        this.handleUserInputRequest(message);
        break;
      case "serverRequest/resolved":
        if (
          this.threadRuntime().state.pendingUserInput?.requestId ===
          message.params.requestId
        ) {
          const threadId =
            this.threadRuntime().state.pendingUserInput?.threadId;
          this.threadRuntime().clearUserInput();
          if (threadId) {
            this.clearAttention(threadId);
            this.routeNextAttention();
          }
          this.options.publishRendererState();
        }
        break;
    }
  }

  /** Removes archived/deleted threads from local state and selects a survivor. */
  private handleThreadRemoved(threadId: string): void {
    this.threads = this.threads.filter((thread) => thread.id !== threadId);
    this.threadControllers.delete(threadId);
    this.readonlyThreadIds.delete(threadId);
    this.attentionQueue.delete(threadId);
    if (this.threadId !== threadId) {
      this.options.publishRendererState();
      return;
    }
    const nextThread = this.threads[0];
    this.threadId = undefined;
    this.standaloneThread.clearConversation();
    if (nextThread) this.switchThread(nextThread.id);
    this.options.publishRendererState();
  }

  /** Selects and initializes a thread announced by the app server. */
  private handleThreadStarted(
    message: Extract<ServerMessage, { method: "thread/started" }>,
  ): void {
    const { thread } = message.params;
    this.threads = [
      thread,
      ...this.threads.filter((candidate) => candidate.id !== thread.id),
    ];
    const locallyStarted = this.consumeLocalThreadStarted(thread.id);
    // Real thread/started payloads always include status. Incomplete legacy
    // payloads are treated as a local announcement for compatibility.
    const shouldSelect =
      locallyStarted || this.threadId === undefined || !thread.status;
    if (!shouldSelect) {
      const runtime = this.runtime(thread.id);
      runtime.syncServerThread(thread);
      runtime.applyServerStatus(thread.status ?? {});
      this.options.publishRendererState();
      return;
    }
    this.pendingThreadResumeId = locallyStarted ? undefined : thread.id;
    const preservePendingPrompt =
      this.threadId === undefined &&
      this.threadRuntime().state.history.some((item) => item.role === "user");
    this.switchThread(thread.id, false, preservePendingPrompt);
    const runtime = this.runtime(thread.id);
    runtime.syncServerThread(thread);
    runtime.applyServerStatus(thread.status ?? {});
    this.options.publishRendererState();
  }

  /** Tracks the active turn and associates it with the latest user message. */
  private handleTurnStarted(
    message: Extract<ServerMessage, { method: "turn/started" }>,
  ): void {
    const turnId = message.params.turn.id;
    if (typeof message.params.threadId !== "string") {
      this.threadRuntime().setActiveTurn(turnId);
      this.threadRuntime().ensureWorking();
      this.threadRuntime().setStatus("working");
      this.options.publishRendererState();
      return;
    }
    const runtime = this.runtime(message.params.threadId);
    runtime.startTurn(turnId);
    this.options.publishRendererState();
  }

  /** Adds echoed user input and visible activity from a started item. */
  private handleItemStarted(
    message: Extract<ServerMessage, { method: "item/started" }>,
  ): void {
    this.threadRuntime().setStatus("working");
    this.options.publishRendererState();
    const item = isRecord(message.params.item)
      ? (message.params.item as Record<string, unknown>)
      : undefined;
    if (item) {
      this.threadRuntime().processStartedItem(
        item,
        message.params.turnId,
        this.threadRuntime().state.reviewInProgress &&
          item.type === "userMessage",
      );
    }
  }

  /** Finalizes turn state and records token usage from a completed turn. */
  private handleTurnCompleted(
    message: Extract<ServerMessage, { method: "turn/completed" }>,
  ): void {
    if (typeof message.params.threadId !== "string") {
      this.threadRuntime().completeTurn(
        message.params.turn?.status === "interrupted",
      );
      this.threadRuntime().setStatus("idle");
      this.options.publishRendererState();
      const legacyTurn = isRecord(message.params.turn)
        ? (message.params.turn as Record<string, unknown>)
        : undefined;
      const legacyUsage = parseTokenUsageValue(
        legacyTurn?.tokenUsage ?? legacyTurn?.usage,
      );
      if (legacyUsage) this.threadRuntime().setTokenUsage(legacyUsage);
      return;
    }
    const runtime = this.runtime(message.params.threadId);
    runtime.clearUserInput();
    this.clearAttention(message.params.threadId);
    runtime.completeTurn(message.params.turn?.status === "interrupted");
    this.refreshQueue(message.params.threadId);
    this.options.publishRendererState();
    const turn = isRecord(message.params.turn)
      ? (message.params.turn as Record<string, unknown>)
      : undefined;
    const usage = parseTokenUsageValue(turn?.tokenUsage ?? turn?.usage);
    if (usage && !this.startingNewThread) {
      this.threadRuntime().setTokenUsage(usage);
      this.options.debug("Pesk Codex token usage", {
        source: "turn/completed",
        usage,
      });
      this.options.publishRendererState();
    }
  }

  /** Updates the selected thread's token usage from a live notification. */
  private handleTokenUsageUpdated(
    message: Extract<ServerMessage, { method: "thread/tokenUsage/updated" }>,
  ): void {
    const { threadId, turnId, tokenUsage } = message.params;
    const usage = parseTokenUsageValue(tokenUsage);
    if (usage && !this.startingNewThread) {
      this.threadRuntime().setTokenUsage(usage);
      this.options.debug("Pesk Codex token usage", {
        source: "thread/tokenUsage/updated",
        threadId,
        turnId,
        usage,
      });
      this.options.publishRendererState();
    }
  }

  /** Stores the model selected after an app-server reroute. */
  private handleModelRerouted(
    message: Extract<ServerMessage, { method: "model/rerouted" }>,
  ): void {
    this.threadRuntime().mergeModelInfo({ model: message.params.toModel });
    this.options.publishRendererState();
  }

  /** Updates model metadata when thread settings change. */
  private handleThreadSettingsUpdated(
    message: Extract<ServerMessage, { method: "thread/settings/updated" }>,
  ): void {
    const mode = message.params.threadSettings.collaborationMode?.mode;
    if (mode === "plan" || mode === "default") {
      this.threadRuntime().setCollaborationMode(mode);
    }
    if (isRecord(message.params.threadSettings)) {
      this.updateModelInfoFromValue(message.params.threadSettings);
    }
    this.options.publishRendererState();
  }

  /** Applies thread lifecycle changes and performs resume/reconcile work. */
  private handleThreadStatusChanged(
    message: Extract<ServerMessage, { method: "thread/status/changed" }>,
  ): void {
    const { threadId, status } = message.params;
    const isSelected = threadId === this.threadId;
    const previous = this.threadRuntime().state.status;
    this.threadRuntime().applyServerStatus(status ?? {});
    this.options.publishRendererState();
    if (
      isSelected &&
      shouldReconcileOnIdle(
        previous,
        status,
        this.threadRuntime().state.needsReconcile,
      )
    ) {
      this.threadRuntime().markNeedsReconcile(false);
      this.read(threadId);
    }
    if (!isSelected) return;
    if (status?.type === "active" && this.pendingThreadResumeId === threadId) {
      this.pendingThreadResumeId = undefined;
      this.resume(threadId);
    } else if (
      shouldResumeOnActiveStatus(this.threadRuntime().state.connected, status)
    ) {
      this.resume(threadId);
    }
  }

  /** Appends streamed assistant text to the conversation. */
  private handleAgentMessageDelta(
    message: Extract<ServerMessage, { method: "item/agentMessage/delta" }>,
  ): void {
    if (typeof message.params.threadId !== "string") {
      this.threadRuntime().appendAssistantDelta(
        message.params.delta,
        message.params.itemId,
        message.params.turnId,
      );
      this.options.publishRendererState();
      return;
    }
    const runtime = this.runtime(message.params.threadId);
    runtime.appendAssistantDelta(
      message.params.delta,
      message.params.itemId,
      message.params.turnId,
    );
    this.options.publishRendererState();
  }

  /** Appends streamed command output to its activity message. */
  private handleCommandOutputDelta(
    message: Extract<
      ServerMessage,
      { method: "item/commandExecution/outputDelta" }
    >,
  ): void {
    if (this.threadId || this.routedThreadId) {
      this.threadRuntime().appendActivityOutput(
        message.params.itemId,
        message.params.delta,
      );
      this.options.publishRendererState();
    }
  }

  /** Stores a server request_user_input request for the renderer. */
  private handleUserInputRequest(
    message: Extract<ServerMessage, { method: "item/tool/requestUserInput" }>,
  ): void {
    const pending = {
      requestId: message.id,
      threadId: message.params.threadId,
      turnId: message.params.turnId,
      itemId: message.params.itemId,
      questions: message.params.questions,
      isBlocking: message.params.isBlocking,
    };
    this.threadRuntime().setUserInput(pending);
    this.threadRuntime().setStatus("waiting");
    this.noteAttention(pending.threadId, "userInput");
    this.routeAttention(pending.threadId);
    if (!messageThreadId(message)) {
      this.options.handleNotification({
        event: "userInputRequested",
        threadId: pending.threadId,
        selectedThreadId: this.threadId,
      });
    }
    this.options.publishRendererState();
  }

  /** Commits a completed assistant or activity item to conversation history. */
  private handleItemCompleted(
    message: Extract<ServerMessage, { method: "item/completed" }>,
  ): void {
    const item = isRecord(message.params.item)
      ? message.params.item
      : undefined;
    if (item) this.threadRuntime().processCompletedItem(item);
    this.options.publishRendererState();
  }

  /** Displays a pending approval and changes the controller to waiting status. */
  private handleApprovalRequest(
    message: Extract<
      ServerMessage,
      {
        method:
          | "item/commandExecution/requestApproval"
          | "item/fileChange/requestApproval";
      }
    >,
  ): void {
    const id = message.id;
    const decisions = approvalDecisions(message);
    const command =
      "command" in message.params ? (message.params.command ?? "") : "";
    const reason = message.params.reason ?? "";
    const approval = {
      requestId: id,
      command,
      reason,
      decisions,
    };
    const displayed = {
      requestId: id,
      command,
      reason,
      options: approvalOptions(decisions),
    };
    this.threadRuntime().addApproval(requestIdKey(id), approval, displayed);
    this.noteAttention(message.params.threadId, "approval");
    this.routeAttention(message.params.threadId);
    if (!messageThreadId(message)) {
      this.options.handleNotification({
        event: "approvalRequested",
        threadId: message.params.threadId,
        selectedThreadId: this.threadId,
        requestId: id,
        command,
        reason,
      });
    }
    this.threadRuntime().setStatus("waiting");
    this.options.publishRendererState();
  }

  private noteAttention(
    threadId: string,
    type: "approval" | "userInput",
  ): void {
    if (!this.attentionQueue.has(threadId))
      this.attentionQueue.set(threadId, type);
  }

  private routeAttention(threadId: string): void {
    const nextThreadId = this.attentionQueue.keys().next().value;
    if (typeof nextThreadId !== "string" || this.threadId === nextThreadId)
      return;
    this.switchThread(nextThreadId, false);
  }

  private clearAttention(threadId: string): void {
    const runtime = this.runtime(threadId);
    if (!runtime.state.pendingApproval && !runtime.state.pendingUserInput) {
      this.attentionQueue.delete(threadId);
    }
  }

  private routeNextAttention(): void {
    const nextThreadId = this.attentionQueue.keys().next().value;
    if (typeof nextThreadId === "string") this.routeAttention(nextThreadId);
  }

  /** Starts a text turn and creates a temporary working message. */
  private startTurn(threadId: string, prompt: string): void {
    const runtime = this.runtime(threadId);
    runtime.prepareTurn();
    const id = ++this.nextId;
    this.setRequest<TurnStartResponse>(id, (message) => {
      this.withRuntime(threadId, () => {
        runtime.setActiveTurn(message.result?.turn.id);
        if (message.error) {
          this.threadRuntime().setStatus("idle");
          this.options.publishRendererState();
        }
      });
    });
    const params: PlanTurnStartParams = {
      threadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
    };
    params.collaborationMode = {
      mode: runtime.state.collaborationMode,
      settings: {
        model: runtime.state.modelInfo?.model ?? "gpt-5.1-codex",
        reasoning_effort:
          runtime.state.collaborationMode === "plan" ? "medium" : null,
        developer_instructions: null,
      },
    };
    this.send({
      method: "turn/start",
      id,
      params,
    } satisfies TurnStartRequest);
    this.withRuntime(threadId, () => {
      runtime.setStatus("working");
      this.options.publishRendererState();
    });
  }

  /** Appends base64-decoded output from a standalone command/exec request. */
  private handleExecOutputDelta(
    message: Extract<ServerMessage, { method: "command/exec/outputDelta" }>,
  ): void {
    const delta = Buffer.from(message.params.deltaBase64, "base64").toString();
    const runtime = this.execRuntimes.get(message.params.processId);
    if (runtime) {
      runtime.appendActivityOutput(message.params.processId, delta);
      this.options.publishRendererState();
    }
  }

  /** Extracts model metadata from a typed JSON-RPC response. */
  private updateModelInfo<TResult>(message: JsonRpcResponse<TResult>): void {
    const result = isRecord(message.result) ? message.result : undefined;
    if (!result) return;
    this.updateModelInfoFromValue(result);
    if (result.thread && typeof result.thread === "object") {
      this.updateModelInfoFromValue(result.thread as Record<string, unknown>);
    }
  }

  /** Merges model metadata from an untyped protocol value into controller state. */
  private updateModelInfoFromValue(value: Record<string, unknown>): void {
    if (this.threadRuntime().mergeModelInfoFromServer(value)) {
      this.options.publishRendererState();
    }
  }

  /** Schedules one delayed reconnect after socket failure. */
  private scheduleReconnect(): void {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 3000);
    }
  }
}
