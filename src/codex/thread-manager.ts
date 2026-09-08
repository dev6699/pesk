import type { Thread } from "../codex-schema/v2";
import { approvalOptions, CodexThread, parseTokenUsageValue } from "./thread";
import {
  approvalDecisions,
  isRecord,
  messageThreadId,
  requestIdKey,
  stringValue,
  type ServerMessage,
} from "./protocol";
import type { CodexStreamDelta, CodexThreadActivity, CodexThreadsSnapshot } from "./types";

const MAX_CACHED_THREADS = 16;

export interface HistoryPaginationState {
  nextCursor: string | null;
  loading: boolean;
  hasOlderHistory: boolean;
  paginated: boolean;
}

export interface ThreadEventResult {
  streamDelta?: CodexStreamDelta;
  completedStreamDelta?: CodexStreamDelta;
  queueRefresh?: string;
}

/** Owns local Codex thread instances and the state associated with each thread. */
export class CodexThreadManager {
  private readonly threadInstances = new Map<string, CodexThread>();
  private readonly threadAccess = new Map<string, number>();
  private readonly standalone = new CodexThread("standalone");
  private readonly execThreads = new Map<string, CodexThread>();
  private readonly readonlyThreadIds = new Set<string>();
  private readonly attentionQueue = new Map<string, "approval" | "userInput">();
  private readonly backgroundWork = new Map<string, "working" | "completed">();
  private readonly pagination = new Map<string, HistoryPaginationState>();
  private readonly pendingHistoryLoadIds = new Set<string>();
  private pendingThreadStarts = 0;
  private readonly locallyStartedThreads = new Set<string>();
  private pendingThreadResumeId: string | undefined;
  private publicationSuppression = 0;

  /** Server thread metadata in the controller's display order. */
  readonly threads: Thread[] = [];

  /** The ID of the currently selected thread. */
  private selectedId: string | undefined;

  /** Captures collection and current-conversation state without exposing the cache. */
  snapshot(): CodexThreadsSnapshot {
    const pagination = this.selectedHistoryState();
    return {
      items: structuredClone(this.threads),
      activities: this.getThreadActivities(),
      backgroundWork: this.backgroundWorkSnapshot(),
      selectedId: this.selectedId,
      current: {
        thread: this.activeThread.snapshot(),
        readOnly: this.selectedIsReadOnly(),
        history: {
          loading: Boolean(pagination?.loading || this.selectedHistoryIsLoading()),
          hasOlder: pagination?.hasOlderHistory ?? false,
        },
      },
    };
  }

  /** Returns the ID of the currently selected thread. */
  get selectedThreadId(): string | undefined {
    return this.selectedId;
  }

  /** Compatibility setter for existing integrations; prefer select() internally. */
  set selectedThreadId(threadId: string | undefined) {
    this.select(threadId);
  }

  /** Whether background-thread updates should be hidden from publication. */
  get isPublicationSuppressed(): boolean {
    return this.publicationSuppression > 0;
  }

  /** Returns the selected thread, or the standalone thread before selection. */
  get activeThread(): CodexThread {
    return this.selectedThread();
  }

  /** Returns the selected thread, or the standalone thread when no thread is selected. */
  selectedThread(): CodexThread {
    return this.selectedId ? this.thread(this.selectedId) : this.standalone;
  }

  /** Reports whether a thread is currently selected. */
  isSelected(threadId: string): boolean {
    return this.selectedId === threadId;
  }

  /** Reports whether a thread is currently selected. */
  hasSelectedThread(): boolean {
    return this.selectedId !== undefined;
  }

  /** Reports whether the selected thread is read-only. */
  selectedIsReadOnly(): boolean {
    return Boolean(this.selectedId && this.readonlyThreadIds.has(this.selectedId));
  }

  /** Reports whether history loading is active for the selected thread. */
  selectedHistoryIsLoading(): boolean {
    return Boolean(this.selectedId && this.pendingHistoryLoadIds.has(this.selectedId));
  }

