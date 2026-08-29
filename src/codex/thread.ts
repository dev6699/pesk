import type {
  CodexMessage,
  CodexModelInfo,
  CodexPendingApproval,
  CodexPendingUserInput,
  CodexQueuedSubmission,
  CodexThreadSnapshot,
  ApprovalDecision,
  PendingApproval,
} from "./types";
import { records, stringValue } from "./protocol";
import type { ThreadTokenUsage, TokenUsageBreakdown } from "../codex-schema/v2";

export type ThreadStatus = "idle" | "working" | "waiting";

export interface ThreadState {
  activeTurnId?: string;
  status: ThreadStatus;
  connected: boolean;
  history: CodexMessage[];
  workingSince?: number;
  workedElapsed?: number;
  interrupted: boolean;
  tokenUsage?: ThreadTokenUsage;
  modelInfo?: CodexModelInfo;
  collaborationMode: "default" | "plan";
  pendingUserInput?: CodexPendingUserInput;
  pendingApproval?: CodexPendingApproval;
  queuedSubmissions: CodexQueuedSubmission[];
  reviewInProgress: boolean;
  streamingAssistant: number;
  streamingAssistantItemId?: string;
  activityIndexes: Map<string, number>;
  needsReconcile: boolean;
  prompts: Map<string, number>;
  pendingApprovals: Map<string, PendingApproval>;
  workingDirectory?: string;
}

/** Owns mutable state and conversation behavior for exactly one Codex thread. */
export class CodexThread {
  readonly state: ThreadState = {
    status: "idle",
    connected: false,
    history: [],
    interrupted: false,
    collaborationMode: "default",
    queuedSubmissions: [],
    reviewInProgress: false,
    streamingAssistant: -1,
    activityIndexes: new Map(),
    needsReconcile: false,
    prompts: new Map(),
    pendingApprovals: new Map(),
  };

  /** Creates an isolated runtime for one server or standalone thread. */
  constructor(
    readonly id: string,
    private readonly maxHistory = 20,
    workingDirectory = process.cwd(),
  ) {
    this.state.workingDirectory = workingDirectory;
  }

  /** Returns the renderer-facing state for this thread without exposing internals. */
  snapshot(): CodexThreadSnapshot {
    return {
      status: this.state.status,
      connected: this.state.connected,
      history: [...this.state.history],
      workingDirectory: this.state.workingDirectory,
      workingSince: this.state.workingSince,
      workedElapsed: this.state.workedElapsed,
      interrupted: this.state.interrupted,
      tokenUsage: this.state.tokenUsage,
      modelInfo: this.state.modelInfo,
      collaborationMode: this.state.collaborationMode,
      pendingUserInput: this.state.pendingUserInput,
      pendingApproval: this.state.pendingApproval,
      queuedSubmissions: [...this.state.queuedSubmissions],
    };
  }

  /** Resets thread state while retaining the supplied conversation history. */
  reset(history: CodexMessage[] = [], workingDirectory = process.cwd()): void {
    this.state.activeTurnId = undefined;
    this.state.status = "idle";
    this.state.connected = false;
    this.state.history = [...history];
    this.state.workingSince = undefined;
    this.state.workedElapsed = undefined;
    this.state.interrupted = false;
    this.state.tokenUsage = undefined;
    this.state.modelInfo = undefined;
    this.state.collaborationMode = "default";
    this.state.pendingUserInput = undefined;
    this.state.pendingApproval = undefined;
    this.state.queuedSubmissions = [];
    this.state.reviewInProgress = false;
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
    this.state.activityIndexes.clear();
    this.state.needsReconcile = false;
    this.state.prompts.clear();
    this.state.pendingApprovals.clear();
    this.state.workingDirectory = workingDirectory;
    this.trim();
  }

  /** Appends a normalized message to this thread's history. */
  addMessage(
    role: CodexMessage["role"],
    text: string,
    turnId?: string,
    images?: Array<{ url: string; name?: string }>,
  ): void {
    const value = text.trim();
    if (!value && !images?.length) return;
    this.state.history.push({
      role,
      text: value,
      timestamp: Date.now(),
      turnId,
      ...(images?.length ? { images } : {}),
    });
    this.trim();
  }

