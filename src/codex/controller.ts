import type {
  ClientNotification,
  InitializeResponse,
  RequestId,
  FuzzyFileSearchResponse,
  FuzzyFileSearchResult,
} from "../codex-schema";
import {
  approvalDecisions,
  isRecord,
  messageThreadId,
  requestIdKey,
  stringValue,
} from "./protocol";

import type {
  JsonRpcResponse,
  OutgoingRequestInput,
  PermissionApprovalResponse,
  ServerMessage,
} from "./protocol";
import { CodexWebSocketTransport, type CodexSocketTransport } from "./websocket";
import { CodexThread, parseTokenUsageValue, approvalOptions } from "./thread";
import { CodexThreadManager } from "./thread-manager";
import { randomUUID } from "node:crypto";
import { CodexProjectManager, type ProjectRequestInput } from "./projects";
import type {
  TurnStartResponse,
  ReviewStartResponse,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  CommandExecResponse,
} from "../codex-schema/v2";
import type { UserInput } from "../codex-schema/v2/UserInput";
import type { CodexState, CodexStreamDelta } from "./types";
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
  ThreadShellCommandRequest,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnSteerRequest,
} from "./protocol";
import { CodexModelManager } from "./model";
import { CodexGoalManager } from "./goal";
import { CodexThreadLifecycle } from "./thread-lifecycle";

const STEER_INSTRUCTIONS = `Treat this message as a steer to the currently active request.

Preserve all existing requirements, constraints, entities, and output formats unless this steer explicitly changes, removes, cancels, or replaces them. Apply only the requested change and continue the complete updated request.

If the steer is materially ambiguous, ask one concise clarifying question. Otherwise, use the most natural interpretation and proceed.

Steer message:
`;
const HISTORY_PAGE_LIMIT = 5;

export interface CodexControllerOptions {
  onStateChanged: (state: CodexState) => void;
  onStreamDelta?: (delta: CodexStreamDelta) => void;
  onAttention: (event: CodexAttentionEvent) => void;
  onAttentionCleared?: () => void;
  debug: (...values: unknown[]) => void;
}

export interface CodexAttentionEvent {
  event: "turnCompleted" | "approvalRequested" | "userInputRequested";
  threadId: string;
  selectedThreadId?: string;
  requestId?: string | number;
  command?: string;
  reason?: string;
}

/**
 * Owns the Codex app-server connection and translates protocol events into
 * application-friendly conversation and status state. UI and window effects
 * are owned by the application layer consuming these callbacks.
 */
export class CodexController {
  private readonly socket: CodexSocketTransport;
  /** Human-readable transport error exposed through the Codex state. */
  private connectionError: string | undefined;
  /** Server-owned project operations and collection, separate from thread selection. */
  private readonly projectManager: CodexProjectManager;
  /** True while /new is replacing the selected thread. */
  private startingNewThread = false;
  /** Latest account-wide ChatGPT rate-limit snapshot. */
  private rateLimits: RateLimitSnapshot | undefined;
  /** Prevents duplicate initial rate-limit reads from concurrent callers. */
  private rateLimitsReadPending = false;
  /** Whether initialize/initialized completed on the current socket. */
  private initialized = false;
  /** Monotonic JSON-RPC request id for this controller instance. */
  private nextId = 0;
  /** Prevents duplicate thread discovery requests. */
  /** Per-thread instances and lifecycle bookkeeping. */
  private readonly threadManager = new CodexThreadManager();
  private readonly modelManager: CodexModelManager;
  private readonly goalManager: CodexGoalManager;
  private readonly lifecycle: CodexThreadLifecycle;
  private readonly options: CodexControllerOptions;

