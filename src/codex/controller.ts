import type {
  ClientNotification,
  FuzzyFileSearchResult,
  InitializeResponse,
  RequestId,
} from "../codex-schema";
import { messageThreadId } from "./protocol";
import type {
  InitializeRequest,
  OutgoingMessage,
  JsonRpcResponse,
  OutgoingRequestInput,
  ServerMessage,
} from "./protocol";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
} from "../codex-schema/v2";
import { CodexGoalManager } from "./goal";
import { CodexInteraction } from "./interaction";
import { CodexModelManager } from "./model";
import { CodexProjectManager } from "./projects";
import { CodexQueueManager } from "./queue";
import { CodexRateLimitManager } from "./rate-limits";
import { CodexThread } from "./thread";
import { CodexThreadLifecycle } from "./thread-lifecycle";
import { CodexThreadManager } from "./thread-manager";
import { CodexTurnManager } from "./turn";
import type { CodexState, CodexStreamDelta } from "./types";
import { parsePrompt, type PromptImages } from "./prompt";
import { CodexWebSocketTransport, type CodexSocketTransport } from "./websocket";
import { DynamicToolApprovalManager } from "./dynamic-tools";

export interface CodexControllerOptions {
  onStateChanged: (state: CodexState) => void;
  onStreamDelta?: (delta: CodexStreamDelta) => void;
  onAttention: (event: CodexAttentionEvent) => void;
  onAttentionCleared?: () => void;
  debug: (...values: unknown[]) => void;
  onDynamicToolCall?: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  dynamicTools?: DynamicToolSpec[];
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
  private readonly options: CodexControllerOptions;
  private readonly socket: CodexSocketTransport;

  /** Human-readable transport error exposed through the Codex state. */
  private connectionError: string | undefined;
  private initialized = false;
  /** Monotonic JSON-RPC request id for this controller instance. */
  private nextId = 0;
  /** True while /new is replacing the selected thread. */
  private startingNewThread = false;

  private readonly threadManager = new CodexThreadManager();
  private readonly projectManager: CodexProjectManager;
  private readonly modelManager: CodexModelManager;
  private readonly goalManager: CodexGoalManager;
  private readonly lifecycle: CodexThreadLifecycle;
  private readonly interaction: CodexInteraction;
  private readonly queueManager: CodexQueueManager;
  private readonly rateLimitManager: CodexRateLimitManager;
  private readonly turnManager: CodexTurnManager;
  private readonly dynamicApprovals: DynamicToolApprovalManager;