  /** Records user-authored conversation text and supersedes stale approvals. */
  addUserMessage(
    text: string,
    turnId?: string,
    images?: Array<{ url: string; name?: string }>,
  ): boolean {
    const value = text.trim();
    if (!value && !images?.length) return false;
    this.supersedePendingApprovals();
    this.addMessage("user", value, turnId, images);
    return true;
  }

  /** Inserts an echoed user message without duplicating local input. */
  insertUser(
    text: string,
    turnId?: string,
    images?: Array<{ url: string; name?: string }>,
  ): boolean {
    const value = text.trim();
    if (!value && !images?.length) return false;
    this.clearPendingApprovals();
    if (
      this.state.history.some(
        (message) =>
          message.role === "user" &&
          message.text === value &&
          (!turnId ||
            message.turnId === undefined ||
            message.turnId === turnId),
      )
    ) {
      return false;
    }
    const index =
      this.state.streamingAssistant >= 0
        ? this.state.streamingAssistant
        : this.state.history.length;
    this.state.history.splice(index, 0, {
      role: "user",
      text: value,
      turnId,
      timestamp: Date.now(),
      ...(images?.length ? { images } : {}),
    });
    if (this.state.streamingAssistant >= 0) this.state.streamingAssistant += 1;
    this.trim();
    return true;
  }

  /** Adds or updates one activity entry indexed by its server item ID. */
  updateActivity(message: CodexMessage, itemId?: string): void {
    const existingIndex = itemId
      ? this.state.activityIndexes.get(itemId)
      : undefined;
    if (existingIndex !== undefined && this.state.history[existingIndex]) {
      const existing = this.state.history[existingIndex];
      if (existing.activity && message.activity && !message.activity.output) {
        message.activity.output = existing.activity.output;
        message.text = formatActivityText(message.activity);
      }
      existing.text = message.text;
      existing.activity = message.activity;
      existing.itemId = itemId;
    } else {
      this.state.history.push({ ...message, itemId });
      if (itemId)
        this.state.activityIndexes.set(itemId, this.state.history.length - 1);
    }
    this.trim();
  }

  /** Converts and records a server activity item. */
  addActivity(
    item: Record<string, unknown>,
    itemId?: string,
    statusOverride?: string,
    timestamp = Date.now(),
  ): void {
    const message = this.activityMessage(
      statusOverride && item.type === "plan"
        ? { ...item, status: statusOverride }
        : item,
      timestamp,
    );
    this.updateActivity(message, itemId);
  }