  /** Preserves the selected thread's live history before a reload replaces its transport state. */
  captureSelectedHistoryForReload(): void {
    if (this.selectedId) this.thread(this.selectedId).captureLiveHistoryForReload();
  }

  /** Changes the selected thread without creating a thread instance. */
  select(threadId: string | undefined): void {
    this.selectedId = threadId;
  }

  /** Gets or creates the isolated local instance for a server thread ID. */
  thread(threadId: string): CodexThread {
    let thread = this.threadInstances.get(threadId);
    if (!thread) {
      thread = new CodexThread(threadId);
      this.threadInstances.set(threadId, thread);
    }
    this.threadAccess.delete(threadId);
    this.threadAccess.set(threadId, Date.now());
    this.evictInactiveThreads();
    return thread;
  }

  /** Reports whether a local instance has already been created for a thread ID. */
  hasThreadInstance(threadId: string): boolean {
    return this.threadInstances.has(threadId);
  }

  /** Runs work against a thread while suppressing publication for background threads. */
  withThread<T>(threadId: string, callback: (thread: CodexThread) => T): T {
    const thread = this.thread(threadId);
    if (this.selectedId === threadId) return callback(thread);
    this.publicationSuppression += 1;
    try {
      return callback(thread);
    } finally {
      this.publicationSuppression -= 1;
    }
  }

  /** Replaces the server thread metadata collection. */
  replaceThreads(threads: Thread[]): void {
    this.threads.splice(0, this.threads.length, ...threads);
  }

  /** Removes all server thread metadata. */
  clearThreads(): void {
    this.threads.length = 0;
  }

  /** Inserts or replaces one server thread while keeping it at the front of the list. */
  upsertThread(thread: Thread): void {
    this.replaceThreads([
      thread,
      ...this.threads.filter((candidate) => candidate.id !== thread.id),
    ]);
  }

  /** Updates one server thread without changing its current display position. */
  updateThread(thread: Thread): void {
    const index = this.threads.findIndex((candidate) => candidate.id === thread.id);
    if (index < 0) {
      this.threads.unshift(thread);
      return;
    }
    this.threads[index] = thread;
  }

  /** Removes one server thread from the metadata collection. */
  removeThread(threadId: string): void {
    this.replaceThreads(this.threads.filter((thread) => thread.id !== threadId));
  }

  /** Reports whether server metadata exists for a thread ID. */
  hasThread(threadId: string): boolean {
    return this.threads.some((thread) => thread.id === threadId);
  }

  /** Returns or creates pagination state for a thread's history. */
  historyState(threadId: string): HistoryPaginationState {
    let state = this.pagination.get(threadId);
    if (!state) {
      state = { nextCursor: null, loading: false, hasOlderHistory: false, paginated: false };
      this.pagination.set(threadId, state);
    }
    return state;
  }

  /** Returns pagination state for the selected thread, if one exists. */
  selectedHistoryState(): HistoryPaginationState | undefined {
    return this.selectedId ? this.historyState(this.selectedId) : undefined;
  }

  /** Marks a thread as awaiting history hydration. */
  markHistoryPending(threadId: string): void {
    this.pendingHistoryLoadIds.add(threadId);
  }

  /** Clears the history-hydration marker for a thread. */
  clearHistoryPending(threadId: string): void {
    this.pendingHistoryLoadIds.delete(threadId);
  }

  /** Starts one history page request and resets pagination when replacing history. */
  beginHistoryPage(threadId: string, replace: boolean): HistoryPaginationState | undefined {
    const state = this.historyState(threadId);
    if (state.loading) return undefined;
    state.loading = true;
    if (replace) {
      state.paginated = true;
      state.nextCursor = null;
      state.hasOlderHistory = false;
    }
    return state;
  }

  /** Applies a history page result and clears its pending hydration marker. */
  finishHistoryPage(threadId: string, nextCursor: string | null, hasResult: boolean): void {
    const state = this.historyState(threadId);
    state.loading = false;
    state.nextCursor = hasResult ? nextCursor : null;
    state.hasOlderHistory = hasResult && nextCursor !== null;
    this.clearHistoryPending(threadId);
  }

