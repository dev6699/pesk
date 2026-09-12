import type {
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
  ThreadArchiveResponse,
  ThreadDeleteResponse,
  ThreadForkResponse,
  ThreadStartResponse,
  ThreadCompactStartResponse,
  DynamicToolSpec,
} from "../codex-schema/v2";
import type {
  JsonRpcResponse,
  ProjectThreadStartRequest,
  ServerMessage,
  ThreadArchiveRequest,
  ThreadDeleteRequest,
  ThreadForkRequest,
  ThreadListRequest,
  ThreadReadRequest,
  ThreadResumeRequest,
  ThreadStartRequestWithTools,
  ThreadTurnsListRequest,
  ThreadCompactStartRequest,
} from "./protocol";
import { isThread, shouldResumeOnActiveStatus } from "./protocol";
import { CodexThreadManager } from "./thread-manager";
import { CodexThread } from "./thread";
import { CodexProjectManager, validProjectId, validProjectRoots } from "./projects";

const HISTORY_PAGE_LIMIT = 5;

type WithoutRequestId<T extends { id: unknown }> = Omit<T, "id">;
export type ThreadLifecycleRequestInput =
  | WithoutRequestId<ThreadListRequest>
  | WithoutRequestId<ThreadReadRequest>
  | WithoutRequestId<ThreadResumeRequest>
  | WithoutRequestId<ThreadTurnsListRequest>
  | WithoutRequestId<ThreadArchiveRequest>
  | WithoutRequestId<ThreadDeleteRequest>
  | WithoutRequestId<ThreadForkRequest>
  | WithoutRequestId<ThreadCompactStartRequest>
  | WithoutRequestId<ThreadStartRequestWithTools>
  | WithoutRequestId<ProjectThreadStartRequest>;

export interface ThreadLifecycleDependencies {
  threadManager: CodexThreadManager;
  projectManager: CodexProjectManager;
  dynamicTools?: DynamicToolSpec[];
  request: <T>(
    message: ThreadLifecycleRequestInput,
    callback: (message: JsonRpcResponse<T>) => void,
  ) => boolean;
  onStateChanged: () => void;
  onThreadHydrated: (threadId: string) => void;
  cancelModelPicker: () => void;
  setStarting: (value: boolean) => void;
  startTurn: (threadId: string, prompt: string) => void;
}

/**
 * Coordinates server-backed thread lifecycle operations.
 *
 * This service owns discovery, selection, hydration, history pagination, and
 * thread creation/archive/delete/fork flows. The controller remains responsible
 * for transport, turn execution, and application orchestration; lifecycle
 * callbacks are limited to those integration points.
 */
export class CodexThreadLifecycle {
  private discoveryPending = false;
  private readonly dynamicTools: DynamicToolSpec[];

  /** Creates a lifecycle coordinator with its manager and integration hooks. */
  constructor(private readonly deps: ThreadLifecycleDependencies) {
    this.dynamicTools = deps.dynamicTools ?? [];
  }

  /** Sends a typed lifecycle request through the controller-owned transport. */
  private request<T>(
    message: ThreadLifecycleRequestInput,
    callback: (message: JsonRpcResponse<T>) => void,
  ): boolean {
    return this.deps.request(message, callback);
  }

  /** Applies model metadata returned by a thread operation to the local thread. */
  private updateModelInfo<T>(message: JsonRpcResponse<T>, thread: CodexThread): void {
    const result = message.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    let changed = thread.mergeModelInfoFromServer(result as Record<string, unknown>);
    const nestedThread = (result as Record<string, unknown>).thread;
    if (nestedThread && typeof nestedThread === "object" && !Array.isArray(nestedThread)) {
      changed = thread.mergeModelInfoFromServer(nestedThread as Record<string, unknown>) || changed;
    }
    if (changed) this.deps.onStateChanged();
  }

