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
  isThread,
  messageThreadId,
  requestIdKey,
  stringValue,
  shouldReconcileOnIdle,
  shouldResumeOnActiveStatus,
} from "./protocol";

import type { NotificationRequest } from "../services/notification";
import type { JsonRpcResponse, PermissionApprovalResponse, ServerMessage } from "./protocol";
import { CodexWebSocketTransport, type CodexSocketTransport } from "./websocket";
import { CodexThread, parseTokenUsageValue, approvalOptions } from "./thread";
import { CodexThreadManager } from "./thread-manager";
import { randomUUID } from "node:crypto";
import {
  CodexProjectManager,
  validProjectId,
  validProjectRoots,
  type ProjectRequestInput,
} from "./projects";
import type {
  Thread,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadStartResponse,
  TurnStartResponse,
  ReviewStartResponse,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  CommandExecResponse,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadTurnsListResponse,
  ThreadCompactStartResponse,
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
  ThreadListRequest,
  ThreadReadRequest,
  ThreadTurnsListRequest,
  ThreadArchiveRequest,
  ThreadDeleteRequest,
  ThreadResumeRequest,
  ThreadForkRequest,
  ThreadShellCommandRequest,
  ThreadStartRequest,
  ProjectThreadStartRequest,
  ThreadCompactStartRequest,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnSteerRequest,
} from "./protocol";
import { CodexModelManager, type ModelRequestInput } from "./model";
import { CodexGoalManager, type GoalRequestInput } from "./goal";

const STEER_INSTRUCTIONS = `Treat this message as a steer to the currently active request.

Preserve all existing requirements, constraints, entities, and output formats unless this steer explicitly changes, removes, cancels, or replaces them. Apply only the requested change and continue the complete updated request.

If the steer is materially ambiguous, ask one concise clarifying question. Otherwise, use the most natural interpretation and proceed.

Steer message:
`;
const HISTORY_PAGE_LIMIT = 5;

/** Codex-related settings persisted alongside the pet settings. */
interface Options {
  publishRendererState: () => void;
  publishStreamDelta?: (delta: CodexStreamDelta) => void;
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
  private readonly socket: CodexSocketTransport;
  /** Human-readable transport error shown by the renderer. */
  private connectionError: string | undefined;
  /** Server-owned project operations and collection, separate from thread selection. */
  private readonly projectManager: CodexProjectManager;
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
  /** Prevents duplicate thread discovery requests. */
  private discoveryPending = false;
  /** Locally requested thread starts awaiting their responses/events. */
  private pendingThreadStarts = 0;
  /** Thread id announced as active and awaiting resume. */
  private pendingThreadResumeId: string | undefined;
  /** Correlates local thread/start responses with thread/started events. */
  private readonly locallyStartedThreads = new Set<string>();
  /** Per-thread threadInstances and thread-scoped lifecycle state. */
  private readonly threadManager = new CodexThreadManager();
  private readonly modelManager: CodexModelManager;
  private readonly goalManager: CodexGoalManager;