  /** Records a locally requested thread start and matches its response/event pair. */
  noteThreadStartRequest(): void {
    this.pendingThreadStarts += 1;
  }

  /** Correlates a thread/start response with its thread/started notification. */
  noteThreadStartResponse(threadId: string): void {
    if (this.locallyStartedThreads.delete(threadId)) return;
    this.pendingThreadStarts = Math.max(0, this.pendingThreadStarts - 1);
    this.locallyStartedThreads.add(threadId);
  }

  /** Consumes a thread/started notification belonging to a local start. */
  consumeLocalThreadStarted(threadId: string): boolean {
    if (this.locallyStartedThreads.delete(threadId)) return true;
    if (this.pendingThreadStarts > 0) {
      this.pendingThreadStarts -= 1;
      this.locallyStartedThreads.add(threadId);
      return true;
    }
    return false;
  }

  /** Tracks the thread whose active status should trigger resume. */
  setPendingResume(threadId: string | undefined): void {
    this.pendingThreadResumeId = threadId;
  }

  /** Reports whether a thread is awaiting active status before resume. */
  isPendingResume(threadId: string): boolean {
    return this.pendingThreadResumeId === threadId;
  }

  /** Clears pending resume when the expected thread becomes active. */
  consumePendingResume(threadId: string): boolean {
    if (!this.isPendingResume(threadId)) return false;
    this.pendingThreadResumeId = undefined;
    return true;
  }

  /** Removes stored pagination state for a thread. */
  deleteHistoryState(threadId: string): void {
    this.pagination.delete(threadId);
  }

  /** Marks a non-selected thread as having background work. */
  trackBackgroundWork(threadId: string): void {
    if (!this.backgroundWork.has(threadId)) this.backgroundWork.set(threadId, "working");
  }

  /** Marks background work complete while retaining its status. */
  completeBackgroundWork(threadId: string): void {
    if (threadId !== this.selectedThreadId) {
      this.trackBackgroundWork(threadId);
      this.backgroundWork.set(threadId, "completed");
    }
  }

  /** Clears the background-work marker for a thread. */
  clearBackgroundWork(threadId: string): void {
    this.backgroundWork.delete(threadId);
  }

  /** Reports whether a thread has retained background work. */
  hasBackgroundWork(threadId: string): boolean {
    return this.backgroundWork.has(threadId);
  }

  /** Returns counts of retained working and completed background threads. */
  backgroundWorkSnapshot(): { completed: number; total: number } {
    const values = [...this.backgroundWork.values()];
    return {
      completed: values.filter((status) => status === "completed").length,
      total: values.length,
    };
  }

  /** Records the first pending approval or input request for a thread. */
  noteAttention(threadId: string, type: "approval" | "userInput"): void {
    if (!this.attentionQueue.has(threadId)) this.attentionQueue.set(threadId, type);
  }

  /** Returns the next thread requiring user attention. */
  nextAttention(): string | undefined {
    return this.attentionQueue.keys().next().value;
  }

  /** Removes a thread from the attention queue once it has no pending request. */
  clearAttention(threadId: string): void {
    const thread = this.thread(threadId);
    if (!thread.state.pendingApproval && !thread.state.pendingUserInput) {
      this.attentionQueue.delete(threadId);
    }
  }