  /** Clears request guards that are scoped to the current transport connection. */
  resetTransportState(): void {
    this.discoveryPending = false;
  }

  /** Discovers recent server threads and selects the most recent one. */
  discover(): void {
    if (this.discoveryPending) return;
    this.discoveryPending = true;
    const accepted = this.request<ThreadListResponse>(
      {
        method: "thread/list",
        params: { limit: 20, sortKey: "recency_at", sortDirection: "desc" },
      },
      (message) => {
        this.discoveryPending = false;
        const threads = (message.result?.data ?? []).filter(isThread);
        this.deps.threadManager.replaceThreads(threads);
        for (const serverThread of threads) {
          const thread = this.deps.threadManager.thread(serverThread.id);
          thread.syncServerThread(serverThread);
          thread.applyServerStatus(serverThread.status ?? {});
          if (thread.state.status !== "idle")
            this.deps.threadManager.trackBackgroundWork(serverThread.id);
        }
        if (!threads.length) {
          this.deps.threadManager.select(undefined);
          this.deps.threadManager.standaloneThread.clearConversation();
        }
        this.deps.onStateChanged();
        if (threads[0]) this.select(threads[0].id);
      },
    );
    if (!accepted) this.discoveryPending = false;
  }

  /** Selects a thread, optionally resuming it and loading its history. */
  select(id: string, resume = true, preserveHistory = false): void {
    if (
      !id ||
      (this.deps.threadManager.threads.length > 0 && !this.deps.threadManager.hasThread(id))
    )
      return;
    const previous = this.deps.threadManager.selectedThreadId;
    if (previous !== id) {
      this.deps.cancelModelPicker();
      if (previous && this.deps.threadManager.thread(previous).state.status !== "idle") {
        this.deps.threadManager.trackBackgroundWork(previous);
      }
    }
    this.deps.threadManager.clearBackgroundWork(id);
    if (this.deps.threadManager.isSelected(id)) {
      if (resume && !this.deps.threadManager.activeThread.state.connected) {
        this.deps.threadManager.markHistoryPending(id);
        this.resume(id);
      }
      this.deps.onStateChanged();
      return;
    }
    if (!preserveHistory) this.deps.threadManager.captureSelectedHistoryForReload();
    const pending = preserveHistory
      ? this.deps.threadManager.activeThread.snapshot().messages
      : undefined;
    this.deps.threadManager.select(id);
    const existing = this.deps.threadManager.hasThreadInstance(id);
    if (!existing) this.deps.threadManager.thread(id).reset(preserveHistory ? (pending ?? []) : []);
    else if (!preserveHistory) this.deps.threadManager.thread(id).clearHistory();
    if (!preserveHistory) this.deps.threadManager.deleteHistoryState(id);
    if (resume || existing) this.deps.threadManager.markHistoryPending(id);
    this.deps.onStateChanged();
    if (resume) {
      if (existing && this.deps.threadManager.activeThread.state.connected) this.read(id);
      else this.resume(id);
    } else if (existing) this.read(id);
  }

  /** Loads the next older page of history for the selected thread. */
  loadOlderHistory(): Promise<boolean> {
    const id = this.deps.threadManager.selectedThreadId;
    if (!id) return Promise.resolve(false);
    const state = this.deps.threadManager.historyState(id);
    if (!state.paginated || state.loading || !state.hasOlderHistory) return Promise.resolve(false);
    return this.loadHistoryPage(id, state.nextCursor, false);
  }

  /** Resumes a thread through the app-server. */
  resumeThread(threadId: string): void {
    this.resume(threadId);
  }

  /** Reads a thread and refreshes its server state and history. */
  readThread(threadId: string): void {
    this.read(threadId);
  }

