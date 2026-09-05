import type { Thread } from "../codex-schema/v2";
import { CodexThread } from "./thread";
import type { CodexThreadActivity } from "./types";

const MAX_CACHED_THREADS = 16;

export interface HistoryPaginationState {
  nextCursor: string | null;
  loading: boolean;
  hasOlderHistory: boolean;
  paginated: boolean;
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
  private publicationSuppression = 0;

  /** Server thread metadata in renderer display order. */
  readonly threads: Thread[] = [];

  /** The thread currently selected by the renderer. */
  selectedThreadId: string | undefined;

  /** Whether background-thread updates should be hidden from renderer publication. */
  get isPublicationSuppressed(): boolean {
    return this.publicationSuppression > 0;
  }

  /** Returns the selected thread, or the standalone thread before selection. */
  get activeThread(): CodexThread {
    return this.selectedThread();
  }

  /** Returns the selected thread, or the standalone thread when no thread is selected. */
  selectedThread(): CodexThread {
    return this.selectedThreadId ? this.thread(this.selectedThreadId) : this.standalone;
  }

  /** Reports whether a thread is currently selected. */
  isSelected(threadId: string): boolean {
    return this.selectedThreadId === threadId;
  }

  /** Reports whether the renderer currently has a selected thread. */
  hasSelectedThread(): boolean {
    return this.selectedThreadId !== undefined;
  }

  /** Reports whether the selected thread is read-only. */
  selectedIsReadOnly(): boolean {
    return Boolean(this.selectedThreadId && this.readonlyThreadIds.has(this.selectedThreadId));
  }

  /** Reports whether history loading is active for the selected thread. */
  selectedHistoryIsLoading(): boolean {
    return Boolean(this.selectedThreadId && this.pendingHistoryLoadIds.has(this.selectedThreadId));
  }

  /** Preserves the selected thread's live history before a reload replaces its transport state. */
  captureSelectedHistoryForReload(): void {
    if (this.selectedThreadId) this.thread(this.selectedThreadId).captureLiveHistoryForReload();
  }

  /** Changes the renderer's selected thread without creating a thread instance. */
  select(threadId: string | undefined): void {
    this.selectedThreadId = threadId;
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

  /** Runs work against a thread while suppressing renderer publication for background threads. */
  withThread<T>(threadId: string, callback: (thread: CodexThread) => T): T {
    const thread = this.thread(threadId);
    if (this.selectedThreadId === threadId) return callback(thread);
    this.publicationSuppression += 1;
    try {
      return callback(thread);
    } finally {
      this.publicationSuppression -= 1;
    }
  }

  /** Replaces the server thread metadata shown by the renderer. */
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

  /** Removes one server thread from the renderer metadata list. */
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
    return this.selectedThreadId ? this.historyState(this.selectedThreadId) : undefined;
  }

  /** Thread IDs whose history request is currently pending. */
  get pendingHistoryLoads(): Set<string> {
    return this.pendingHistoryLoadIds;
  }

  /** Removes stored pagination state for a thread. */
  deleteHistoryState(threadId: string): void {
    this.pagination.delete(threadId);
  }

  /** Marks a non-selected thread as having background work. */
  trackBackgroundWork(threadId: string): void {
    if (!this.backgroundWork.has(threadId)) this.backgroundWork.set(threadId, "working");
  }

  /** Marks background work complete while retaining it for the renderer summary. */
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

  /** Removes all local state associated with a thread. */
  remove(threadId: string): void {
    this.threadInstances.delete(threadId);
    this.backgroundWork.delete(threadId);
    this.threadAccess.delete(threadId);
    this.pagination.delete(threadId);
    this.pendingHistoryLoadIds.delete(threadId);
    this.readonlyThreadIds.delete(threadId);
    this.attentionQueue.delete(threadId);
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
    this.selectedThreadId = undefined;
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

  /** Maps exec process IDs to the threads that started them. */
  get execThreadMap(): Map<string, CodexThread> {
    return this.execThreads;
  }

  /** Thread IDs currently marked read-only by the app server. */
  get readOnlyThreadIds(): Set<string> {
    return this.readonlyThreadIds;
  }

  /** Exposes local instances for compatibility with controller/test inspection. */
  getThreadMap(): Map<string, CodexThread> {
    return this.threadInstances;
  }

  /** Builds renderer activity summaries from server metadata and local state. */
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
      if (threadId === this.selectedThreadId) continue;
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