  /** Converts a raw server item into a renderer activity message. */
  activityMessage(
    item: Record<string, unknown>,
    timestamp: number,
  ): CodexMessage {
    const type = typeof item.type === "string" ? item.type : "unknown";
    const isReviewCompletion = type === "exitedReviewMode";
    const kind: NonNullable<CodexMessage["activity"]>["kind"] =
      type === "commandExecution"
        ? "command"
        : type === "fileChange"
          ? "fileChange"
          : /search/i.test(type)
            ? "webSearch"
            : type === "plan"
              ? "plan"
              : /tool|mcp/i.test(type)
                ? "tool"
                : "other";
    const changes = records(item.changes).map((change) => {
      const filePath =
        typeof change.path === "string" ? change.path : "unknown file";
      const changeKind =
        typeof change.kind === "string" ? `${change.kind}: ` : "";
      const content = firstText(change, [
        "diff",
        "patch",
        "content",
        "newContent",
      ]);
      return [
        `${changeKind}${filePath}`,
        content ? indentActivityContent(content) : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
    const activity: NonNullable<CodexMessage["activity"]> = {
      kind,
      source: isCommandExecutionSource(item.source) ? item.source : undefined,
      userInitiated: item.userInitiated === true || item.source === "userShell",
      label: type,
      status:
        typeof item.status === "string"
          ? item.status
          : kind === "plan"
            ? "completed"
            : undefined,
      command: typeof item.command === "string" ? item.command : undefined,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      summary:
        firstText(item, ["query", "title", "name", "url", "message"]) ??
        (isReviewCompletion ? "Review completed" : undefined),
      output:
        typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : undefined,
      changes,
      details: isReviewCompletion
        ? undefined
        : kind === "plan"
          ? typeof item.text === "string"
            ? item.text
            : undefined
          : kind === "command" || kind === "fileChange"
            ? undefined
            : summarizeActivity(item),
    };
    return {
      role: "system",
      text: formatActivityText(activity),
      timestamp,
      itemId: typeof item.id === "string" ? item.id : undefined,
      activity,
    };
  }

  /** Appends streamed command output to an indexed activity message. */
  appendActivityOutput(itemId: string | undefined, delta: string): void {
    if (!itemId || !delta) return;
    const index = this.state.activityIndexes.get(itemId);
    const message = index === undefined ? undefined : this.state.history[index];
    if (!message?.activity) return;
    message.activity.output = `${message.activity.output ?? ""}${delta}`;
    message.text = formatActivityText(message.activity);
  }

  /** Appends streamed plan text to an indexed plan activity message. */
  appendPlanDelta(itemId: string, delta: string): void {
    if (!delta) return;
    const index = this.state.activityIndexes.get(itemId);
    const message = index === undefined ? undefined : this.state.history[index];
    if (!message?.activity || message.activity.kind !== "plan") return;
    message.activity.details = `${message.activity.details ?? ""}${delta}`;
    message.text = formatActivityText(message.activity);
  }

  /** Marks this thread as actively processing the specified turn. */
  startTurn(turnId: string): void {
    this.state.activeTurnId = turnId;
    this.state.status = "working";
    if (this.state.workingSince === undefined)
      this.state.workingSince = Date.now();
    const last = [...this.state.history]
      .reverse()
      .find((message) => message.role === "user" && !message.turnId);
    if (last) last.turnId = turnId;
  }

  /** Completes the active turn and records its elapsed working time. */
  completeTurn(interrupted: boolean): void {
    this.state.activeTurnId = undefined;
    this.state.reviewInProgress = false;
    this.state.interrupted = interrupted;
    this.state.status = "idle";
    if (this.state.workingSince !== undefined) {
      this.state.workedElapsed = Math.max(
        0,
        Date.now() - this.state.workingSince,
      );
    }
    this.state.workingSince = undefined;
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
  }

  /** Appends streamed assistant text to the current assistant message. */
  appendAssistantDelta(delta: string, itemId?: string, turnId?: string): void {
    if (!delta) return;
    this.supersedePendingApprovals();
    const current =
      this.state.streamingAssistant >= 0
        ? this.state.history[this.state.streamingAssistant]
        : undefined;
    if (
      !current ||
      current.role !== "assistant" ||
      (itemId !== undefined && itemId !== this.state.streamingAssistantItemId)
    ) {
      this.state.history.push({
        role: "assistant",
        text: delta,
        timestamp: Date.now(),
        turnId,
        itemId,
      });
      this.state.streamingAssistant = this.state.history.length - 1;
      this.state.streamingAssistantItemId = itemId;
    } else {
      current.text += delta;
    }
    this.trim();
  }

  /** Finalizes an assistant message, replacing its streamed partial text. */
  completeAssistant(text: string, itemId?: string): void {
    const value = text.trim();
    if (!value) return;
    const current = itemId
      ? this.state.history.find((message) => message.itemId === itemId)
      : this.state.history[this.state.streamingAssistant];
    if (current?.role === "assistant") {
      current.text = value;
      current.itemId = itemId ?? current.itemId;
    } else {
      this.state.history.push({
        role: "assistant",
        text: value,
        timestamp: Date.now(),
        itemId,
      });
    }
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
    this.trim();
  }

  /** Normalizes a server item when it starts and records its visible output. */
  processStartedItem(
    item: Record<string, unknown>,
    turnId: string,
    suppressUserMessage: boolean,
  ): void {
    if (!suppressUserMessage) {
      const contents = records(item.content);
      const text = contents
        .map((content) =>
          typeof content.text === "string" ? content.text.trim() : "",
        )
        .filter(Boolean)
        .join("\n");
      const images = contents
        .filter(
          (content) =>
            content.type === "image" &&
            typeof content.url === "string" &&
            content.url.startsWith("data:image/"),
        )
        .map((content) => ({ url: content.url as string }));
      if (text && !this.consumePrompt(text)) {
        this.insertUser(text, turnId, images);
      } else if (!text && images.length) {
        this.insertUser("", turnId, images);
      }
    }
    if (isActivityItem(item)) {
      this.addActivity(
        item,
        stringValue(item.id),
        item.type === "plan" ? "inProgress" : undefined,
      );
    }
  }

  /** Normalizes a server item when it completes and records its visible output. */
  processCompletedItem(item: Record<string, unknown>): void {
    if (item.type === "agentMessage") {
      const text =
        typeof item.text === "string"
          ? item.text
          : records(item.content)
            .map((content) =>
              typeof content.text === "string" ? content.text : "",
            )
            .join("");
      this.completeAssistant(text, stringValue(item.id));
    } else if (isActivityItem(item)) {
      this.addActivity(
        item,
        stringValue(item.id),
        item.type === "plan" ? "completed" : undefined,
      );
    }
  }

  /** Restores renderer history from the app-server's persisted turn records. */
  restoreTurns(turns: Array<Record<string, unknown>>): void {
    const restoredTokenUsage = [...turns]
      .reverse()
      .map((turn) => parseTokenUsageValue(turn.tokenUsage ?? turn.usage))
      .find((usage): usage is ThreadTokenUsage => usage !== undefined);
    if (restoredTokenUsage) this.state.tokenUsage = restoredTokenUsage;

    const reviewPromptTexts = new Set<string>();
    for (const turn of turns) {
      for (const item of records(turn.items)) {
        if (
          (item.type === "enteredReviewMode" ||
            item.type === "exitedReviewMode") &&
          typeof item.review === "string" &&
          item.review.trim()
        ) {
          reviewPromptTexts.add(item.review.trim());
        }
      }
    }

    const restored: CodexMessage[] = [];
    for (const turn of turns) {
      const timestamp =
        typeof turn.createdAt === "number"
          ? turn.createdAt < 10_000_000_000
            ? turn.createdAt * 1000
            : turn.createdAt
          : Date.now();
      const items = records(turn.items);
      for (const item of items) {
        if (item.type === "userMessage") {
          const contents = records(item.content);
          const text = contents
            .map((content) =>
              typeof content.text === "string" ? content.text.trim() : "",
            )
            .filter(Boolean)
            .join("\n");
          const images = contents
            .filter(
              (content) =>
                content.type === "image" &&
                typeof content.url === "string" &&
                content.url.startsWith("data:image/"),
            )
            .map((content) => ({ url: content.url as string }));
          if ((text && !reviewPromptTexts.has(text)) || images.length) {
            restored.push({
              role: "user",
              text,
              timestamp,
              ...(images.length ? { images } : {}),
            });
          }
        }
        if (item.type === "agentMessage") {
          const text =
            typeof item.text === "string"
              ? item.text
              : records(item.content)
                .map((part) =>
                  typeof part.text === "string" ? part.text : "",
                )
                .join("");
          if (text.trim()) {
            restored.push({
              role: "assistant",
              text: text.trim(),
              timestamp,
              itemId: stringValue(item.id),
            });
          }
        }
        if (isActivityItem(item))
          restored.push(this.activityMessage(item, timestamp));
      }
    }

    const restoredUsers = new Set(
      restored
        .filter((message) => message.role === "user")
        .map((message) => message.text),
    );
    const hasMissingLiveUser = this.state.history.some(
      (message) => message.role === "user" && !restoredUsers.has(message.text),
    );
    if (
      !(this.state.status === "working" && this.state.history.length) &&
      !hasMissingLiveUser
    ) {
      this.replaceHistory(restored);
    }
  }

  /** Adds an optimistic queued submission to this thread. */
  queuePending(submission: CodexQueuedSubmission): void {
    this.state.queuedSubmissions = [
      ...this.state.queuedSubmissions,
      submission,
    ];
  }

  /** Replaces an optimistic queue entry with the server submission. */
  resolveQueuedSubmission(
    clientUserMessageId: string,
    submission: CodexQueuedSubmission,
  ): void {
    this.state.queuedSubmissions = this.state.queuedSubmissions.map((entry) =>
      entry.clientUserMessageId === clientUserMessageId ? submission : entry,
    );
  }

  /** Replaces this thread's complete local queue. */
  replaceQueue(submissions: CodexQueuedSubmission[]): void {
    this.state.queuedSubmissions = submissions;
  }

  /** Appends a page of queue entries to this thread. */
  appendQueue(submissions: CodexQueuedSubmission[]): void {
    this.state.queuedSubmissions = [
      ...this.state.queuedSubmissions,
      ...submissions,
    ];
  }

  /** Replaces the queue from raw app-server submissions. */
  replaceQueueFromServer(submissions: unknown): void {
    this.replaceQueue(this.parseQueue(submissions));
  }

  /** Appends a page of raw app-server submissions to this thread queue. */
  appendQueueFromServer(submissions: unknown): void {
    this.appendQueue(this.parseQueue(submissions));
  }

  /** Consumes a recently remembered prompt used for echo de-duplication. */
  consumePrompt(text: string): boolean {
    const key = text.trim();
    const at = this.state.prompts.get(key);
    if (at === undefined) return false;
    this.state.prompts.delete(key);
    return Date.now() - at < 10_000;
  }

  /** Removes all unresolved approval state and its pending history entries. */
  clearPendingApprovals(): boolean {
    const hadHistory = this.state.history.some(
      (message) => message.approval?.state === "pending",
    );
    this.state.pendingApprovals.clear();
    this.state.pendingApproval = undefined;
    this.state.history = this.state.history.filter(
      (message) => message.approval?.state !== "pending",
    );
    return hadHistory;
  }

  /** Registers an approval request and exposes its renderer representation. */
  addApproval(
    key: string,
    approval: PendingApproval,
    displayed: CodexPendingApproval,
  ): void {
    this.state.pendingApprovals.set(key, approval);
    this.state.pendingApproval = displayed;
  }

  /** Removes and returns one pending approval by its normalized request key. */
  removeApproval(key: string): PendingApproval | undefined {
    const approval = this.state.pendingApprovals.get(key);
    this.state.pendingApprovals.delete(key);
    return approval;
  }

  /** Returns the next pending approval, optionally excluding one key. */
  nextApproval(excludeKey?: string): PendingApproval | undefined {
    for (const [key, approval] of this.state.pendingApprovals) {
      if (key !== excludeKey) return approval;
    }
    return undefined;
  }

  /** Looks up one pending approval without changing thread state. */
  getApproval(key: string): PendingApproval | undefined {
    return this.state.pendingApprovals.get(key);
  }

  /** Resolves an approval and appends its audit message to history. */
  resolveApproval(
    key: string,
    historyMessage: CodexMessage,
    nextDisplayed?: CodexPendingApproval,
  ): void {
    this.state.pendingApprovals.delete(key);
    this.state.pendingApproval = nextDisplayed;
    this.state.history.push(historyMessage);
    this.trim();
  }

  /** Resolves one approval and appends the thread-local audit message. */
  resolveApprovalSelection(
    key: string,
    optionId: string,
    timestamp = Date.now(),
  ): { decision: ApprovalDecision; hasPending: boolean } | undefined {
    const pending = this.state.pendingApprovals.get(key);
    const decision = pending?.decisions.get(optionId);
    if (!pending || decision === undefined) return undefined;
    const state =
      optionId === "decline" || optionId === "cancel" ? "denied" : "approved";
    const next = this.nextApproval(key);
    this.resolveApproval(
      key,
      {
        role: "system",
        text:
          [pending.command, pending.reason].filter(Boolean).join("\n") ||
          "Codex approval",
        timestamp,
        approval: {
          requestId: pending.requestId,
          state,
          options: approvalOptions(pending.decisions),
        },
      },
      next
        ? {
          requestId: next.requestId,
          command: next.command,
          reason: next.reason,
          options: approvalOptions(next.decisions),
        }
        : undefined,
    );
    return { decision, hasPending: this.state.pendingApprovals.size > 0 };
  }

  /** Stores a blocking user-input request for the renderer. */
  setUserInput(request: CodexPendingUserInput): void {
    this.state.pendingUserInput = request;
  }

  /** Clears the current blocking user-input request. */
  clearUserInput(): void {
    this.state.pendingUserInput = undefined;
  }

  /** Initializes transient state for a newly submitted turn. */
  prepareTurn(): void {
    this.state.needsReconcile = true;
    this.state.workingSince = undefined;
    this.state.workedElapsed = undefined;
    this.state.interrupted = false;
    this.ensureWorking();
  }

  /** Starts a review turn while preserving review-specific item handling. */
  beginReview(): void {
    this.state.reviewInProgress = true;
    this.prepareTurn();
  }

  /** Updates whether this thread is currently connected to the server. */
  setConnected(connected: boolean): void {
    this.state.connected = connected;
  }

  /** Clears transport-owned ephemeral state while retaining conversation history. */
  resetTransportState(): void {
    this.state.status = "idle";
    this.state.connected = false;
    this.state.activeTurnId = undefined;
    this.state.workingSince = undefined;
    this.state.workedElapsed = undefined;
    this.state.pendingUserInput = undefined;
    this.state.reviewInProgress = false;
    this.state.queuedSubmissions = [];
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
    this.clearPendingApprovals();
  }

  /** Clears the local conversation when no server thread is available. */
  clearConversation(): void {
    this.resetTransportState();
    this.state.history = [];
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
    this.state.activityIndexes.clear();
    this.clearPendingApprovals();
  }

  /** Stores the latest token usage for this thread. */
  setTokenUsage(usage: ThreadTokenUsage | undefined): void {
    this.state.tokenUsage = usage;
  }

  /** Merges model metadata without discarding previously known fields. */
  mergeModelInfo(modelInfo: CodexModelInfo): void {
    this.state.modelInfo = { ...this.state.modelInfo, ...modelInfo };
  }

  /** Extracts and merges model metadata from an app-server value. */
  mergeModelInfoFromServer(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const source = value as Record<string, unknown>;
    const next: CodexModelInfo = {
      model: stringValue(source.model),
      provider: stringValue(source.modelProvider),
      reasoningEffort: stringValue(source.reasoningEffort ?? source.effort),
      serviceTier: stringValue(source.serviceTier),
    };
    const defined = Object.fromEntries(
      Object.entries(next).filter(([, entry]) => entry !== undefined),
    ) as CodexModelInfo;
    if (!Object.keys(defined).length) return false;
    this.mergeModelInfo(defined);
    return true;
  }

  /** Updates the server-owned working directory when it is valid. */
  setWorkingDirectory(directory: string | undefined): void {
    if (directory?.trim()) this.state.workingDirectory = directory.trim();
  }

  /** Captures the server-owned identity fields for this thread. */
  syncServerThread(thread: unknown): void {
    if (!thread || typeof thread !== "object") return;
    const cwd = (thread as { cwd?: unknown }).cwd;
    if (typeof cwd === "string") this.setWorkingDirectory(cwd);
  }

  /** Updates the active turn ID from a request response. */
  setActiveTurn(turnId: string | undefined): void {
    this.state.activeTurnId = turnId;
  }

  /** Selects the collaboration mode for subsequent turns. */
  setCollaborationMode(mode: "default" | "plan"): void {
    this.state.collaborationMode = mode;
  }

  /** Remembers local prompt text for short-lived server echo de-duplication. */
  rememberPrompt(text: string, timestamp = Date.now()): void {
    this.state.prompts.set(text, timestamp);
  }

  /** Marks whether persisted history should be reconciled on the next idle state. */
  markNeedsReconcile(needsReconcile = true): void {
    this.state.needsReconcile = needsReconcile;
  }

  /** Replaces history and rebuilds indexes used by streaming updates. */
  replaceHistory(history: CodexMessage[]): void {
    this.state.history = [...history];
    this.state.streamingAssistant = -1;
    this.state.streamingAssistantItemId = undefined;
    this.rebuildActivityIndexes();
    this.trim();
  }

  /** Applies a local status while preserving approval-blocked waiting state. */
  setStatus(status: ThreadStatus): void {
    if (status !== "waiting" && this.state.pendingApprovals.size > 0) {
      status = "waiting";
    }
    this.state.status = status;
    if (status === "working" && this.state.workingSince === undefined) {
      this.state.workingSince = Date.now();
    }
    if (status === "idle") this.completeTurn(this.state.interrupted);
  }

  /** Applies an app-server lifecycle status to this thread runtime. */
  applyServerStatus(status: { type?: unknown; activeFlags?: unknown }): void {
    if (status.type === "active") {
      const waitingOnApproval =
        Array.isArray(status.activeFlags) &&
        status.activeFlags.includes("waitingOnApproval");
      this.setStatus(waitingOnApproval ? "waiting" : "working");
    } else if (status.type === "idle" || status.type === "notLoaded") {
      this.setStatus("idle");
    }
  }

  /** Starts the working timer without changing the visible status. */
  ensureWorking(): void {
    if (this.state.workingSince === undefined)
      this.state.workingSince = Date.now();
  }

  /** Enforces the history limit and repairs indexes after truncation. */
  trim(): void {
    const removed = Math.max(0, this.state.history.length - this.maxHistory);
    if (!removed) return;
    this.state.history = this.state.history.slice(-this.maxHistory);
    this.rebuildActivityIndexes();
    if (this.state.streamingAssistant >= 0) {
      this.state.streamingAssistant -= removed;
      if (this.state.streamingAssistant < 0) {
        this.state.streamingAssistant = -1;
        this.state.streamingAssistantItemId = undefined;
      }
    }
  }

  /** Rebuilds item-to-history indexes after history replacement or trimming. */
  private rebuildActivityIndexes(): void {
    this.state.activityIndexes = new Map(
      this.state.history.flatMap((message, index) =>
        message.itemId && message.activity
          ? [[message.itemId, index] as const]
          : [],
      ),
    );
  }

  /** Clears approvals when new conversation output supersedes them. */
  private supersedePendingApprovals(): void {
    if (!this.state.pendingApprovals.size) return;
    this.clearPendingApprovals();
    if (this.state.status === "waiting") this.state.status = "working";
  }

  /** Parses raw queue entries into renderer-safe submissions. */
  private parseQueue(value: unknown): CodexQueuedSubmission[] {
    return records(value)
      .map((submission) => {
        const id = stringValue(submission.id);
        const clientUserMessageId = stringValue(submission.clientUserMessageId);
        if (!id || !clientUserMessageId) return undefined;
        const text = records(submission.input).find(
          (input) => input.type === "text" && typeof input.text === "string",
        );
        const images = records(submission.input)
          .filter(
            (input) =>
              input.type === "image" &&
              typeof input.url === "string" &&
              input.url.startsWith("data:image/"),
          )
          .map((input) => ({ url: input.url as string }));
        return {
          id,
          text: typeof text?.text === "string" ? text.text : "",
          ...(images.length ? { images } : {}),
          clientUserMessageId,
        };
      })
      .filter((submission): submission is CodexQueuedSubmission =>
        Boolean(submission),
      );
  }
}

function formatActivityText(
  activity: NonNullable<CodexMessage["activity"]>,
): string {
  const title =
    activity.kind === "command"
      ? "Command"
      : activity.kind === "fileChange"
        ? "File change"
        : activity.kind === "webSearch"
          ? "Web search"
          : activity.kind === "tool"
            ? "Tool"
            : "Activity";
  const lines = [`${title}${activity.status ? ` · ${activity.status}` : ""}`];
  if (
    activity.label &&
    !["commandExecution", "fileChange"].includes(activity.label)
  ) {
    lines.push(`type: ${activity.label}`);
  }
  if (activity.command) lines.push(`$ ${activity.command}`);
  if (activity.cwd) lines.push(`cwd: ${activity.cwd}`);
  if (activity.summary) lines.push(activity.summary);
  if (activity.changes?.length) lines.push(...activity.changes);
  if (activity.output) lines.push(activity.output);
  if (activity.details) lines.push(activity.details);
  return lines.join("\n");
}

export function isActivityItem(
  item: Record<string, unknown> | undefined,
): boolean {
  const type = typeof item?.type === "string" ? item.type : "";
  return (
    Boolean(type) &&
    type !== "userMessage" &&
    type !== "agentMessage" &&
    !/reasoning/i.test(type)
  );
}

type ApprovalOption = {
  id: string;
  label: string;
  description: string;
};

export function approvalOptions(
  decisions: Map<string, ApprovalDecision>,
): ApprovalOption[] {
  const options: ApprovalOption[] = [
    {
      id: "accept",
      label: "Approve once",
      description: "Allow this request only.",
    },
    {
      id: "acceptForSession",
      label: "Approve for session",
      description: "Allow matching requests for this session.",
    },
    { id: "decline", label: "Decline", description: "Reject this request." },
    { id: "cancel", label: "Cancel", description: "Cancel the request." },
  ];
  if (decisions.has("acceptWithExecpolicyAmendment")) {
    options.splice(2, 0, {
      id: "acceptWithExecpolicyAmendment",
      label: "Approve and remember command",
      description: "Apply the proposed command policy amendment.",
    });
  }
  for (const id of decisions.keys()) {
    if (id.startsWith("applyNetworkPolicyAmendment:")) {
      const index = id.split(":")[1];
      options.splice(2, 0, {
        id,
        label: `Approve and allow network access ${Number(index) + 1}`,
        description: "Apply the proposed network policy amendment.",
      });
    }
  }
  return options.filter((option) => decisions.has(option.id));
}

export function parseTokenUsageValue(
  value: unknown,
): ThreadTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const total = parseTokenCounts(usage.total ?? usage.totalTokenUsage);
  if (!total) return undefined;
  return {
    total,
    last: parseTokenCounts(
      usage.last ?? usage.lastTurnUsage,
    ) as TokenUsageBreakdown,
    modelContextWindow: numberValue(usage.modelContextWindow) ?? null,
  };
}

function parseTokenCounts(value: unknown): TokenUsageBreakdown | undefined {
  if (!value || typeof value !== "object") return undefined;
  const counts = value as Record<string, unknown>;
  const parsed = {
    inputTokens: numberValue(counts.inputTokens),
    cachedInputTokens: numberValue(counts.cachedInputTokens),
    cacheWriteInputTokens: numberValue(counts.cacheWriteInputTokens),
    outputTokens: numberValue(counts.outputTokens),
    reasoningOutputTokens: numberValue(counts.reasoningOutputTokens),
    totalTokens: numberValue(counts.totalTokens),
  };
  return Object.values(parsed).some((entry) => entry !== undefined)
    ? (parsed as TokenUsageBreakdown)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstText(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key])
      return value[key] as string;
  }
  return undefined;
}

function indentActivityContent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function isCommandExecutionSource(
  value: unknown,
): value is NonNullable<CodexMessage["activity"]>["source"] {
  return (
    value === "agent" ||
    value === "userShell" ||
    value === "unifiedExecStartup" ||
    value === "unifiedExecInteraction"
  );
}

function summarizeActivity(item: Record<string, unknown>): string | undefined {
  const details = Object.entries(item)
    .filter(
      ([key]) => !["id", "type", "status", "command", "cwd"].includes(key),
    )
    .map(([key, value]) => `${key}: ${formatActivityValue(value)}`)
    .filter((line) => line.length > 0)
    .join("\n");
  return details ? details.slice(0, 4000) : undefined;
}

function formatActivityValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