  /** Archives the currently selected thread. */
  archive(): boolean {
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!threadId) return false;
    return this.request<ThreadArchiveResponse>(
      {
        method: "thread/archive",
        params: { threadId },
      },
      () => undefined,
    );
  }

  /** Starts manual history compaction for the selected idle thread. */
  compact(): boolean {
    const threadId = this.deps.threadManager.selectedThreadId;
    const thread = this.deps.threadManager.activeThread;
    if (!threadId) {
      thread.setCommandNotice("No active thread to compact.");
      this.deps.onStateChanged();
      return false;
    }
    if (thread.state.status !== "idle") {
      thread.setCommandNotice("Wait for the current turn to finish before compacting.");
      this.deps.onStateChanged();
      return false;
    }
    const accepted = this.request<ThreadCompactStartResponse>(
      { method: "thread/compact/start", params: { threadId } },
      (message) => {
        if (message.error) {
          this.deps.threadManager.withThread(threadId, (targetThread) => {
            targetThread.setStatus("idle");
            targetThread.setCommandNotice("Unable to compact the current thread.");
          });
          this.deps.onStateChanged();
        }
      },
    );
    if (!accepted) return false;
    thread.setStatus("working");
    this.deps.onStateChanged();
    return true;
  }

  /** Deletes the currently selected thread. */
  delete(): boolean {
    const threadId = this.deps.threadManager.selectedThreadId;
    if (!threadId) return false;
    return this.request<ThreadDeleteResponse>(
      {
        method: "thread/delete",
        params: { threadId },
      },
      () => undefined,
    );
  }

  /** Forks the selected thread and switches to the new server thread. */
  fork(): boolean {
    const sourceThreadId = this.deps.threadManager.selectedThreadId;
    if (!sourceThreadId) return false;
    const mode = this.deps.threadManager.selectedThread().state.collaborationMode;
    return this.request<ThreadForkResponse>(
      {
        method: "thread/fork",
        params: { threadId: sourceThreadId, excludeTurns: true },
      },
      (message) => {
        const serverThread = message.result?.thread;
        if (typeof serverThread?.id !== "string") return;
        const thread = this.deps.threadManager.thread(serverThread.id);
        thread.reset([], serverThread.cwd ?? process.cwd());
        thread.setCollaborationMode(mode);
        thread.syncServerThread(serverThread);
        thread.applyServerStatus(serverThread.status ?? {});
        this.deps.threadManager.deleteHistoryState(serverThread.id);
        void this.loadHistoryPage(serverThread.id, null, true);
        thread.setConnected(true);
        this.deps.threadManager.upsertThread(serverThread);
        this.deps.threadManager.select(serverThread.id);
        this.deps.threadManager.setPendingResume(undefined);
        this.updateModelInfo(message, thread);
        thread.setCommandNotice(`Thread forked — switched to ${serverThread.id}`);
        this.deps.onStateChanged();
      },
    );
  }

  /** Starts a new standalone or project-independent thread. */
  startNew(workingDirectory: string | undefined, initialPrompt?: string): boolean {
    const initialThread = this.deps.threadManager.activeThread;
    const cwd = (workingDirectory ?? initialThread.state.workingDirectory ?? process.cwd()).trim();
    if (!cwd) return false;
    this.deps.setStarting(true);
    initialThread.setTokenUsage(undefined);
    this.deps.onStateChanged();
    return this.startRequest(cwd, undefined, initialPrompt);
  }

  /** Starts the initial thread while preserving any pending standalone history. */
  startInitial(onCreated: (thread: CodexThread) => void): boolean {
    const standalone = this.deps.threadManager.activeThread;
    if (standalone.state.status !== "idle") return false;
    const pendingHistory = standalone.snapshot().messages;
    this.deps.setStarting(true);
    this.deps.threadManager.noteThreadStartRequest();
    const accepted = this.request<ThreadStartResponse>(
      {
        method: "thread/start",
        params: {
          cwd: standalone.snapshot().workingDirectory ?? ".",
          serviceName: "pesk",
          dynamicTools: this.dynamicTools,
        },
      },
      (message) => {
        this.deps.setStarting(false);
        const serverThread = message.result?.thread;
        if (typeof serverThread?.id !== "string") return;
        this.deps.threadManager.noteThreadStartResponse(serverThread.id);
        this.deps.threadManager.select(serverThread.id);
        const thread = this.deps.threadManager.thread(serverThread.id);
        thread.reset(pendingHistory);
        thread.setConnected(true);
        thread.syncServerThread(serverThread);
        this.updateModelInfo(message, thread);
        this.deps.threadManager.upsertThread(serverThread);
        this.deps.onStateChanged();
        onCreated(thread);
      },
    );
    if (!accepted) this.deps.setStarting(false);
    return accepted;
  }

  /** Starts a shell thread while preserving any pending standalone history. */
  startShell(onCreated: (thread: CodexThread) => void): boolean {
    const standalone = this.deps.threadManager.activeThread;
    if (standalone.state.status !== "idle") return false;
    const pendingHistory = standalone.snapshot().messages;
    this.deps.setStarting(true);
    this.deps.threadManager.noteThreadStartRequest();
    const accepted = this.request<ThreadStartResponse>(
      {
        method: "thread/start",
        params: {
          cwd: standalone.snapshot().workingDirectory ?? ".",
          serviceName: "pesk",
          dynamicTools: this.dynamicTools,
        },
      },
      (message) => {
        this.deps.setStarting(false);
        const serverThread = message.result?.thread;
        if (typeof serverThread?.id !== "string") return;
        this.deps.threadManager.noteThreadStartResponse(serverThread.id);
        this.deps.threadManager.select(serverThread.id);
        const thread = this.deps.threadManager.thread(serverThread.id);
        thread.reset(pendingHistory);
        thread.setConnected(true);
        thread.syncServerThread(serverThread);
        this.updateModelInfo(message, thread);
        this.deps.threadManager.upsertThread(serverThread);
        this.deps.onStateChanged();
        onCreated(thread);
      },
    );
    if (!accepted) this.deps.setStarting(false);
    return accepted;
  }

  /** Validates a project root and starts a thread assigned to that project. */
  startProject(projectId: string, workingDirectory: string): boolean {
    const cwd = workingDirectory.trim();
    const initialThread = this.deps.threadManager.activeThread;
    const project = this.deps.projectManager.findProject(projectId);
    if (!validProjectId(projectId) || !validProjectRoots([{ path: cwd }])) {
      initialThread.setCommandNotice("Choose a valid project and absolute root.");
      this.deps.onStateChanged();
      return false;
    }
    if (!project || !project.roots.some((root) => root.path === cwd)) {
      initialThread.setCommandNotice("The selected root is not configured for that project.");
      this.deps.onStateChanged();
      return false;
    }
    this.deps.setStarting(true);
    initialThread.setTokenUsage(undefined);
    this.deps.onStateChanged();
    return this.startRequest(cwd, projectId, undefined);
  }

  /** Sends a thread/start request and hydrates the resulting local thread. */
  private startRequest(
    cwd: string,
    projectId: string | undefined,
    prompt: string | undefined,
  ): boolean {
    this.deps.threadManager.noteThreadStartRequest();
    const accepted = this.request<ThreadStartResponse>(
      {
        method: "thread/start",
        params: {
          ...(projectId ? { projectId } : {}),
          cwd,
          serviceName: "pesk",
          dynamicTools: this.dynamicTools,
        },
      },
      (message) => {
        this.deps.setStarting(false);
        const serverThread = message.result?.thread;
        if (typeof serverThread?.id !== "string") {
          this.deps.threadManager.activeThread.setCommandNotice(
            projectId
              ? typeof message.error === "string"
                ? message.error
                : "Unable to create project thread."
              : undefined,
          );
          this.deps.onStateChanged();
          return;
        }
        this.deps.threadManager.noteThreadStartResponse(serverThread.id);
        this.deps.threadManager.select(serverThread.id);
        const thread = this.deps.threadManager.thread(serverThread.id);
        thread.reset([], cwd);
        if (projectId) thread.setProjectId(projectId);
        thread.setConnected(true);
        thread.syncServerThread(serverThread);
        this.updateModelInfo(message, thread);
        this.deps.threadManager.upsertThread(serverThread);
        this.deps.onStateChanged();
        if (prompt) {
          thread.addUserMessage(prompt);
          thread.rememberPrompt(prompt);
          this.deps.onStateChanged();
          this.deps.startTurn(thread.id, prompt);
        }
      },
    );
    if (!accepted) this.deps.setStarting(false);
    return accepted;
  }

  /** Handles a server notification announcing a newly created thread. */
  handleThreadStarted(message: Extract<ServerMessage, { method: "thread/started" }>): void {
    const serverThread = message.params.thread;
    this.deps.threadManager.upsertThread(serverThread);
    const locallyStarted = this.deps.threadManager.consumeLocalThreadStarted(serverThread.id);
    const shouldSelect =
      locallyStarted || !this.deps.threadManager.hasSelectedThread() || !serverThread.status;
    if (!shouldSelect) {
      const thread = this.deps.threadManager.thread(serverThread.id);
      thread.syncServerThread(serverThread);
      thread.applyServerStatus(serverThread.status ?? {});
      if (thread.state.status !== "idle")
        this.deps.threadManager.trackBackgroundWork(serverThread.id);
      this.deps.onStateChanged();
      return;
    }
    this.deps.threadManager.setPendingResume(locallyStarted ? undefined : serverThread.id);
    const preservePendingPrompt =
      !this.deps.threadManager.hasSelectedThread() &&
      this.deps.threadManager.activeThread.state.history.some((item) => item.role === "user");
    this.select(serverThread.id, false, preservePendingPrompt);
    const thread = this.deps.threadManager.thread(serverThread.id);
    thread.syncServerThread(serverThread);
    thread.applyServerStatus(serverThread.status ?? {});
    this.deps.onStateChanged();
  }

  /** Removes an archived or deleted thread and selects the next available thread. */
  handleThreadRemoved(threadId: string): void {
    this.deps.threadManager.removeThread(threadId);
    this.deps.threadManager.remove(threadId);
    if (!this.deps.threadManager.isSelected(threadId)) {
      this.deps.onStateChanged();
      return;
    }
    const nextThread = this.deps.threadManager.threads[0];
    this.deps.threadManager.select(undefined);
    this.deps.threadManager.standaloneThread.clearConversation();
    if (nextThread) this.select(nextThread.id);
    this.deps.onStateChanged();
  }

  /** Stores the model selected after an app-server reroute. */
  handleModelRerouted(
    message: Extract<ServerMessage, { method: "model/rerouted" }>,
    thread: CodexThread,
  ): void {
    thread.mergeModelInfo({ model: message.params.toModel });
    this.deps.onStateChanged();
  }

  /** Updates model metadata when thread settings change. */
  handleSettingsUpdated(
    message: Extract<ServerMessage, { method: "thread/settings/updated" }>,
    thread: CodexThread,
  ): void {
    const mode = message.params.threadSettings.collaborationMode?.mode;
    if (mode === "plan" || mode === "default") thread.setCollaborationMode(mode);
    if (thread.mergeModelInfoFromServer(message.params.threadSettings)) {
      this.deps.onStateChanged();
    }
    this.deps.onStateChanged();
  }

  /** Applies a server-side project assignment update to a thread. */
  handleProjectUpdated(
    message: Extract<ServerMessage, { method: "thread/project/updated" }>,
    thread: CodexThread,
  ): void {
    thread.setProjectId(message.params.projectId);
    this.deps.projectManager.scheduleRefresh();
    this.deps.onStateChanged();
  }

  /** Reconciles local status and triggers reads or resumes when needed. */
  handleStatusChanged(
    message: Extract<ServerMessage, { method: "thread/status/changed" }>,
    thread: CodexThread,
  ): void {
    const { threadId, status } = message.params;
    const selected = this.deps.threadManager.isSelected(threadId);
    thread.applyServerStatus(status ?? {});
    if (!selected && thread.state.status !== "idle")
      this.deps.threadManager.trackBackgroundWork(threadId);
    this.deps.onStateChanged();
    if (
      selected &&
      status?.type === "active" &&
      this.deps.threadManager.consumePendingResume(threadId)
    ) {
      this.resume(threadId);
    } else if (selected && shouldResumeOnActiveStatus(thread.state.connected, status)) {
      this.resume(threadId);
    }
  }

  /** Resumes a thread and falls back to read-only mode when another writer is active. */
  private resume(threadId: string): void {
    this.request<ThreadResumeResponse>(
      {
        method: "thread/resume",
        params: { threadId, excludeTurns: true },
      },
      (message) => {
        this.deps.threadManager.withThread(threadId, (thread) => {
          if (!message.error) {
            this.deps.threadManager.setReadOnly(threadId, false);
            this.updateModelInfo(message, thread);
            this.read(threadId);
          } else {
            const text =
              typeof message.error === "object" && message.error && "message" in message.error
                ? String((message.error as { message?: unknown }).message ?? "")
                : "";
            if (text.includes("already has an active writer")) {
              this.deps.threadManager.setReadOnly(threadId, true);
              this.deps.onStateChanged();
              this.read(threadId);
            }
          }
        });
      },
    );
  }

  /** Reads server metadata for a thread and starts its initial history load. */
  private read(threadId: string): void {
    this.request<ThreadReadResponse>(
      {
        method: "thread/read",
        params: { threadId, includeTurns: false },
      },
      (message) => {
        this.deps.threadManager.withThread(threadId, (thread) => {
          const serverThread = message.result?.thread;
          if (isThread(serverThread)) this.deps.threadManager.updateThread(serverThread);
          thread.syncServerThread(serverThread);
          thread.setConnected(true);
          thread.applyServerStatus(serverThread?.status ?? {});
          this.deps.onStateChanged();
          void this.loadHistoryPage(threadId, null, true).then((loaded) => {
            if (loaded) this.deps.onThreadHydrated(threadId);
          });
        });
      },
    );
  }

  /** Loads and merges one server history page for a thread. */
  private loadHistoryPage(
    threadId: string,
    cursor: string | null,
    replace: boolean,
  ): Promise<boolean> {
    const state = this.deps.threadManager.beginHistoryPage(threadId, replace);
    if (!state) return Promise.resolve(false);
    if (this.deps.threadManager.isSelected(threadId)) this.deps.onStateChanged();
    return new Promise((resolve) => {
      const accepted = this.request<ThreadTurnsListResponse>(
        {
          method: "thread/turns/list",
          params: {
            threadId,
            cursor,
            limit: HISTORY_PAGE_LIMIT,
            sortDirection: "desc",
            itemsView: "full",
          },
        },
        (message) => {
          this.deps.threadManager.withThread(threadId, (thread) => {
            const result = message.result;
            if (!result) {
              this.deps.threadManager.finishHistoryPage(threadId, null, false);
              if (this.deps.threadManager.isSelected(threadId)) this.deps.onStateChanged();
              resolve(false);
              return;
            }
            thread.restoreTurns([...result.data].reverse(), !replace);
            this.deps.threadManager.finishHistoryPage(threadId, result.nextCursor, true);
            if (this.deps.threadManager.isSelected(threadId)) this.deps.onStateChanged();
            resolve(true);
          });
        },
      );
      if (!accepted) {
        this.deps.threadManager.finishHistoryPage(threadId, null, false);
        if (this.deps.threadManager.isSelected(threadId)) this.deps.onStateChanged();
        resolve(false);
      }
    });
  }
}