  /** Applies an item-started notification and normalizes its visible content. */
  handleItemStarted(
    message: Extract<ServerMessage, { method: "item/started" }>,
    thread: CodexThread,
  ): void {
    thread.setStatus("working");
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

  /** Applies a live thread token-usage update. */
  handleTokenUsageUpdated(
    message: Extract<ServerMessage, { method: "thread/tokenUsage/updated" }>,
    thread: CodexThread,
    ignoreUsage: boolean,
  ): boolean {
    if (ignoreUsage) return false;
    const usage = parseTokenUsageValue(message.params.tokenUsage);
    if (!usage) return false;
    thread.setTokenUsage(usage);
    return true;
  }

  /** Appends an assistant stream delta and returns selected-thread publication data. */
  handleAgentMessageDelta(
    message: Extract<ServerMessage, { method: "item/agentMessage/delta" }>,
    thread: CodexThread,
  ): ThreadEventResult {
    thread.appendAssistantDelta(message.params.delta, message.params.itemId, message.params.turnId);
    if (typeof message.params.threadId !== "string" || this.isSelected(thread.id)) {
      return {
        streamDelta: {
          ...(typeof message.params.threadId === "string"
            ? { threadId: message.params.threadId }
            : {}),
          kind: "assistant",
          itemId: message.params.itemId,
          delta: message.params.delta,
        },
      };
    }
    return {};
  }

  /** Appends command activity output and returns selected-thread publication data. */
  handleCommandOutputDelta(
    message: Extract<ServerMessage, { method: "item/commandExecution/outputDelta" }>,
    thread: CodexThread,
  ): ThreadEventResult {
    if (!this.selectedThreadId && thread.id === "standalone") return {};
    if (this.selectedThreadId && !this.isSelected(thread.id)) return {};
    thread.appendActivityOutput(message.params.itemId, message.params.delta);
    return {
      streamDelta: {
        threadId: thread.id === "standalone" ? this.selectedThreadId : thread.id,
        kind: "command",
        itemId: message.params.itemId,
        delta: message.params.delta,
      },
    };
  }

  /** Appends streamed plan text to its owning activity item. */
  handlePlanDelta(
    message: Extract<ServerMessage, { method: "item/plan/delta" }>,
    thread: CodexThread,
  ): void {
    thread.appendPlanDelta(message.params.itemId, message.params.delta);
  }

  /** Commits a completed item and returns an optional stream completion event. */
  handleItemCompleted(
    message: Extract<ServerMessage, { method: "item/completed" }>,
    thread: CodexThread,
  ): ThreadEventResult {
    const item = isRecord(message.params.item) ? message.params.item : undefined;
    if (!item) return {};
    thread.processCompletedItem(item);
    if (item.type !== "agentMessage") return {};
    return {
      completedStreamDelta: {
        threadId: messageThreadId(message),
        itemId: stringValue(item.id),
        kind: "assistant",
        delta: "",
        completed: true,
      },
    };
  }

  /** Stores a pending user-input request and records thread attention. */
  handleUserInputRequest(
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
  }

  /** Stores a pending approval request and records thread attention. */
  handleApprovalRequest(
    message: Extract<
      ServerMessage,
      { method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" }
    >,
    thread: CodexThread,
  ): void {
    const id = message.id;
    const decisions = approvalDecisions(message);
    const command = "command" in message.params ? (message.params.command ?? "") : "";
    const reason = message.params.reason ?? "";
    thread.addApproval(
      requestIdKey(id),
      { requestId: id, command, reason, decisions },
      { requestId: id, command, reason, options: approvalOptions(decisions) },
    );
    this.noteAttention(message.params.threadId, "approval");
    thread.setStatus("waiting");
  }

  /** Resolves a pending user-input request notification. */
  handleServerRequestResolved(
    message: Extract<ServerMessage, { method: "serverRequest/resolved" }>,
    thread: CodexThread,
  ): void {
    if (thread.state.pendingUserInput?.requestId !== message.params.requestId) return;
    const threadId = thread.state.pendingUserInput.threadId;
    thread.clearUserInput();
    this.clearAttention(threadId);
  }

  /** Appends standalone command output to the thread owning its process. */
  handleExecOutputDelta(
    message: Extract<ServerMessage, { method: "command/exec/outputDelta" }>,
  ): boolean {
    const thread = this.execThread(message.params.processId);
    if (!thread) return false;
    thread.appendActivityOutput(
      message.params.processId,
      Buffer.from(message.params.deltaBase64, "base64").toString(),
    );
    return true;
  }

  /** Marks or clears app-server ownership state for a thread. */
  setReadOnly(threadId: string, readOnly: boolean): void {
    if (readOnly) this.readonlyThreadIds.add(threadId);
    else this.readonlyThreadIds.delete(threadId);
  }

  /** Associates an exec process with its owning thread. */
  trackExecProcess(processId: string, thread: CodexThread): void {
    this.execThreads.set(processId, thread);
  }

  /** Returns the thread that owns an exec process. */
  execThread(processId: string): CodexThread | undefined {
    return this.execThreads.get(processId);
  }

  /** Removes an exec process ownership mapping. */
  clearExecProcess(processId: string): void {
    this.execThreads.delete(processId);
  }

  /** Removes all local state associated with a thread. */
  remove(threadId: string): void {
    this.threadInstances.delete(threadId);
    this.backgroundWork.delete(threadId);
    this.threadAccess.delete(threadId);
    this.pagination.delete(threadId);
    this.pendingHistoryLoadIds.delete(threadId);
    this.readonlyThreadIds.delete(threadId);
    this.attentionQueue.delete(threadId);
    for (const [processId, thread] of this.execThreads) {
      if (thread.id === threadId) this.execThreads.delete(processId);
    }
  }

  /** Clears transport-scoped state while preserving the manager instance. */
  clearTransportState(): void {
    this.threadInstances.clear();
    this.backgroundWork.clear();
    this.threadAccess.clear();
    this.pagination.clear();
    this.pendingHistoryLoadIds.clear();
    this.readonlyThreadIds.clear();
    this.attentionQueue.clear();
    this.selectedId = undefined;
    this.pendingThreadStarts = 0;
    this.locallyStartedThreads.clear();
    this.pendingThreadResumeId = undefined;
    this.execThreads.clear();
    this.publicationSuppression = 0;
    this.standalone.resetTransportState();
  }

  /** Clears cached local instances without clearing server thread metadata. */
  clearThreadInstances(): void {
    this.threadInstances.clear();
    this.threadAccess.clear();
  }

  /** The standalone thread used for protocol messages without a thread ID. */
  get standaloneThread(): CodexThread {
    return this.standalone;
  }

  /** Exposes local instances for compatibility with controller/test inspection. */
  getThreadMap(): Map<string, CodexThread> {
    return this.threadInstances;
  }

  /** Builds thread activity summaries from server metadata and local state. */
  getThreadActivities(): CodexThreadActivity[] {
    const known = new Map<string, Thread | undefined>(
      this.threads.map((thread) => [thread.id, thread]),
    );
    for (const id of this.threadInstances.keys()) {
      if (!known.has(id)) known.set(id, undefined);
    }
    return [...known.entries()].map(([threadId, serverThread]) => {
      const thread = this.threadInstances.get(threadId);
      const attention = thread?.state.pendingUserInput
        ? "userInput"
        : thread?.state.pendingApproval
          ? "approval"
          : undefined;
      return {
        threadId,
        preview: serverThread?.preview ?? threadId,
        status: thread?.state.status ?? "idle",
        workingSince: thread?.state.workingSince,
        attention,
      };
    });
  }

  /** Releases inactive loaded histories while retaining active thread state. */
  private evictInactiveThreads(): void {
    if (this.threadInstances.size <= MAX_CACHED_THREADS) return;
    for (const [threadId] of this.threadAccess) {
      if (this.threadInstances.size <= MAX_CACHED_THREADS) return;
      if (threadId === this.selectedId) continue;
      const thread = this.threadInstances.get(threadId);
      if (
        !thread ||
        thread.state.status !== "idle" ||
        thread.state.pendingApproval ||
        thread.state.pendingUserInput
      ) {
        continue;
      }
      this.threadInstances.delete(threadId);
      this.threadAccess.delete(threadId);
      this.pagination.delete(threadId);
      this.pendingHistoryLoadIds.delete(threadId);
      this.readonlyThreadIds.delete(threadId);
      this.attentionQueue.delete(threadId);
    }
  }
}