  /** Creates a controller with application-level event callbacks. */
  constructor(
    options: CodexControllerOptions,
    socket: CodexSocketTransport = new CodexWebSocketTransport(),
  ) {
    this.options = options;
    this.socket = socket;
    this.dynamicApprovals = new DynamicToolApprovalManager({
      threadManager: this.threadManager,
      notifyStateChanged: () => this.notifyStateChanged(),
      onAttentionCleared: options.onAttentionCleared,
    });
    this.queueManager = new CodexQueueManager({
      request: (request, callback) => this.request(request, callback),
      threadManager: this.threadManager,
      onStateChanged: () => this.notifyStateChanged(),
    });
    this.rateLimitManager = new CodexRateLimitManager({
      request: (request, callback) => this.request(request, callback),
      onStateChanged: () => this.notifyStateChanged(),
    });
    this.turnManager = new CodexTurnManager({
      threadManager: this.threadManager,
      request: (request, callback) => this.request(request, callback),
      onStateChanged: () => this.notifyStateChanged(),
    });
    this.projectManager = new CodexProjectManager({
      request: (request, callback) => this.request(request, callback),
      onStateChanged: () => this.notifyStateChanged(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
      setConnectionError: (error) => {
        this.connectionError = error;
      },
    });
    this.modelManager = new CodexModelManager({
      request: (request, callback) => this.request(request, callback),
      getSelectedThreadId: () => this.threadManager.selectedThreadId,
      onStateChanged: () => this.notifyStateChanged(),
      setCommandNotice: (notice) => this.threadManager.activeThread.setCommandNotice(notice),
    });
    this.goalManager = new CodexGoalManager({
      request: (request, callback) => this.request(request, callback),
      setGoal: (threadId, goal) =>
        this.threadManager.withThread(threadId, (targetThread) => targetThread.setGoal(goal)),
      onStateChanged: () => this.notifyStateChanged(),
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
      onStateChanged: () => this.notifyStateChanged(),
      onThreadHydrated: (threadId) => {
        this.queueManager.refresh(threadId);
        this.goalManager.restore(threadId);
      },
      cancelModelPicker: () => this.modelManager.cancel(),
      setStarting: (value) => {
        this.startingNewThread = value;
      },
      startTurn: (threadId, prompt) => this.turnManager.start(threadId, prompt),
      dynamicTools: options.dynamicTools,
    });
    this.interaction = new CodexInteraction({
      threadManager: this.threadManager,
      lifecycle: this.lifecycle,
      request: (request, callback) => this.request(request, callback),
      requestWithId: (buildRequest, callback) => this.requestWithId(buildRequest, callback),
      sendResponse: (id, result) => this.sendResponse(id, result),
      startTurn: (threadId, prompt, extraInput) =>
        this.turnManager.start(threadId, prompt, extraInput),
      onChanged: () => this.notifyStateChanged(),
      clearAttention: (threadId) => this.threadManager.clearAttention(threadId),
      onAttentionCleared: options.onAttentionCleared,
    });
    this.socket
      .on("open", () => this.handleSocketOpen())
      .on("message", (message) => this.handleServerMessage(message))
      .on("close", (event) => this.handleSocketClose(event))
      .on("error", (details) => this.handleSocketError(details))
      .on("debug", (values) => this.options.debug(...values));
  }

  /** Publishes the current state unless background work is suppressed. */
  private notifyStateChanged(): void {
    if (!this.threadManager.isPublicationSuppressed) this.options.onStateChanged(this.getState());
  }

  /** Publishes an attention event unless the target update is suppressed. */
  private notifyAttention(event: CodexAttentionEvent): void {
    if (!this.threadManager.isPublicationSuppressed) this.options.onAttention(event);
  }

  /** Returns the current Codex state snapshot for application consumers. */
  getState(): CodexState {
    return {
      connection: {
        status: this.isOpen() ? (this.initialized ? "ready" : "connecting") : "disconnected",
        error: this.connectionError,
      },
      account: { rateLimits: this.rateLimitManager.getSnapshot() },
      threads: this.threadManager.snapshot(),
      projects: this.projectManager.snapshot(),
      modelPicker: this.modelManager.getPicker(),
    };
  }

  /** Starts the Codex app-server transport and its reconnect loop. */
  start(): void {
    this.socket.start();
  }

  /** Stops the Codex app-server transport and its reconnect loop. */
  stop(): void {
    this.socket.stop();
  }

  /** Reports whether the underlying transport is currently writable. */
  private isOpen(): boolean {
    return this.socket.isOpen();
  }

  /** Sends one already-identified protocol message through the transport. */
  private send(message: OutgoingMessage): void {
    this.socket.send(message);
  }

  /** Answers an app-server request while the initialized transport is available. */
  private sendResponse(id: RequestId, result: unknown): boolean {
    if (!this.initialized || !this.isOpen()) return false;
    this.send({ id, result } as JsonRpcResponse<unknown>);
    return true;
  }

  /** Registers a response callback for one transport request ID. */
  private setRequest<TResult>(
    id: number,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): void {
    this.socket.setRequest(id, callback);
  }

  /** Sends a request after assigning its JSON-RPC ID and response callback. */
  private request<TResult>(
    request: OutgoingRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): boolean {
    return this.requestWithId(() => request, callback);
  }

  /** Sends a request whose builder needs the assigned JSON-RPC ID. */
  private requestWithId<TResult>(
    buildRequest: (id: number) => OutgoingRequestInput,
    callback: (message: JsonRpcResponse<TResult>) => void,
  ): boolean {
    if (!this.initialized || !this.isOpen()) return false;
    const id = ++this.nextId;
    this.setRequest<TResult>(id, callback);
    this.send({ ...buildRequest(id), id } as never);
    return true;
  }

  /** Starts the model picker for the currently selected thread. */
  private beginModelPicker(): boolean {
    return this.modelManager.begin();
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

  /** Loads the next older persisted history page for the selected thread. */
  loadOlderHistory(): Promise<boolean> {
    return this.lifecycle.loadOlderHistory();
  }

  /** Lists authoritative projects, optionally appending a server cursor page. */
  listProjects(cursor: string | null = null): Promise<boolean> {
    return this.projectManager.listProjects(cursor);
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

  /** Applies a model and reasoning effort selected in the model picker. */
  selectModel(model: string, effort: string): void {
    this.modelManager.select(model, effort);
  }

  /** Cancels the active model picker. */
  cancelModelPicker(): void {
    this.modelManager.cancel();
  }

  /** Selects the collaboration mode used for the next turn. */
  setCollaborationMode(mode: "default" | "plan"): void {
    this.interaction.setCollaborationMode(mode);
  }

  /** Handles the native /goal command and its lifecycle controls. */
  manageGoal(command: string): boolean {
    const thread = this.threadManager.activeThread;
    return this.goalManager.manage(this.threadManager.selectedThreadId, thread.state.goal, command);
  }

  /** Starts implementation from a completed plan confirmation. */
  implementPlan(planText: string, clearContext: boolean): boolean {
    return this.interaction.implementPlan(planText, clearContext);
  }

  /** Answers an app-server request_user_input request. */
  respondUserInput(answers: Record<string, string[]>): boolean {
    return this.interaction.respondUserInput(answers);
  }

  /** Requests the complete account-wide rate-limit snapshot. */
  refreshRateLimits(): void {
    this.rateLimitManager.refresh();
  }

  /** Searches files below the requested roots for application consumers. */
  fuzzyFileSearch(query: string, roots: string[]): Promise<FuzzyFileSearchResult[]> {
    return this.interaction.fuzzyFileSearch(query, roots);
  }

  /** Requests cancellation of the currently running turn. */
  interruptTurn(): boolean {
    return this.interaction.interruptTurn();
  }

  /** Starts an inline custom review on the selected thread. */
  startReview(instructions: string): boolean {
    return this.interaction.startReview(instructions);
  }

  /** Steers the active turn, falling back to queueing when its ID is stale. */
  steerPrompt(value: string): boolean {
    return this.interaction.steerPrompt(value);
  }

  /** Parses and submits a prompt without image attachments. */
  submitPrompt(value: string): boolean {
    return this.submitPromptWithImages(value, []);
  }

  /** Parses and submits a prompt with optional image attachments. */
  submitPromptWithImages(value: string, images: PromptImages): boolean {
    if ((!value.trim() && !images.length) || !this.initialized) return false;
    const parsed = parsePrompt(value, images);
    const thread = this.threadManager.activeThread;
    thread.setCommandNotice(undefined);
    switch (parsed.kind) {
      case "model":
        return this.beginModelPicker();
      case "goal":
        return this.manageGoal(parsed.command);
      case "project":
        return this.projectManager.manageProject(parsed.command);
      default:
        return this.interaction.submitPrompt(parsed);
    }
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
    if (this.dynamicApprovals.respond(requestId, optionId)) return;
    this.interaction.respondPermission(requestId, optionId);
  }

  /** Blocks a dynamic tool call behind Pesk's normal approval renderer. */
  requestDynamicApproval(
    threadId: string,
    callId: string,
    command: string,
    reason: string,
  ): Promise<boolean> {
    return this.dynamicApprovals.request(threadId, callId, command, reason);
  }

  /** Initializes the app-server session after the transport opens. */
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
      this.projectManager.scheduleRefresh();
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

  /** Records a transport error for state consumers. */
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
      this.threadManager.standaloneThread.replaceHistory(selectedThread.snapshot().messages);
    }
    this.initialized = false;
    this.rateLimitManager.resetTransportState();
    selectedThread.resetTransportState();
    this.threadManager.select(undefined);
    this.threadManager.clearThreads();
    this.projectManager.reset();
    this.threadManager.clearTransportState();
    selectedThread.setStatus("idle");
    this.notifyStateChanged();
  }

  /** Routes a thread-scoped event into the owning thread. */
  /** Routes an inbound protocol message to its owning thread and manager. */
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

  /** Dispatches one inbound message to the manager that owns its domain. */
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
        this.queueManager.refresh(message.params.threadId);
        break;
      case "project/changed":
        this.projectManager.scheduleRefresh();
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
        this.turnManager.handleStarted(message, thread);
        this.notifyStateChanged();
        break;
      case "item/started":
        this.threadManager.handleItemStarted(message, thread);
        this.notifyStateChanged();
        break;
      case "turn/completed": {
        const result = this.turnManager.handleCompleted(message, thread, this.startingNewThread);
        this.notifyStateChanged();
        if (result.queueRefresh) this.queueManager.refresh(result.queueRefresh);
        break;
      }
      case "thread/tokenUsage/updated":
        if (this.threadManager.handleTokenUsageUpdated(message, thread, this.startingNewThread)) {
          this.notifyStateChanged();
        }
        break;
      case "account/rateLimits/updated":
        this.rateLimitManager.handleUpdated(message.params.rateLimits);
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
        {
          const result = this.threadManager.handleAgentMessageDelta(message, thread);
          if (result.streamDelta) this.options.onStreamDelta?.(result.streamDelta);
        }
        break;
      case "item/plan/delta":
        this.threadManager.handlePlanDelta(message, thread);
        this.notifyStateChanged();
        break;
      case "item/commandExecution/outputDelta":
        {
          const result = this.threadManager.handleCommandOutputDelta(message, thread);
          if (result.streamDelta) this.options.onStreamDelta?.(result.streamDelta);
        }
        break;
      case "command/exec/outputDelta":
        if (this.threadManager.handleExecOutputDelta(message)) this.notifyStateChanged();
        break;
      case "item/completed": {
        const result = this.threadManager.handleItemCompleted(message, thread);
        this.notifyStateChanged();
        if (result.completedStreamDelta) {
          this.options.onStreamDelta?.(result.completedStreamDelta);
        }
        break;
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.threadManager.handleApprovalRequest(message, thread);
        this.notifyStateChanged();
        if (!messageThreadId(message)) {
          this.notifyAttention({
            event: "approvalRequested",
            threadId: message.params.threadId,
            selectedThreadId: this.threadManager.selectedThreadId,
            requestId: message.id,
            command: "command" in message.params ? (message.params.command ?? "") : "",
            reason: message.params.reason ?? "",
          });
        }
        break;
      case "item/tool/requestUserInput":
        this.threadManager.handleUserInputRequest(message, thread);
        this.notifyStateChanged();
        if (!messageThreadId(message)) {
          this.notifyAttention({
            event: "userInputRequested",
            threadId: message.params.threadId,
            selectedThreadId: this.threadManager.selectedThreadId,
          });
        }
        break;
      case "item/tool/call":
        void (
          this.options.onDynamicToolCall
            ? this.options.onDynamicToolCall(message.params)
            : Promise.resolve({
                contentItems: [
                  { type: "inputText" as const, text: "Terminal tools are unavailable." },
                ],
                success: false,
              })
        )
          .then((result) => this.sendResponse(message.id, result))
          .catch((error: unknown) =>
            this.sendResponse(message.id, {
              contentItems: [{ type: "inputText", text: `Terminal tool failed: ${String(error)}` }],
              success: false,
            }),
          );
        break;
      case "serverRequest/resolved":
        this.threadManager.handleServerRequestResolved(message, thread);
        this.notifyStateChanged();
        break;
    }
  }
}