  /** Creates a controller with application-level event callbacks. */
  constructor(
    options: CodexControllerOptions,
    socket: CodexSocketTransport = new CodexWebSocketTransport(),
  ) {
    this.options = options;
    this.socket = socket;
    this.projectManager = new CodexProjectManager({
      request: (request) => this.requestProject(request),
      publishRendererState: () => this.notifyStateChanged(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
      setConnectionError: (error) => {
        this.connectionError = error;
      },
    });
    this.modelManager = new CodexModelManager({
      request: (request, callback) => this.request(request, callback),
      getSelectedThreadId: () => this.threadManager.selectedThreadId,
      publishRendererState: () => this.notifyStateChanged(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
    });
    this.goalManager = new CodexGoalManager({
      request: (request, callback) => this.request(request, callback),
      setGoal: (threadId, goal) =>
        this.threadManager.withThread(threadId, (targetThread) => targetThread.setGoal(goal)),
      publishRendererState: () => this.notifyStateChanged(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
      setConnectionError: (error) => {
        this.connectionError = error;
      },
      setCollaborationMode: (mode) => this.setCollaborationMode(mode),
    });
    this.lifecycle = new CodexThreadLifecycle({
      threadManager: this.threadManager,
      projectManager: this.projectManager,
      request: (message, callback) => this.request(message, callback),
      publishRendererState: () => this.notifyStateChanged(),
      onThreadHydrated: (threadId) => {
        this.refreshQueue(threadId);
        this.goalManager.restore(threadId);
      },
      cancelModelPicker: () => this.modelManager.cancel(),
      setStarting: (value) => {
        this.startingNewThread = value;
      },
      startTurn: (threadId, prompt) => this.startTurn(threadId, prompt),
    });
    this.socket
      .on("open", () => this.handleSocketOpen())
      .on("message", (message) => this.handleServerMessage(message))
      .on("close", (event) => this.handleSocketClose(event))
      .on("error", (details) => this.handleSocketError(details))
      .on("debug", (values) => this.options.debug(...values));
  }

  private notifyStateChanged(): void {
    if (!this.threadManager.isPublicationSuppressed) this.options.onStateChanged(this.getState());
  }

  private notifyAttention(event: CodexAttentionEvent): void {
    if (!this.threadManager.isPublicationSuppressed) this.options.onAttention(event);
  }

  /** Returns the current Codex state snapshot for application consumers. */
  getState(): CodexState {
    const thread = this.threadManager.activeThread.snapshot();
    const pagination = this.threadManager.selectedHistoryState();
    const threadActivities = this.threadManager.getThreadActivities();
    const backgroundWork = this.threadManager.backgroundWorkSnapshot();
    const aggregateStatus: CodexState["status"] = threadActivities.some(
      (activity) => activity.status === "waiting",
    )
      ? "waiting"
      : threadActivities.some((activity) => activity.status === "working")
        ? "working"
        : "idle";
    return {
      threadId: this.threadManager.selectedThreadId,
      projectId: thread.projectId,
      readOnly: this.threadManager.selectedIsReadOnly(),
      cwd: thread.workingDirectory ?? process.cwd(),
      error: this.connectionError,
      commandNotice: thread.commandNotice,
      status: thread.status,
      aggregateStatus,
      connected: thread.connected,
      history: thread.history,
      threads: this.threadManager.threads,
      projects: this.projectManager.getProjects(),
      threadActivities,
      backgroundWork,
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
      goal: thread.goal,
      modelPicker: this.modelManager.getPicker(),
      hasOlderHistory: pagination?.hasOlderHistory ?? false,
      historyLoading: Boolean(pagination?.loading || this.threadManager.selectedHistoryIsLoading()),
    };
  }

  /** Loads the next older persisted history page for the selected thread. */
  loadOlderHistory(): Promise<boolean> {
    return this.lifecycle.loadOlderHistory();
  }

  start(): void {
    this.socket.start();
  }

  stop(): void {
    this.socket.stop();
  }

  private isOpen(): boolean {
    return this.socket.isOpen();
  }

  private send(message: OutgoingMessage): void {
    this.socket.send(message);
  }

  private setRequest<TResult>(
    id: number,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): void {
    this.socket.setRequest(id, callback);
  }

  private requestProject<TResult>(
    request: ProjectRequestInput,
  ): Promise<JsonRpcResponse<TResult> | undefined> {
    if (!this.initialized) return Promise.resolve(undefined);
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.setRequest<TResult>(id, resolve);
      this.send({ ...request, id } as never);
    });
  }

  private request<TResult>(
    request: OutgoingRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): boolean {
    if (!this.initialized || !this.isOpen()) return false;
    const id = ++this.nextId;
    this.setRequest<TResult>(id, callback);
    this.send({ ...request, id } as never);
    return true;
  }

  /** Selects a known Codex thread and resumes it. */
  selectThread(id: string, focus = true): void {
    this.lifecycle.select(id, focus);
  }

  /** Selects the next queued attention thread when the application allows it. */
  selectNextAttentionThread(): boolean {
    const threadId = this.threadManager.nextAttention();
    if (typeof threadId !== "string" || this.threadManager.isSelected(threadId)) return false;
    this.lifecycle.select(threadId, false);
    return true;
  }

  /** Lists authoritative projects, optionally appending a server cursor page. */
  listProjects(cursor: string | null = null): Promise<boolean> {
    return this.projectManager.listProjects(cursor);
  }

  /** Defers notification-driven refresh so it cannot reorder thread requests. */
  private scheduleProjectRefresh(): void {
    this.projectManager.scheduleRefresh();
  }

  /** Reads one project and replaces its cached entry without changing thread state. */
  readProject(projectId: string): Promise<boolean> {
    return this.projectManager.readProject(projectId);
  }

  /** Creates a project with validated absolute roots and an idempotency key. */
  createProject(
    name: string,
    roots: string[],
    metadata: Record<string, string> = {},
    idempotencyKey?: string,
  ): Promise<boolean> {
    return this.projectManager.createProject(name, roots, metadata, idempotencyKey);
  }

  /** Imports a project and optionally assigns existing threads atomically. */
  importProject(
    name: string,
    roots: string[],
    threadIds: string[],
    metadata: Record<string, string> = {},
    idempotencyKey?: string,
  ): Promise<boolean> {
    return this.projectManager.importProject(name, roots, threadIds, metadata, idempotencyKey);
  }

  /** Applies a project name, root, or metadata update without changing the active thread. */
  updateProject(
    projectId: string,
    changes: { name?: string; roots?: string[]; metadata?: Record<string, string> },
  ): Promise<boolean> {
    return this.projectManager.updateProject(projectId, changes);
  }

  /** Moves a project before another project, or appends it when the target is null. */
  moveProject(projectId: string, beforeProjectId: string | null): Promise<boolean> {
    return this.projectManager.moveProject(projectId, beforeProjectId);
  }

  /** Deletes project membership metadata; it never deletes threads, roots, or files. */
  deleteProject(projectId: string): Promise<boolean> {
    return this.projectManager.deleteProject(projectId);
  }

  /** Selects the collaboration mode used for the next turn. */
  setCollaborationMode(mode: "default" | "plan"): void {
    const thread = this.threadManager.activeThread;
    thread.setCollaborationMode(mode);
    this.notifyStateChanged();
  }

  /** Handles the native /goal command and its lifecycle controls. */
  manageGoal(command: string): boolean {
    const thread = this.threadManager.activeThread;
    return (
      this.initialized &&
      this.goalManager.manage(this.threadManager.selectedThreadId, thread.state.goal, command)
    );
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
    const thread = this.threadManager.activeThread;
    const pending = thread.state.pendingUserInput;
    if (!pending || !this.initialized) return false;
    const responseAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    );
    this.send({
      id: pending.requestId,
      result: { answers: responseAnswers },
    });
    const answerText = pending.questions
      .map((question) => {
        const values = answers[question.id] ?? [];
        const displayed = question.isSecret ? values.map(() => "[hidden]") : values;
        return `${question.header || question.question}: ${displayed.join(", ") || "No answer"}`;
      })
      .join("\n");
    thread.addMessage("user", answerText || "No answer provided.", pending.turnId);
    thread.clearUserInput();
    this.clearAttention(pending.threadId);
    this.notifyStateChanged();
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
        this.notifyStateChanged();
      }
    });
    this.send({
      method: "account/rateLimits/read",
      id,
      params: undefined,
    } satisfies AccountRateLimitsRequest);
  }

  /** Searches files below the requested roots for application consumers. */
  fuzzyFileSearch(query: string, roots: string[]): Promise<FuzzyFileSearchResult[]> {
    if (!this.initialized || !this.isOpen() || !roots.length) {
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
    const thread = this.threadManager.activeThread;
    const activeTurnId = thread.state.activeTurnId;
    if (
      !this.initialized ||
      !this.isOpen() ||
      !this.threadManager.selectedThreadId ||
      !activeTurnId
    ) {
      return false;
    }
    const id = ++this.nextId;
    this.send({
      method: "turn/interrupt",
      id,
      params: {
        threadId: this.threadManager.selectedThreadId,
        turnId: activeTurnId,
      },
    } satisfies TurnInterruptRequest);
    return true;
  }

  /** Starts an inline custom review on the selected thread. */
  startReview(instructions: string): boolean {
    const value = instructions.trim();
    const thread = this.threadManager.activeThread;
    if (
      !value ||
      !this.initialized ||
      !this.isOpen() ||
      !this.threadManager.selectedThreadId ||
      thread.state.status !== "idle"
    ) {
      return false;
    }
    thread.beginReview();
    const threadId = this.threadManager.selectedThreadId;
    if (!threadId) return false;
    const id = ++this.nextId;
    this.setRequest<ReviewStartResponse>(id, (message) => {
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.setActiveTurn(message.result?.turn.id);
        if (message.error) {
          targetThread.completeTurn(false);
          this.notifyStateChanged();
        }
      });
    });
    this.send({
      method: "review/start",
      id,
      params: {
        threadId: this.threadManager.selectedThreadId,
        delivery: "inline",
        target: { type: "custom", instructions: value },
      },
    } satisfies ReviewStartRequest);
    thread.setStatus("working");
    this.notifyStateChanged();
    return true;
  }

  /** Steers the active turn, falling back to queueing when its ID is stale. */
  steerPrompt(value: string): boolean {
    const prompt = value.trim();
    const thread = this.threadManager.activeThread;
    const activeTurnId = thread.state.activeTurnId;
    if (
      !prompt ||
      !this.initialized ||
      !this.isOpen() ||
      !this.threadManager.selectedThreadId ||
      !activeTurnId ||
      (thread.state.status !== "working" && thread.state.status !== "waiting")
    ) {
      return false;
    }
    const steerPrompt = `${STEER_INSTRUCTIONS}${prompt}`;
    thread.addUserMessage(steerPrompt);
    this.notifyStateChanged();
    const id = ++this.nextId;
    thread.rememberPrompt(prompt);
    thread.rememberPrompt(steerPrompt);
    this.send({
      method: "turn/steer",
      id,
      params: {
        threadId: this.threadManager.selectedThreadId,
        input: [{ type: "text", text: steerPrompt, text_elements: [] }],
        expectedTurnId: activeTurnId,
        clientUserMessageId: randomUUID(),
      },
    } satisfies TurnSteerRequest);
    return true;
  }

  /** Starts a turn while idle or persists a follow-up while a turn is active. */
  private beginModelPicker(): boolean {
    return this.modelManager.begin();
  }

  selectModel(model: string, effort: string): void {
    this.modelManager.select(model, effort);
  }

  cancelModelPicker(): void {
    this.modelManager.cancel();
  }

  submitPrompt(value: string): boolean {
    return this.submitPromptWithImages(value, []);
  }

  submitPromptWithImages(value: string, images: Array<{ url: string; name: string }>): boolean {
    if ((!value.trim() && !images.length) || !this.initialized) {
      return false;
    }

    const prompt = value.trim();
    const thread = this.threadManager.activeThread;
    thread.setCommandNotice(undefined);
    if (/^\/model$/i.test(prompt)) return this.beginModelPicker();
    const goalCommand = prompt.match(/^\/goal(?:\s+(.+))?$/is);
    if (goalCommand) return this.manageGoal(goalCommand[1] ?? "");
    const projectCommand = prompt.match(/^\/project(?:\s+(.+))?$/is);
    if (projectCommand) {
      if (!this.initialized) return false;
      return this.projectManager.manageProject(projectCommand[1] ?? "");
    }
    if (/^\/compact$/i.test(prompt)) {
      return this.lifecycle.compact();
    }
    const modeCommand = prompt.match(/^\/(plan|default)$/i);
    if (modeCommand) {
      this.setCollaborationMode(modeCommand[1].toLowerCase() as "plan" | "default");
      return true;
    }
    const newThreadMatch = prompt.match(/^\/new(?:\s+(.+))?$/);
    if (newThreadMatch) {
      thread.setCommandNotice("Choose a project and root in the /new prompt.");
      return false;
    }
    if (/^\/fork$/i.test(prompt)) {
      return this.lifecycle.fork();
    }
    if (/^\/archive$/i.test(prompt)) {
      return this.lifecycle.archive();
    }
    if (/^\/delete$/i.test(prompt)) {
      return this.lifecycle.delete();
    }

    const shellCommand = prompt.match(/^!(.+)$/s)?.[1].trim();
    if (shellCommand) {
      return this.submitShellCommand(shellCommand);
    }
    const execCommand = prompt.match(/^\/exec\s+(.+)$/s)?.[1].trim();
    if (execCommand) {
      return this.submitExecCommand(execCommand);
    }

    if (thread.state.status !== "idle") {
      return this.queuePromptInput(
        [
          ...(prompt ? [{ type: "text" as const, text: prompt, text_elements: [] }] : []),
          ...imageInputs(images),
        ],
        prompt,
        imageMetadata(images),
      );
    }

    thread.prepareTurn();
    thread.addUserMessage(prompt, undefined, imageMetadata(images));
    this.notifyStateChanged();
    thread.rememberPrompt(prompt);
    const threadId = this.threadManager.selectedThreadId;
    if (threadId) {
      this.startTurn(threadId, prompt, imageInputs(images));
      return true;
    }

    return this.lifecycle.startInitial((targetThread) => {
      this.startTurn(targetThread.id, prompt, imageInputs(images));
    });
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
      this.threadManager.thread(threadId).setStatus("working");
      this.notifyStateChanged();
    };
    if (this.threadManager.selectedThreadId) {
      this.threadManager.selectedThread().addUserMessage(`!${command}`);
      this.notifyStateChanged();
      sendCommand(this.threadManager.selectedThreadId);
      return true;
    }
    const thread = this.threadManager.activeThread;
    if (thread.state.status !== "idle") return false;
    thread.addUserMessage(`!${command}`);
    this.notifyStateChanged();
    return this.lifecycle.startShell((createdThread) => sendCommand(createdThread.id));
  }

  /** Runs a standalone argv command through the app-server sandbox. */
  private submitExecCommand(commandText: string): boolean {
    if (!this.initialized || !this.isOpen()) {
      return false;
    }
    const command = commandText
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
    if (!command?.length) return false;
    const id = ++this.nextId;
    const processId = `pesk-exec-${id}`;
    const thread = this.threadManager.activeThread;
    const cwd = thread.state.workingDirectory ?? process.cwd();
    this.threadManager.trackExecProcess(processId, thread);
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
    this.setRequest<CommandExecResponse>(id, (message) => {
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
      this.threadManager.clearExecProcess(processId);
      if (!thread.state.activeTurnId) {
        thread.setStatus("idle");
      }
      this.notifyStateChanged();
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
    thread.setStatus("working");
    this.notifyStateChanged();
    return true;
  }
  /** Queues text and image inputs while preserving attachment metadata locally. */
  private queuePromptInput(
    input: UserInput[],
    prompt: string,
    queuedImageMetadata?: Array<{ url: string; name?: string }>,
  ): boolean {
    const thread = this.threadManager.activeThread;
    if (
      !this.threadManager.selectedThreadId ||
      !this.isOpen() ||
      (thread.state.status !== "working" && thread.state.status !== "waiting")
    )
      return false;
    const queuedImages =
      queuedImageMetadata ??
      input
        .filter((item): item is Extract<UserInput, { type: "image" }> => item.type === "image")
        .map(({ url }) => ({ url }));
    const clientUserMessageId = randomUUID();
    const id = ++this.nextId;
    const threadId = this.threadManager.selectedThreadId;
    this.setRequest<LocalQueueAddResponse>(id, (message) => {
      const submission = message.result?.queuedSubmission;
      if (!submission) return;
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.resolveQueuedSubmission(clientUserMessageId, {
          id: submission.id,
          text: prompt,
          ...(queuedImages.length ? { images: queuedImages } : {}),
          clientUserMessageId,
        });
        this.notifyStateChanged();
      });
    });
    this.send({
      method: "thread/queue/add",
      id,
      params: {
        threadId: this.threadManager.selectedThreadId,
        input,
        clientUserMessageId,
      },
    });
    thread.queuePending({
      id: `pending-${clientUserMessageId}`,
      text: prompt,
      ...(queuedImages.length ? { images: queuedImages } : {}),
      clientUserMessageId,
    });
    this.notifyStateChanged();
    return true;
  }

  /** Requests the first page of the queue for one thread. */
  private refreshQueue(threadId: string): void {
    if (!this.initialized || !this.isOpen()) return;
    const id = ++this.nextId;
    this.setRequest<LocalQueueListResponse>(id, (message) => {
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.replaceQueueFromServer(message.result?.data ?? []);
        this.notifyStateChanged();
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
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.appendQueueFromServer(message.result?.data ?? []);
        this.notifyStateChanged();
        if (message.result?.nextCursor) this.refreshQueuePage(threadId, message.result.nextCursor);
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
    return this.lifecycle.startNew(workingDirectory, initialPrompt);
  }

  /** Starts and selects an empty thread assigned to a project and one of its roots. */
  startProjectThread(projectId: string, workingDirectory: string): boolean {
    return this.lifecycle.startProject(projectId, workingDirectory);
  }

  /** Sends an approval response for an app-server request. */
  respondPermission(requestId: RequestId, optionId: string): void {
    const key = requestIdKey(requestId);
    const thread = this.threadManager.activeThread;
    const pending = thread.state.pendingApprovals.get(key);
    const decision = pending?.decisions.get(optionId);
    if (!pending || decision === undefined) return;
    this.send({
      id: requestId,
      result: {
        decision,
      },
    } satisfies JsonRpcResponse<PermissionApprovalResponse>);
    const resolution = thread.resolveApprovalSelection(key, optionId);
    if (!resolution) return;
    this.clearAttention(thread.id);
    this.notifyStateChanged();
    if (!resolution.hasPending) {
      this.options.onAttentionCleared?.();
    }
    thread.setStatus("working");
    this.notifyStateChanged();
  }

  private handleSocketOpen(): void {
    this.connectionError = undefined;
    this.notifyStateChanged();
    const id = ++this.nextId;
    this.setRequest<InitializeResponse>(id, () => {
      this.send({ method: "initialized" } satisfies ClientNotification);
      this.initialized = true;
      this.threadManager.activeThread.resetTransportState();
      this.threadManager.select(undefined);
      this.threadManager.setPendingResume(undefined);
      this.notifyStateChanged();
      this.lifecycle.resetTransportState();
      this.lifecycle.discover();
      this.scheduleProjectRefresh();
    });
    this.send({
      method: "initialize",
      id,
      params: {
        clientInfo: { name: "pesk", title: "Pesk", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    } satisfies InitializeRequest);
  }

  private handleSocketError(details: string): void {
    if (this.connectionError === details) return;
    this.connectionError = details;
    this.options.debug("Codex socket error", details);
    this.notifyStateChanged();
  }

  /** Clears controller and thread state after a socket closes; the transport reconnects. */
  private handleSocketClose(event: unknown): void {
    const closeEvent = event as {
      code?: unknown;
      reason?: unknown;
      wasClean?: unknown;
    };
    this.options.debug("Codex socket closed", {
      code: closeEvent.code,
      reason: closeEvent.reason,
      wasClean: closeEvent.wasClean,
    });
    const selectedThread = this.threadManager.selectedThread();
    if (this.threadManager.selectedThreadId) {
      this.threadManager.standaloneThread.replaceHistory(selectedThread.snapshot().history);
    }
    this.initialized = false;
    this.rateLimitsReadPending = false;
    selectedThread.resetTransportState();
    this.threadManager.select(undefined);
    this.threadManager.clearThreads();
    this.projectManager.reset();
    this.threadManager.clearTransportState();
    selectedThread.setStatus("idle");
    this.notifyStateChanged();
  }

  /** Routes a thread-scoped event into the owning thread. */
  private handleServerMessage(message: ServerMessage): void {
    const threadId = messageThreadId(message);
    if (threadId && message.method !== "thread/started") {
      const previousSelectedThread = this.threadManager.selectedThreadId;
      const wasBackgroundThread = previousSelectedThread !== threadId;
      const thread = this.threadManager.thread(threadId);
      const previousStatus = thread.state.status;
      this.threadManager.withThread(threadId, (targetThread) =>
        this.handleServerMessageInternal(message, targetThread),
      );
      const nextStatus = thread.state.status;
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
        this.threadManager.completeBackgroundWork(threadId);
      }
      if (message.method === "turn/completed") {
        this.notifyAttention({
          event: "turnCompleted",
          threadId,
          selectedThreadId: previousSelectedThread,
        });
      } else if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        this.notifyAttention({
          event: "approvalRequested",
          threadId,
          selectedThreadId: previousSelectedThread,
          requestId: message.id,
        });
      } else if (message.method === "item/tool/requestUserInput") {
        this.notifyAttention({
          event: "userInputRequested",
          threadId,
          selectedThreadId: previousSelectedThread,
        });
      }
      // Streaming deltas for a background thread do not affect the selected
      // history. Avoid cloning and broadcasting every background token.
      const highFrequencyStream =
        message.method === "item/agentMessage/delta" ||
        message.method === "item/commandExecution/outputDelta";
      const shouldPublish =
        !highFrequencyStream &&
        (!wasBackgroundThread ||
          nextStatus !== previousStatus ||
          message.method === "turn/completed" ||
          message.method === "item/commandExecution/requestApproval" ||
          message.method === "item/fileChange/requestApproval" ||
          message.method === "item/tool/requestUserInput" ||
          message.method === "thread/status/changed");
      if (shouldPublish) this.notifyStateChanged();
      return;
    }
    this.handleServerMessageInternal(message, this.threadManager.activeThread);
  }

  /** Routes an app-server notification or request to its protocol handler. */
  private handleServerMessageInternal(message: ServerMessage, thread: CodexThread): void {
    const method = message.method;
    if (!method.startsWith("item")) {
      this.options.debug(message);
    }

    switch (method) {
      case "thread/started":
        this.lifecycle.handleThreadStarted(message);
        break;
      case "thread/queue/changed":
        this.refreshQueue(message.params.threadId);
        break;
      case "project/changed":
        this.scheduleProjectRefresh();
        break;
      case "thread/project/updated":
        this.lifecycle.handleProjectUpdated(message, thread);
        break;
      case "thread/archived":
        this.lifecycle.handleThreadRemoved(message.params.threadId);
        break;
      case "thread/deleted":
        this.lifecycle.handleThreadRemoved(message.params.threadId);
        break;
      case "turn/started":
        this.handleTurnStarted(message, thread);
        break;
      case "item/started":
        this.handleItemStarted(message, thread);
        break;
      case "turn/completed":
        this.handleTurnCompleted(message, thread);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(message, thread);
        break;
      case "account/rateLimits/updated":
        this.rateLimits = message.params.rateLimits;
        this.notifyStateChanged();
        break;
      case "model/rerouted":
        this.lifecycle.handleModelRerouted(message, thread);
        break;
      case "thread/settings/updated":
        this.lifecycle.handleSettingsUpdated(message, thread);
        break;
      case "thread/goal/updated":
        this.goalManager.handleUpdated(message.params.threadId, message.params.goal);
        break;
      case "thread/goal/cleared":
        this.goalManager.handleCleared(message.params.threadId);
        break;
      case "thread/status/changed":
        this.lifecycle.handleStatusChanged(message, thread);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(message, thread);
        break;
      case "item/plan/delta":
        thread.appendPlanDelta(message.params.itemId, message.params.delta);
        this.notifyStateChanged();
        break;
      case "item/commandExecution/outputDelta":
        this.handleCommandOutputDelta(message, thread);
        break;
      case "command/exec/outputDelta":
        this.handleExecOutputDelta(message);
        break;
      case "item/completed":
        this.handleItemCompleted(message, thread);
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.handleApprovalRequest(message, thread);
        break;
      case "item/tool/requestUserInput":
        this.handleUserInputRequest(message, thread);
        break;
      case "serverRequest/resolved":
        if (thread.state.pendingUserInput?.requestId === message.params.requestId) {
          const threadId = thread.state.pendingUserInput?.threadId;
          thread.clearUserInput();
          if (threadId) {
            this.clearAttention(threadId);
          }
          this.notifyStateChanged();
        }
        break;
    }
  }

  /** Tracks the active turn and associates it with the latest user message. */
  private handleTurnStarted(
    message: Extract<ServerMessage, { method: "turn/started" }>,
    thread: CodexThread,
  ): void {
    const turnId = message.params.turn.id;
    if (typeof message.params.threadId !== "string") {
      thread.setActiveTurn(turnId);
      thread.ensureWorking();
      thread.setStatus("working");
      this.notifyStateChanged();
      return;
    }
    thread.startTurn(turnId);
    this.notifyStateChanged();
  }

  /** Adds echoed user input and visible activity from a started item. */
  private handleItemStarted(
    message: Extract<ServerMessage, { method: "item/started" }>,
    thread: CodexThread,
  ): void {
    const threadId = message.params.threadId;
    thread.setStatus("working");
    this.notifyStateChanged();
    const item = isRecord(message.params.item)
      ? (message.params.item as Record<string, unknown>)
      : undefined;
    if (item) {
      thread.processStartedItem(
        item,
        message.params.turnId,
        thread.state.reviewInProgress && item.type === "userMessage",
      );
    }
  }

  /** Finalizes turn state and records token usage from a completed turn. */
  private handleTurnCompleted(
    message: Extract<ServerMessage, { method: "turn/completed" }>,
    thread: CodexThread,
  ): void {
    if (typeof message.params.threadId !== "string") {
      thread.completeTurn(message.params.turn?.status === "interrupted");
      thread.setStatus("idle");
      this.notifyStateChanged();
      const legacyTurn = isRecord(message.params.turn)
        ? (message.params.turn as Record<string, unknown>)
        : undefined;
      const legacyUsage = parseTokenUsageValue(legacyTurn?.tokenUsage ?? legacyTurn?.usage);
      if (legacyUsage) thread.setTokenUsage(legacyUsage);
      return;
    }
    thread.clearUserInput();
    this.clearAttention(message.params.threadId);
    thread.completeTurn(message.params.turn?.status === "interrupted");
    this.refreshQueue(message.params.threadId);
    this.notifyStateChanged();
    const turn = isRecord(message.params.turn)
      ? (message.params.turn as Record<string, unknown>)
      : undefined;
    const usage = parseTokenUsageValue(turn?.tokenUsage ?? turn?.usage);
    if (usage && !this.startingNewThread) {
      thread.setTokenUsage(usage);
      this.options.debug("Pesk Codex token usage", {
        source: "turn/completed",
        usage,
      });
      this.notifyStateChanged();
    }
  }

  /** Updates the selected thread's token usage from a live notification. */
  private handleTokenUsageUpdated(
    message: Extract<ServerMessage, { method: "thread/tokenUsage/updated" }>,
    thread: CodexThread,
  ): void {
    const { threadId, turnId, tokenUsage } = message.params;
    const usage = parseTokenUsageValue(tokenUsage);
    if (usage && !this.startingNewThread) {
      thread.setTokenUsage(usage);
      this.options.debug("Pesk Codex token usage", {
        source: "thread/tokenUsage/updated",
        threadId,
        turnId,
        usage,
      });
      this.notifyStateChanged();
    }
  }

  /** Appends streamed assistant text to the conversation. */
  private handleAgentMessageDelta(
    message: Extract<ServerMessage, { method: "item/agentMessage/delta" }>,
    thread: CodexThread,
  ): void {
    if (typeof message.params.threadId !== "string") {
      thread.appendAssistantDelta(
        message.params.delta,
        message.params.itemId,
        message.params.turnId,
      );
      this.options.onStreamDelta?.({
        kind: "assistant",
        itemId: message.params.itemId,
        delta: message.params.delta,
      });
      return;
    }
    thread.appendAssistantDelta(message.params.delta, message.params.itemId, message.params.turnId);
    if (this.threadManager.isSelected(message.params.threadId)) {
      this.options.onStreamDelta?.({
        threadId: message.params.threadId,
        kind: "assistant",
        itemId: message.params.itemId,
        delta: message.params.delta,
      });
    }
  }

  /** Appends streamed command output to its activity message. */
  private handleCommandOutputDelta(
    message: Extract<ServerMessage, { method: "item/commandExecution/outputDelta" }>,
    thread: CodexThread,
  ): void {
    if (this.threadManager.selectedThreadId || thread.id !== "standalone") {
      thread.appendActivityOutput(message.params.itemId, message.params.delta);
      if (!this.threadManager.selectedThreadId || this.threadManager.isSelected(thread.id)) {
        this.options.onStreamDelta?.({
          threadId: thread.id === "standalone" ? this.threadManager.selectedThreadId : thread.id,
          kind: "command",
          itemId: message.params.itemId,
          delta: message.params.delta,
        });
      }
    }
  }

  /** Stores a server request_user_input request in the owning thread. */
  private handleUserInputRequest(
    message: Extract<ServerMessage, { method: "item/tool/requestUserInput" }>,
    thread: CodexThread,
  ): void {
    const pending = {
      requestId: message.id,
      threadId: message.params.threadId,
      turnId: message.params.turnId,
      itemId: message.params.itemId,
      questions: message.params.questions,
      isBlocking: message.params.isBlocking,
    };
    thread.setUserInput(pending);
    thread.setStatus("waiting");
    this.noteAttention(pending.threadId, "userInput");
    if (!messageThreadId(message)) {
      this.notifyAttention({
        event: "userInputRequested",
        threadId: pending.threadId,
        selectedThreadId: this.threadManager.selectedThreadId,
      });
    }
    this.notifyStateChanged();
  }

  /** Commits a completed assistant or activity item to conversation history. */
  private handleItemCompleted(
    message: Extract<ServerMessage, { method: "item/completed" }>,
    thread: CodexThread,
  ): void {
    const item = isRecord(message.params.item) ? message.params.item : undefined;
    if (item) {
      thread.processCompletedItem(item);
      if (item.type === "agentMessage") {
        this.options.onStreamDelta?.({
          threadId: messageThreadId(message),
          itemId: stringValue(item.id),
          kind: "assistant",
          delta: "",
          completed: true,
        });
      }
    }
    this.notifyStateChanged();
  }

  /** Displays a pending approval and changes the controller to waiting status. */
  private handleApprovalRequest(
    message: Extract<
      ServerMessage,
      {
        method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
      }
    >,
    thread: CodexThread,
  ): void {
    const id = message.id;
    const decisions = approvalDecisions(message);
    const command = "command" in message.params ? (message.params.command ?? "") : "";
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
    thread.addApproval(requestIdKey(id), approval, displayed);
    this.noteAttention(message.params.threadId, "approval");
    if (!messageThreadId(message)) {
      this.notifyAttention({
        event: "approvalRequested",
        threadId: message.params.threadId,
        selectedThreadId: this.threadManager.selectedThreadId,
        requestId: id,
        command,
        reason,
      });
    }
    thread.setStatus("waiting");
    this.notifyStateChanged();
  }

  private noteAttention(threadId: string, type: "approval" | "userInput"): void {
    this.threadManager.noteAttention(threadId, type);
  }

  private clearAttention(threadId: string): void {
    this.threadManager.clearAttention(threadId);
  }

  /** Starts a text turn and creates a temporary working message. */
  private startTurn(threadId: string, prompt: string, extraInput: UserInput[] = []): void {
    const thread = this.threadManager.thread(threadId);
    thread.prepareTurn();
    const id = ++this.nextId;
    this.setRequest<TurnStartResponse>(id, (message) => {
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.setActiveTurn(message.result?.turn.id);
        if (message.error) {
          targetThread.setStatus("idle");
          this.notifyStateChanged();
        }
      });
    });
    const params: PlanTurnStartParams = {
      threadId,
      input: [
        ...(prompt ? [{ type: "text" as const, text: prompt, text_elements: [] }] : []),
        ...extraInput,
      ],
    };
    params.collaborationMode = {
      mode: thread.state.collaborationMode,
      settings: {
        model: thread.state.modelInfo?.model ?? "gpt-5.1-codex",
        reasoning_effort: thread.state.collaborationMode === "plan" ? "medium" : null,
        developer_instructions: null,
      },
    };
    this.send({
      method: "turn/start",
      id,
      params,
    } satisfies TurnStartRequest);
    if (!this.threadManager.isSelected(threadId)) this.threadManager.trackBackgroundWork(threadId);
    this.threadManager.withThread(threadId, (targetThread) => {
      targetThread.setStatus("working");
      this.notifyStateChanged();
    });
  }

  /** Appends base64-decoded output from a standalone command/exec request. */
  private handleExecOutputDelta(
    message: Extract<ServerMessage, { method: "command/exec/outputDelta" }>,
  ): void {
    const delta = Buffer.from(message.params.deltaBase64, "base64").toString();
    const thread = this.threadManager.execThread(message.params.processId);
    if (thread) {
      thread.appendActivityOutput(message.params.processId, delta);
      this.notifyStateChanged();
    }
  }
}

function imageInputs(images: Array<{ url: string; name: string }>): UserInput[] {
  return images.map(({ url }) => ({
    type: "image",
    url,
  }));
}

function imageMetadata(
  images: Array<{ url: string; name: string }>,
): Array<{ url: string; name?: string }> {
  return images.map(({ url, name }) => ({ url, name }));
}