  /** Creates a controller with callbacks for renderer and window updates. */
  constructor(options: Options, socket: CodexSocketTransport = new CodexWebSocketTransport()) {
    this.options = {
      ...options,
      publishRendererState: () => {
        if (!this.threadManager.isPublicationSuppressed) {
          options.publishRendererState();
        }
      },
      handleNotification: (request) => {
        if (!this.threadManager.isPublicationSuppressed) {
          options.handleNotification(request);
        }
      },
    };
    this.socket = socket;
    this.projectManager = new CodexProjectManager({
      request: (request) => this.requestProject(request),
      publishRendererState: () => this.options.publishRendererState(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
      setConnectionError: (error) => {
        this.connectionError = error;
      },
    });
    this.modelManager = new CodexModelManager({
      request: (request, callback) => this.requestModel(request, callback),
      getSelectedThreadId: () => this.threadManager.selectedThreadId,
      publishRendererState: () => this.options.publishRendererState(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
    });
    this.goalManager = new CodexGoalManager({
      request: (request, callback) => this.requestGoal(request, callback),
      setGoal: (threadId, goal) =>
        this.threadManager.withThread(threadId, (targetThread) => targetThread.setGoal(goal)),
      publishRendererState: () => this.options.publishRendererState(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
      setConnectionError: (error) => {
        this.connectionError = error;
      },
      setCollaborationMode: (mode) => this.setCollaborationMode(mode),
    });
    this.socket
      .on("open", () => this.handleSocketOpen())
      .on("message", (message) => this.handleServerMessage(message))
      .on("close", (event) => this.handleSocketClose(event))
      .on("error", (details) => this.handleSocketError(details))
      .on("debug", (values) => this.options.debug(...values));
  }

  private readonly options: Options;

  /** Returns the current state snapshot for renderer IPC responses. */
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
    const threadId = this.threadManager.selectedThreadId;
    if (!threadId) return Promise.resolve(false);
    const state = this.threadManager.historyState(threadId);
    if (!state.paginated || state.loading || !state.hasOlderHistory) {
      return Promise.resolve(false);
    }
    return this.loadHistoryPage(threadId, state.nextCursor, false);
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

  private requestModel<TResult>(
    request: ModelRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): void {
    if (!this.initialized) return;
    const id = ++this.nextId;
    this.setRequest<TResult>(id, callback);
    this.send({ ...request, id } as never);
  }

  private requestGoal<TResult>(
    request: GoalRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): void {
    if (!this.initialized) return;
    const id = ++this.nextId;
    this.setRequest<TResult>(id, callback);
    this.send({ ...request, id } as never);
  }

  private restoreGoal(threadId: string): void {
    this.goalManager.restore(threadId);
  }

  /** Selects a known Codex thread and resumes it. */
  selectThread(id: string): void {
    this.switchThread(id);
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
    this.options.publishRendererState();
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
          this.options.publishRendererState();
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
    this.options.publishRendererState();
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
    this.options.publishRendererState();
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
      return this.compactThread();
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
      return this.forkThread();
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
    this.options.publishRendererState();
    thread.rememberPrompt(prompt);
    const threadId = this.threadManager.selectedThreadId;
    if (threadId) {
      this.startTurn(threadId, prompt, imageInputs(images));
      return true;
    }

    const id = ++this.nextId;
    this.options.debug("Pesk starting new Codex thread", {
      cwd: thread.state.workingDirectory ?? process.cwd(),
      reason: "first prompt",
    });
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: thread.snapshot().workingDirectory ?? ".",
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const serverThread = message.result?.thread;
      if (typeof serverThread?.id === "string") {
        const thread = this.threadManager.thread(serverThread.id);
        const pendingHistory = this.threadManager.standaloneThread.snapshot().history;
        this.threadManager.selectedThreadId = serverThread.id;
        thread.reset(pendingHistory);
        this.threadManager.withThread(thread.id, (targetThread) => {
          this.noteThreadStartResponse(thread.id);
          this.updateModelInfo(message);
          targetThread.setConnected(true);
          targetThread.syncServerThread(serverThread);
          this.options.publishRendererState();
          this.startTurn(thread.id, prompt, imageInputs(images));
        });
      }
    });
    return true;
  }

  /** Starts manual history compaction for the selected idle thread. */
  private compactThread(): boolean {
    if (!this.initialized || !this.isOpen()) return false;
    const thread = this.threadManager.activeThread;
    if (!this.threadManager.selectedThreadId) {
      thread.setCommandNotice("No active thread to compact.");
      this.options.publishRendererState();
      return false;
    }
    if (thread.state.status !== "idle") {
      thread.setCommandNotice("Wait for the current turn to finish before compacting.");
      this.options.publishRendererState();
      return false;
    }

    const threadId = this.threadManager.selectedThreadId;
    const id = ++this.nextId;
    this.setRequest<ThreadCompactStartResponse>(id, (message) => {
      if (message.error) {
        this.threadManager.withThread(threadId, (targetThread) => {
          targetThread.setStatus("idle");
          targetThread.setCommandNotice("Unable to compact the current thread.");
        });
        this.options.publishRendererState();
      }
    });
    this.send({
      method: "thread/compact/start",
      id,
      params: { threadId },
    } satisfies ThreadCompactStartRequest);
    thread.setStatus("working");
    this.options.publishRendererState();
    return true;
  }

  /** Archives the currently selected thread through the app server. */
  private archiveThread(): boolean {
    if (!this.threadManager.selectedThreadId) return false;
    const threadId = this.threadManager.selectedThreadId;
    const id = ++this.nextId;
    this.setRequest<ThreadArchiveResponse>(id, () => undefined);
    this.send({
      method: "thread/archive",
      id,
      params: { threadId },
    } satisfies ThreadArchiveRequest);
    return true;
  }

  /** Forks the currently selected thread and selects the new copy. */
  private forkThread(): boolean {
    if (!this.threadManager.selectedThreadId) return false;
    const sourceThreadId = this.threadManager.selectedThreadId;
    const sourceCollaborationMode = this.threadManager.selectedThread().state.collaborationMode;
    const id = ++this.nextId;
    this.setRequest<ThreadForkResponse>(id, (message) => {
      const serverThread = message.result?.thread;
      if (typeof serverThread?.id !== "string") return;
      const thread = this.threadManager.thread(serverThread.id);
      thread.reset([], serverThread.cwd ?? process.cwd());
      thread.setCollaborationMode(sourceCollaborationMode);
      thread.syncServerThread(serverThread);
      thread.applyServerStatus(serverThread.status ?? {});
      this.threadManager.deleteHistoryState(serverThread.id);
      this.loadHistoryPage(serverThread.id, null, true);
      thread.setConnected(true);
      this.threadManager.upsertThread(serverThread);
      this.threadManager.selectedThreadId = serverThread.id;
      this.pendingThreadResumeId = undefined;
      this.updateModelInfo(message);
      thread.setCommandNotice(`Thread forked — switched to ${serverThread.id}`);
      this.options.publishRendererState();
    });
    this.send({
      method: "thread/fork",
      id,
      params: { threadId: sourceThreadId, excludeTurns: true },
    } satisfies ThreadForkRequest);
    return true;
  }

  /** Permanently deletes the currently selected thread through the app server. */
  private deleteThread(): boolean {
    if (!this.threadManager.selectedThreadId) return false;
    const threadId = this.threadManager.selectedThreadId;
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
      this.threadManager.thread(threadId).setStatus("working");
      this.options.publishRendererState();
    };
    if (this.threadManager.selectedThreadId) {
      this.threadManager.selectedThread().addUserMessage(`!${command}`);
      this.options.publishRendererState();
      sendCommand(this.threadManager.selectedThreadId);
      return true;
    }
    const thread = this.threadManager.activeThread;
    if (thread.state.status !== "idle") return false;
    thread.addUserMessage(`!${command}`);
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: thread.snapshot().workingDirectory ?? ".",
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const serverThread = message.result?.thread;
      if (typeof serverThread?.id !== "string") return;
      this.noteThreadStartResponse(serverThread.id);
      this.threadManager.selectedThreadId = serverThread.id;
      const thread = this.threadManager.thread(serverThread.id);
      thread.setConnected(true);
      thread.syncServerThread(serverThread);
      this.options.publishRendererState();
      sendCommand(serverThread.id);
    });
    return true;
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
    this.threadManager.execThreadMap.set(processId, thread);
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
      this.threadManager.execThreadMap.delete(processId);
      if (!thread.state.activeTurnId) {
        thread.setStatus("idle");
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
    thread.setStatus("working");
    this.options.publishRendererState();
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
        this.options.publishRendererState();
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
    this.options.publishRendererState();
    return true;
  }

  /** Requests the first page of the queue for one thread. */
  private refreshQueue(threadId: string): void {
    if (!this.initialized || !this.isOpen()) return;
    const id = ++this.nextId;
    this.setRequest<LocalQueueListResponse>(id, (message) => {
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.replaceQueueFromServer(message.result?.data ?? []);
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
      this.threadManager.withThread(threadId, (targetThread) => {
        targetThread.appendQueueFromServer(message.result?.data ?? []);
        this.options.publishRendererState();
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
    if (!this.initialized) {
      return false;
    }
    const thread = this.threadManager.activeThread;
    const cwd = (workingDirectory ?? thread.state.workingDirectory ?? process.cwd()).trim();
    if (!cwd) {
      return false;
    }
    this.startingNewThread = true;
    thread.setTokenUsage(undefined);
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
      const serverThread = message.result?.thread;
      if (typeof serverThread?.id !== "string") {
        this.startingNewThread = false;
        return;
      }
      this.startingNewThread = false;
      this.noteThreadStartResponse(serverThread.id);
      this.threadManager.selectedThreadId = serverThread.id;
      const thread = this.threadManager.thread(serverThread.id);
      thread.reset([], cwd);
      thread.setConnected(true);
      thread.syncServerThread(serverThread);
      this.updateModelInfo(message);
      this.threadManager.upsertThread(serverThread);
      this.options.publishRendererState();
      if (initialPrompt) {
        thread.addUserMessage(initialPrompt);
        this.options.publishRendererState();
        thread.rememberPrompt(initialPrompt);
        this.startTurn(thread.id, initialPrompt);
      }
    });
    return true;
  }

  /** Starts and selects an empty thread assigned to a project and one of its roots. */
  startProjectThread(projectId: string, workingDirectory: string): boolean {
    const cwd = typeof workingDirectory === "string" ? workingDirectory.trim() : "";
    const initialThread = this.threadManager.activeThread;
    if (!this.initialized || !validProjectId(projectId) || !validProjectRoots([{ path: cwd }])) {
      initialThread.setCommandNotice("Choose a valid project and absolute root.");
      this.options.publishRendererState();
      return false;
    }
    const project = this.projectManager.findProject(projectId);
    if (!project || !project.roots.some((root) => root.path === cwd)) {
      initialThread.setCommandNotice("The selected root is not configured for that project.");
      this.options.publishRendererState();
      return false;
    }
    this.startingNewThread = true;
    initialThread.setTokenUsage(undefined);
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.options.debug("Pesk starting project Codex thread", {
      cwd,
      projectId,
      reason: "new project thread",
    });
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: cwd,
        projectId,
        serviceName: "pesk",
      },
    } satisfies ProjectThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const serverThread = message.result?.thread;
      if (typeof serverThread?.id !== "string") {
        this.startingNewThread = false;
        initialThread.setCommandNotice(
          typeof message.error === "string" ? message.error : "Unable to create project thread.",
        );
        this.options.publishRendererState();
        return;
      }
      this.startingNewThread = false;
      this.noteThreadStartResponse(serverThread.id);
      this.threadManager.selectedThreadId = serverThread.id;
      const thread = this.threadManager.thread(serverThread.id);
      thread.reset([], cwd);
      thread.setProjectId(projectId);
      thread.setConnected(true);
      thread.syncServerThread(serverThread);
      this.updateModelInfo(message);
      this.threadManager.upsertThread(serverThread);
      this.options.publishRendererState();
    });
    return true;
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
    this.options.publishRendererState();
    if (!resolution.hasPending) {
      this.options.clearNotification?.();
    }
    thread.setStatus("working");
    this.options.publishRendererState();
    this.routeNextAttention();
  }

  private handleSocketOpen(): void {
    this.connectionError = undefined;
    this.options.publishRendererState();
    const id = ++this.nextId;
    this.setRequest<InitializeResponse>(id, () => {
      this.send({ method: "initialized" } satisfies ClientNotification);
      this.initialized = true;
      this.threadManager.activeThread.resetTransportState();
      this.threadManager.selectedThreadId = undefined;
      this.pendingThreadResumeId = undefined;
      this.options.publishRendererState();
      this.discover();
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
    this.options.publishRendererState();
  }

  /** Clears transport state after a socket closes and schedules reconnection. */
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
    this.discoveryPending = false;
    this.rateLimitsReadPending = false;
    selectedThread.resetTransportState();
    this.threadManager.selectedThreadId = undefined;
    this.threadManager.clearThreads();
    this.projectManager.reset();
    this.pendingThreadStarts = 0;
    this.pendingThreadResumeId = undefined;
    this.locallyStartedThreads.clear();
    this.threadManager.clearTransportState();
    selectedThread.setStatus("idle");
    this.options.publishRendererState();
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
      this.threadManager.replaceThreads(threads);
      for (const serverThread of threads) {
        const thread = this.threadManager.thread(serverThread.id);
        thread.syncServerThread(serverThread);
        thread.applyServerStatus(serverThread.status ?? {});
        if (thread.state.status !== "idle") this.threadManager.trackBackgroundWork(serverThread.id);
      }
      if (!threads.length) {
        this.threadManager.selectedThreadId = undefined;
        this.threadManager.standaloneThread.clearConversation();
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
  private switchThread(id: string, resume = true, preserveHistory = false): void {
    if (!id || (this.threadManager.threads.length > 0 && !this.threadManager.hasThread(id))) {
      return;
    }
    const previousThreadId = this.threadManager.selectedThreadId;
    if (previousThreadId !== id) {
      this.modelManager.cancel();
    }
    if (previousThreadId && previousThreadId !== id) {
      const previousThread = this.threadManager.thread(previousThreadId);
      if (previousThread.state.status !== "idle")
        this.threadManager.trackBackgroundWork(previousThreadId);
    }
    this.threadManager.clearBackgroundWork(id);
    if (this.threadManager.isSelected(id)) {
      if (resume && !this.threadManager.activeThread.state.connected) {
        this.threadManager.pendingHistoryLoads.add(id);
        this.resume(id);
      }
      this.options.publishRendererState();
      return;
    }
    if (!preserveHistory) this.threadManager.captureSelectedHistoryForReload();
    const pendingHistory = preserveHistory
      ? this.threadManager.activeThread.snapshot().history
      : undefined;
    this.threadManager.selectedThreadId = id;
    const existing = this.threadManager.hasThreadInstance(id);
    if (!existing) {
      this.threadManager.thread(id).reset(preserveHistory ? (pendingHistory ?? []) : []);
    } else if (!preserveHistory) {
      this.threadManager.thread(id).clearHistory();
    }
    if (!preserveHistory) this.threadManager.deleteHistoryState(id);
    if (resume || existing) this.threadManager.pendingHistoryLoads.add(id);
    this.options.publishRendererState();
    if (resume) {
      if (existing && this.threadManager.activeThread.state.connected) {
        this.read(id);
      } else {
        this.resume(id);
      }
    } else if (existing) {
      this.read(id);
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
      this.threadManager.withThread(threadId, (targetThread) => {
        if (!message.error) {
          this.threadManager.readOnlyThreadIds.delete(threadId);
          this.updateModelInfo(message);
          this.read(threadId);
          return;
        }
        const text =
          typeof (message.error as Record<string, unknown>).message === "string"
            ? ((message.error as Record<string, unknown>).message as string)
            : "";
        if (text.includes("already has an active writer")) {
          this.threadManager.readOnlyThreadIds.add(threadId);
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
        excludeTurns: true,
      },
    } satisfies ThreadResumeRequest);
  }

  /** Reads persisted turns and converts them into renderer messages. */
  private read(threadId: string): void {
    const id = ++this.nextId;
    this.setRequest<ThreadReadResponse>(id, (message) => {
      this.threadManager.withThread(threadId, (targetThread) => {
        const serverThread = message.result?.thread;
        if (isThread(serverThread)) {
          this.threadManager.upsertThread(serverThread);
        }
        targetThread.syncServerThread(serverThread);
        targetThread.setConnected(true);
        targetThread.applyServerStatus(serverThread?.status ?? {});
        this.options.publishRendererState();
        setTimeout(() => this.refreshQueue(threadId), 0);
        this.loadHistoryPage(threadId, null, true);
        setTimeout(() => this.restoreGoal(threadId), 0);
      });
    });
    this.send({
      method: "thread/read",
      id,
      params: {
        threadId,
        includeTurns: false,
      },
    } satisfies ThreadReadRequest);
  }

  private loadHistoryPage(
    threadId: string,
    cursor: string | null,
    replace: boolean,
  ): Promise<boolean> {
    const state = this.threadManager.historyState(threadId);
    if (state.loading) return Promise.resolve(false);
    state.loading = true;
    if (replace) {
      state.paginated = true;
      state.nextCursor = null;
      state.hasOlderHistory = false;
    }
    if (this.threadManager.isSelected(threadId)) this.options.publishRendererState();
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.setRequest<ThreadTurnsListResponse>(id, (message) => {
        this.threadManager.withThread(threadId, (targetThread) => {
          const result = message.result;
          if (!result) {
            state.loading = false;
            this.threadManager.pendingHistoryLoads.delete(threadId);
            state.hasOlderHistory = false;
            if (this.threadManager.isSelected(threadId)) this.options.publishRendererState();
            resolve(false);
            return;
          }
          targetThread.restoreTurns([...result.data].reverse(), !replace);
          state.nextCursor = result.nextCursor;
          state.hasOlderHistory = result.nextCursor !== null;
          state.loading = false;
          this.threadManager.pendingHistoryLoads.delete(threadId);
          if (this.threadManager.isSelected(threadId)) this.options.publishRendererState();
          resolve(true);
        });
      });
      this.send({
        method: "thread/turns/list",
        id,
        params: {
          threadId,
          cursor,
          limit: HISTORY_PAGE_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        },
      } satisfies ThreadTurnsListRequest);
    });
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
      if (shouldPublish) this.options.publishRendererState();
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
        this.handleThreadStarted(message);
        break;
      case "thread/queue/changed":
        this.refreshQueue(message.params.threadId);
        break;
      case "project/changed":
        this.scheduleProjectRefresh();
        break;
      case "thread/project/updated":
        thread.setProjectId(message.params.projectId);
        this.scheduleProjectRefresh();
        this.options.publishRendererState();
        break;
      case "thread/archived":
        this.handleThreadRemoved(message.params.threadId);
        break;
      case "thread/deleted":
        this.handleThreadRemoved(message.params.threadId);
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
        this.options.publishRendererState();
        break;
      case "model/rerouted":
        this.handleModelRerouted(message, thread);
        break;
      case "thread/settings/updated":
        this.handleThreadSettingsUpdated(message, thread);
        break;
      case "thread/goal/updated":
        this.goalManager.handleUpdated(message.params.threadId, message.params.goal);
        break;
      case "thread/goal/cleared":
        this.goalManager.handleCleared(message.params.threadId);
        break;
      case "thread/status/changed":
        this.handleThreadStatusChanged(message, thread);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(message, thread);
        break;
      case "item/plan/delta":
        thread.appendPlanDelta(message.params.itemId, message.params.delta);
        this.options.publishRendererState();
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
            this.routeNextAttention();
          }
          this.options.publishRendererState();
        }
        break;
    }
  }

  /** Removes archived/deleted threads from local state and selects a survivor. */
  private handleThreadRemoved(threadId: string): void {
    this.threadManager.removeThread(threadId);
    this.threadManager.remove(threadId);
    if (!this.threadManager.isSelected(threadId)) {
      this.options.publishRendererState();
      return;
    }
    const nextThread = this.threadManager.threads[0];
    this.threadManager.selectedThreadId = undefined;
    this.threadManager.standaloneThread.clearConversation();
    if (nextThread) this.switchThread(nextThread.id);
    this.options.publishRendererState();
  }

  /** Selects and initializes a thread announced by the app server. */
  private handleThreadStarted(message: Extract<ServerMessage, { method: "thread/started" }>): void {
    const { thread: serverThread } = message.params;
    this.threadManager.upsertThread(serverThread);
    const locallyStarted = this.consumeLocalThreadStarted(serverThread.id);
    // Real thread/started payloads always include status. Incomplete legacy
    // payloads are treated as a local announcement for compatibility.
    const shouldSelect =
      locallyStarted || !this.threadManager.hasSelectedThread() || !serverThread.status;
    if (!shouldSelect) {
      const thread = this.threadManager.thread(serverThread.id);
      thread.syncServerThread(serverThread);
      thread.applyServerStatus(serverThread.status ?? {});
      if (thread.state.status !== "idle") this.threadManager.trackBackgroundWork(serverThread.id);
      this.options.publishRendererState();
      return;
    }
    this.pendingThreadResumeId = locallyStarted ? undefined : serverThread.id;
    const preservePendingPrompt =
      !this.threadManager.hasSelectedThread() &&
      this.threadManager.activeThread.state.history.some((item) => item.role === "user");
    this.switchThread(serverThread.id, false, preservePendingPrompt);
    const thread = this.threadManager.thread(serverThread.id);
    thread.syncServerThread(serverThread);
    thread.applyServerStatus(serverThread.status ?? {});
    this.options.publishRendererState();
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
      this.options.publishRendererState();
      return;
    }
    thread.startTurn(turnId);
    this.options.publishRendererState();
  }

  /** Adds echoed user input and visible activity from a started item. */
  private handleItemStarted(
    message: Extract<ServerMessage, { method: "item/started" }>,
    thread: CodexThread,
  ): void {
    const threadId = message.params.threadId;
    thread.setStatus("working");
    this.options.publishRendererState();
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
      this.options.publishRendererState();
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
    this.options.publishRendererState();
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
      this.options.publishRendererState();
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
      this.options.publishRendererState();
    }
  }

  /** Stores the model selected after an app-server reroute. */
  private handleModelRerouted(
    message: Extract<ServerMessage, { method: "model/rerouted" }>,
    thread: CodexThread,
  ): void {
    thread.mergeModelInfo({ model: message.params.toModel });
    this.options.publishRendererState();
  }

  /** Updates model metadata when thread settings change. */
  private handleThreadSettingsUpdated(
    message: Extract<ServerMessage, { method: "thread/settings/updated" }>,
    thread: CodexThread,
  ): void {
    const mode = message.params.threadSettings.collaborationMode?.mode;
    if (mode === "plan" || mode === "default") {
      thread.setCollaborationMode(mode);
    }
    if (isRecord(message.params.threadSettings)) {
      if (thread.mergeModelInfoFromServer(message.params.threadSettings)) {
        this.options.publishRendererState();
      }
    }
    this.options.publishRendererState();
  }

  /** Applies thread lifecycle changes and performs resume/reconcile work. */
  private handleThreadStatusChanged(
    message: Extract<ServerMessage, { method: "thread/status/changed" }>,
    thread: CodexThread,
  ): void {
    const { threadId, status } = message.params;
    const isSelected = this.threadManager.isSelected(threadId);
    const previous = thread.state.status;
    thread.applyServerStatus(status ?? {});
    if (!isSelected && thread.state.status !== "idle") {
      this.threadManager.trackBackgroundWork(threadId);
    }
    this.options.publishRendererState();
    if (isSelected && shouldReconcileOnIdle(previous, status, thread.state.needsReconcile)) {
      thread.markNeedsReconcile(false);
      this.read(threadId);
    }
    if (!isSelected) return;
    if (status?.type === "active" && this.pendingThreadResumeId === threadId) {
      this.pendingThreadResumeId = undefined;
      this.resume(threadId);
    } else if (shouldResumeOnActiveStatus(thread.state.connected, status)) {
      this.resume(threadId);
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
      this.options.publishStreamDelta?.({
        kind: "assistant",
        itemId: message.params.itemId,
        delta: message.params.delta,
      });
      return;
    }
    thread.appendAssistantDelta(message.params.delta, message.params.itemId, message.params.turnId);
    if (this.threadManager.isSelected(message.params.threadId)) {
      this.options.publishStreamDelta?.({
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
        this.options.publishStreamDelta?.({
          threadId: thread.id === "standalone" ? this.threadManager.selectedThreadId : thread.id,
          kind: "command",
          itemId: message.params.itemId,
          delta: message.params.delta,
        });
      }
    }
  }

  /** Stores a server request_user_input request for the renderer. */
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
    this.routeAttention(pending.threadId);
    if (!messageThreadId(message)) {
      this.options.handleNotification({
        event: "userInputRequested",
        threadId: pending.threadId,
        selectedThreadId: this.threadManager.selectedThreadId,
      });
    }
    this.options.publishRendererState();
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
        this.options.publishStreamDelta?.({
          threadId: messageThreadId(message),
          itemId: stringValue(item.id),
          kind: "assistant",
          delta: "",
          completed: true,
        });
      }
    }
    this.options.publishRendererState();
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
    this.routeAttention(message.params.threadId);
    if (!messageThreadId(message)) {
      this.options.handleNotification({
        event: "approvalRequested",
        threadId: message.params.threadId,
        selectedThreadId: this.threadManager.selectedThreadId,
        requestId: id,
        command,
        reason,
      });
    }
    thread.setStatus("waiting");
    this.options.publishRendererState();
  }

  private noteAttention(threadId: string, type: "approval" | "userInput"): void {
    this.threadManager.noteAttention(threadId, type);
  }

  private routeAttention(threadId: string): void {
    const nextThreadId = this.threadManager.nextAttention();
    if (
      typeof nextThreadId !== "string" ||
      this.threadManager.isSelected(nextThreadId) ||
      this.options.isChatVisible()
    ) {
      return;
    }
    this.switchThread(nextThreadId, false);
  }

  private clearAttention(threadId: string): void {
    this.threadManager.clearAttention(threadId);
  }

  private routeNextAttention(): void {
    const nextThreadId = this.threadManager.nextAttention();
    if (typeof nextThreadId === "string") this.routeAttention(nextThreadId);
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
          this.options.publishRendererState();
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
      this.options.publishRendererState();
    });
  }

  /** Appends base64-decoded output from a standalone command/exec request. */
  private handleExecOutputDelta(
    message: Extract<ServerMessage, { method: "command/exec/outputDelta" }>,
  ): void {
    const delta = Buffer.from(message.params.deltaBase64, "base64").toString();
    const thread = this.threadManager.execThreadMap.get(message.params.processId);
    if (thread) {
      thread.appendActivityOutput(message.params.processId, delta);
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
    if (this.threadManager.activeThread.mergeModelInfoFromServer(value)) {
      this.options.publishRendererState();
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
