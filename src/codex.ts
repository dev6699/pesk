import type {
  ClientNotification,
  ClientRequest,
  InitializeResponse,
  RequestId,
  ServerNotification,
  ServerRequest,
} from "./codex-schema";
import type { CollaborationMode } from "./codex-schema/CollaborationMode";
import type {
  CommandExecutionRequestApprovalResponse,
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalResponse,
  Thread,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadReadResponse,
  ThreadStartResponse,
  ThreadStatus,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnStartResponse,
  ToolRequestUserInputParams,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
} from "./codex-schema/v2";
import type {
  FuzzyFileSearchResponse,
  FuzzyFileSearchResult,
} from "./codex-schema";

const MAX_HISTORY = 100;

/** A message displayed in the Pesk Codex conversation. */
export interface CodexMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
  temporary?: boolean;
  turnId?: string;
  itemId?: string;
  activity?: {
    kind: "command" | "fileChange" | "webSearch" | "tool" | "plan" | "other";
    label?: string;
    status?: string;
    command?: string;
    cwd?: string;
    summary?: string;
    output?: string;
    changes?: string[];
    details?: string;
  };
  approval?: {
    requestId: string | number;
    state: "pending" | "approved" | "denied";
    options?: Array<{ id: string; label: string; description: string }>;
  };
}

export interface CodexPendingUserInput {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputParams["questions"];
  isBlocking: boolean;
}

export interface CodexPendingApproval {
  requestId: string | number;
  command: string;
  reason: string;
  options: Array<{ id: string; label: string; description: string }>;
}

export interface CodexModelInfo {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

/** Codex-related settings persisted alongside the pet settings. */
/** State exposed by the controller to the Electron renderer. */
export interface CodexState {
  threadId?: string;
  cwd?: string;
  error?: string;
  status: "idle" | "working" | "waiting";
  connected: boolean;
  history: CodexMessage[];
  threads: Thread[];
  workingSince?: number;
  workedElapsed?: number;
  interrupted?: boolean;
  tokenUsage?: ThreadTokenUsage;
  modelInfo?: CodexModelInfo;
  rateLimits?: RateLimitSnapshot;
  collaborationMode: "default" | "plan";
  pendingUserInput?: CodexPendingUserInput;
  pendingApproval?: CodexPendingApproval;
}

interface Options {
  publishRendererState: () => void;
  showPetForUpdate: () => void;
  focusUserInput: () => void;
  showApproval: (requestId: RequestId, command: string, reason: string) => void;
  clearApproval?: () => void;
  debug: (...values: unknown[]) => void;
}

interface PendingApproval {
  requestId: RequestId;
  command: string;
  reason: string;
  decisions: Map<string, CommandExecutionApprovalDecision | FileChangeApprovalDecision>;
}

type PermissionOption = string;

type PermissionApprovalResponse =
  CommandExecutionRequestApprovalResponse | FileChangeRequestApprovalResponse;

/** JSON-RPC response envelope; generated schemas provide the method result types. */
interface JsonRpcResponse<TResult = unknown> {
  [key: string]: unknown;
  id: RequestId;
  result?: TResult;
  error?: unknown;
}

type IncomingMessage = JsonRpcResponse | ServerNotification | ServerRequest;

type ServerMessage = ServerNotification | ServerRequest;

function requestIdKey(requestId: RequestId): string {
  return `${typeof requestId}:${String(requestId)}`;
}

type ApprovalDecision =
  | CommandExecutionApprovalDecision
  | FileChangeApprovalDecision;
type ApprovalOption = { id: string; label: string; description: string };

function approvalDecisions(
  message: Extract<
    ServerMessage,
    {
      method:
        | "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval";
    }
  >,
): Map<string, ApprovalDecision> {
  const decisions = new Map<string, ApprovalDecision>([
    ["accept", "accept"],
    ["acceptForSession", "acceptForSession"],
    ["decline", "decline"],
    ["cancel", "cancel"],
  ]);
  if (message.method === "item/commandExecution/requestApproval") {
    if (message.params.proposedExecpolicyAmendment) {
      decisions.set("acceptWithExecpolicyAmendment", {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: message.params.proposedExecpolicyAmendment,
        },
      });
    }
    for (const [index, amendment] of (
      message.params.proposedNetworkPolicyAmendments ?? []
    ).entries()) {
      decisions.set(`applyNetworkPolicyAmendment:${index}`, {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      });
    }
  }
  return decisions;
}

function approvalOptions(
  decisions: Map<string, ApprovalDecision>,
): ApprovalOption[] {
  const options: ApprovalOption[] = [
    { id: "accept", label: "Approve once", description: "Allow this request only." },
    { id: "acceptForSession", label: "Approve for session", description: "Allow matching requests for this session." },
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

type RequestOf<Method extends ClientRequest["method"]> = Extract<
  ClientRequest,
  { method: Method }
>;
type InitializeRequest = RequestOf<"initialize">;
type ThreadStartRequest = RequestOf<"thread/start">;
type ThreadResumeRequest = RequestOf<"thread/resume">;
type ThreadListRequest = RequestOf<"thread/list">;
type ThreadLoadedListRequest = RequestOf<"thread/loaded/list">;
type ThreadReadRequest = RequestOf<"thread/read">;
type TurnStartRequest = RequestOf<"turn/start">;
type PlanTurnStartParams = TurnStartRequest["params"] & {
  collaborationMode?: CollaborationMode | null;
};
type AccountRateLimitsRequest = RequestOf<"account/rateLimits/read">;
type TurnInterruptRequest = RequestOf<"turn/interrupt">;
type FuzzyFileSearchRequest = RequestOf<"fuzzyFileSearch">;

type OutgoingMessage = ClientRequest | ClientNotification | JsonRpcResponse;

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
  /** Working directory used when starting a new thread. */
  private workingDirectory = process.cwd();
  /** Currently selected thread in the renderer. */
  private threadId: string | undefined;
  /** Turn currently generating output, if any. */
  private activeTurnId: string | undefined;
  /** Renderer-facing lifecycle status for the selected thread. */
  private status: CodexState["status"] = "idle";
  /** Whether the selected thread is resumed and ready for input. */
  private connected = false;
  /** Approval requests that are waiting for renderer decisions. */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Human-readable transport error shown by the renderer. */
  private connectionError: string | undefined;
  /** Conversation messages normalized for the renderer. */
  private history: CodexMessage[] = [];
  /** Known selectable threads returned by app-server discovery. */
  private threads: Thread[] = [];
  /** Timestamp when the current working period began. */
  private workingSince: number | undefined;
  /** Duration of the most recently completed working period. */
  private workedElapsed: number | undefined;
  /** Whether the last completed turn was interrupted. */
  private interrupted = false;
  /** Latest persisted or live token usage for the selected thread. */
  private tokenUsage: ThreadTokenUsage | undefined;
  /** True while /new is replacing the selected thread. */
  private startingNewThread = false;
  /** Model/provider metadata displayed by the renderer. */
  private modelInfo: CodexModelInfo | undefined;
  /** Latest account-wide ChatGPT rate-limit snapshot. */
  private rateLimits: RateLimitSnapshot | undefined;
  /** Mode used for the next Codex turn. */
  private collaborationMode: "default" | "plan" = "default";
  private pendingUserInput: CodexPendingUserInput | undefined;
  private pendingApproval: CodexPendingApproval | undefined;
  /** Prevents duplicate initial rate-limit reads from multiple renderer windows. */
  private rateLimitsReadPending = false;
  /** Index of the assistant message currently receiving deltas. */
  private streamingAssistant = -1;
  /** Item id associated with the currently streaming assistant message. */
  private streamingAssistantItemId: string | undefined;
  /** Maps protocol activity item ids to normalized history indexes. */
  private readonly activityIndexes = new Map<string, number>();
  /** True while a prompt needs a follow-up history reconciliation. */
  private needsReconcile = false;
  /** Whether initialize/initialized completed on the current socket. */
  private initialized = false;
  /** Monotonic JSON-RPC request id for this controller instance. */
  private nextId = 0;
  /** Delayed reconnect task after a transport close or failure. */
  private reconnectTimer: NodeJS.Timeout | null = null;
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
  /** Prompt text and timestamps used to deduplicate echoed user messages. */
  private readonly prompts = new Map<string, number>();

  /** Creates a controller with callbacks for renderer and window updates. */
  constructor(private readonly options: Options) {}

  /** Returns the current state snapshot for renderer IPC responses. */
  getState(): CodexState {
    return {
      threadId: this.threadId,
      cwd: this.workingDirectory,
      error: this.connectionError,
      status: this.status,
      connected: this.connected,
      history: this.history,
      threads: this.threads,
      workingSince: this.workingSince,
      workedElapsed: this.workedElapsed,
      interrupted: this.interrupted,
      tokenUsage: this.tokenUsage,
      modelInfo: this.modelInfo,
      rateLimits: this.rateLimits,
      collaborationMode: this.collaborationMode,
      pendingUserInput: this.pendingUserInput,
      pendingApproval: this.pendingApproval,
    };
  }

  /** Changes the app-server endpoint before the controller starts. */
  setSocketUrl(url: string): void {
    this.url = url;
  }

  /** Starts the WebSocket connection and reconnect lifecycle. */
  start(): void {
    this.connect();
  }

  /** Stops the connection and cancels pending reconnect timers. */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
  }

  /** Selects a known Codex thread and resumes it. */
  selectThread(id: string): void {
    this.switchThread(id);
  }

  /** Selects the collaboration mode used for the next turn. */
  setCollaborationMode(mode: "default" | "plan"): void {
    this.collaborationMode = mode;
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
    const pending = this.pendingUserInput;
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
        return `${question.header || question.question}: ${
          displayed.join(", ") || "No answer"
        }`;
      })
      .join("\n");
    this.history.push({
      role: "user",
      text: answerText || "No answer provided.",
      timestamp: Date.now(),
      turnId: pending.turnId,
    });
    this.trim();
    this.pendingUserInput = undefined;
    this.options.publishRendererState();
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
    if (
      !this.initialized ||
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.threadId ||
      !this.activeTurnId
    ) {
      return false;
    }
    const id = ++this.nextId;
    this.send({
      method: "turn/interrupt",
      id,
      params: {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      },
    } satisfies TurnInterruptRequest);
    return true;
  }

  /** Starts a prompt turn when the controller is initialized and idle. */
  submitPrompt(value: string): boolean {
    if (!value.trim() || !this.initialized || this.status !== "idle") {
      return false;
    }

    const prompt = value.trim();
    this.workingSince = undefined;
    this.workedElapsed = undefined;
    this.interrupted = false;
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

    this.addMessage("user", prompt);
    this.prompts.set(prompt, Date.now());
    const threadId = this.threadId;
    if (threadId) {
      this.startTurn(threadId, prompt);
      return true;
    }

    const id = ++this.nextId;
    this.options.debug("Pesk starting new Codex thread", {
      cwd: this.workingDirectory,
      reason: "first prompt",
    });
    this.send({
      method: "thread/start",
      id,
      params: {
        cwd: ".",
        serviceName: "pesk",
      },
    } satisfies ThreadStartRequest);
    this.pendingThreadStarts += 1;
    this.setRequest<ThreadStartResponse>(id, (message) => {
      const thread = message.result?.thread;
      if (typeof thread?.id === "string") {
        this.noteThreadStartResponse(thread.id);
        this.updateModelInfo(message);
        this.connected = true;
        this.options.publishRendererState();
        this.rememberWorkingDirectory(thread);
        this.startTurn(thread.id, prompt);
      }
    });
    return true;
  }

  /** Starts and selects a fresh Codex session without sending a prompt. */
  startNewThread(workingDirectory?: string, initialPrompt?: string): boolean {
    if (!this.initialized || this.status !== "idle") {
      return false;
    }
    const cwd = (workingDirectory ?? this.workingDirectory).trim();
    if (!cwd) {
      return false;
    }
    this.startingNewThread = true;
    this.tokenUsage = undefined;
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
      this.rememberWorkingDirectory(thread);
      this.threadId = thread.id;
      this.connected = true;
      this.history = [];
      this.tokenUsage = undefined;
      this.modelInfo = undefined;
      this.updateModelInfo(message);
      this.streamingAssistant = -1;
      this.streamingAssistantItemId = undefined;
      this.workingSince = undefined;
      this.workedElapsed = undefined;
      this.interrupted = false;
      this.activityIndexes.clear();
      this.threads = [
        thread,
        ...this.threads.filter((candidate) => candidate.id !== thread.id),
      ];
      this.options.publishRendererState();
      if (initialPrompt) {
        this.addMessage("user", initialPrompt);
        this.prompts.set(initialPrompt, Date.now());
        this.startTurn(thread.id, initialPrompt);
      }
    });
    return true;
  }

  /** Sends an approval response for an app-server request. */
  respondPermission(requestId: RequestId, optionId: PermissionOption): void {
    const key = requestIdKey(requestId);
    const pending = this.pendingApprovals.get(key);
    const decision = pending?.decisions.get(optionId);
    if (!pending || decision === undefined) return;
    this.send({
      id: requestId,
      result: {
        decision,
      },
    } satisfies JsonRpcResponse<PermissionApprovalResponse>);
    const state =
      optionId === "decline" || optionId === "cancel"
        ? "denied"
        : "approved";
    if (this.pendingApproval?.requestId === requestId) {
      this.pendingApproval = undefined;
    }
    this.history.push({
      role: "system",
      text:
        [pending.command, pending.reason].filter(Boolean).join("\n") ||
        "Codex approval",
      timestamp: Date.now(),
      approval: {
        requestId,
        state,
        options: approvalOptions(pending.decisions),
      },
    });
    this.trim();
    this.options.publishRendererState();
    this.options.clearApproval?.();
    this.pendingApprovals.delete(key);
    this.setStatus("working");
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
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      this.socket = new WebSocket(this.url);
    } catch (error) {
      this.options.debug("Codex connection failed", error);
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.connectionError = undefined;
      this.options.publishRendererState();
      const id = ++this.nextId;
      this.setRequest<InitializeResponse>(id, () => {
        this.send({
          method: "initialized",
        } satisfies ClientNotification);
        this.initialized = true;
        this.connected = false;
        this.threadId = undefined;
        this.activeTurnId = undefined;
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
    this.socket.addEventListener("message", (event) => {
      try {
        const value: unknown = JSON.parse(String(event.data));
        if (isRecord(value)) {
          this.handle(value as IncomingMessage);
        }
      } catch (error) {
        this.options.debug("Invalid Codex message", error);
      }
    });
    this.socket.addEventListener("close", (event) => {
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
      this.socket = null;
      this.initialized = false;
      this.connected = false;
      this.threadId = undefined;
      this.activeTurnId = undefined;
      this.threads = [];
      this.pendingThreadStarts = 0;
      this.pendingThreadResumeId = undefined;
      this.locallyStartedThreads.clear();
      this.streamingAssistant = -1;
      this.clearPendingApprovals();
      this.options.publishRendererState();
      this.setStatus("idle");
      this.scheduleReconnect();
    });
    this.socket.addEventListener("error", (error) => {
      const details = describeSocketError(error, this.url);
      if (this.connectionError === details) {
        return;
      }
      this.connectionError = details;
      this.options.debug("Codex socket error", details);
      this.options.publishRendererState();
    });
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
      if (!threads.length) {
        this.threadId = undefined;
        this.history = [];
        this.streamingAssistant = -1;
        this.streamingAssistantItemId = undefined;
        this.workingSince = undefined;
        this.workedElapsed = undefined;
        this.activityIndexes.clear();
        this.clearPendingApprovals();
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
      if (resume && !this.connected) {
        this.resume(id);
      }
      this.options.publishRendererState();
      return;
    }
    this.threadId = id;
    this.activeTurnId = undefined;
    this.tokenUsage = undefined;
    if (!preserveHistory) this.history = [];
    this.streamingAssistant = -1;
    this.streamingAssistantItemId = undefined;
    this.workingSince = undefined;
    this.workedElapsed = undefined;
    this.interrupted = false;
    this.activityIndexes.clear();
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
      if (!message.error) {
        this.updateModelInfo(message);
        this.read(threadId);
        return;
      }
      const text =
        typeof (message.error as Record<string, unknown>).message === "string"
          ? ((message.error as Record<string, unknown>).message as string)
          : "";
      if (text.includes("already has an active writer")) {
        this.threadId = undefined;
        this.connected = false;
        this.history = [];
        this.threads = this.threads.filter((thread) => thread.id !== threadId);
        this.options.publishRendererState();
      }
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
      const thread = message.result?.thread;
      if (isThread(thread)) {
        this.threads = [
          thread,
          ...this.threads.filter((candidate) => candidate.id !== thread.id),
        ];
      }
      this.rememberWorkingDirectory(thread);
      this.connected = true;
      this.setStatusFromStatus(thread?.status);
      const turns = this.records(thread?.turns);
      const restoredTokenUsage = [...turns]
        .reverse()
        .map((turn) => parseTokenUsageValue(turn.tokenUsage ?? turn.usage))
        .find((usage): usage is ThreadTokenUsage => usage !== undefined);
      // A live usage notification can arrive while the history read is in
      // flight. Do not erase it when the read response has no persisted usage.
      if (restoredTokenUsage) {
        this.tokenUsage = restoredTokenUsage;
      }
      const restored: CodexMessage[] = [];
      for (const turn of turns) {
        const timestamp =
          typeof turn.createdAt === "number"
            ? turn.createdAt < 10_000_000_000
              ? turn.createdAt * 1000
              : turn.createdAt
            : Date.now();
        for (const item of this.records(turn.items)) {
          if (item.type === "userMessage") {
            for (const content of this.records(item.content)) {
              if (typeof content.text === "string" && content.text.trim()) {
                restored.push({
                  role: "user",
                  text: content.text.trim(),
                  timestamp,
                });
              }
            }
          }
          if (item.type === "agentMessage") {
            const text =
              typeof item.text === "string"
                ? item.text
                : this.records(item.content)
                    .map((part) =>
                      typeof part.text === "string" ? part.text : "",
                    )
                    .join("");
            if (text.trim()) {
              restored.push({
                role: "assistant",
                text: text.trim(),
                timestamp,
              });
            }
          }
          if (this.isActivityItem(item)) {
            restored.push(this.activityMessage(item, timestamp));
          }
        }
      }
      const restoredUsers = new Set(
        restored
          .filter((message) => message.role === "user")
          .map((message) => message.text),
      );
      const hasMissingLiveUser = this.history.some(
        (message) =>
          message.role === "user" && !restoredUsers.has(message.text),
      );
      if (
        !(this.status === "working" && this.history.length) &&
        !hasMissingLiveUser
      ) {
        this.history = restored;
        this.trim();
      }
      this.options.publishRendererState();
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

  /** Routes an app-server notification or request to its protocol handler. */
  private handleServerMessage(message: ServerMessage): void {
    const method = message.method;
    if (!method.startsWith("item")) {
      this.options.debug(message);
    }

    switch (method) {
      case "thread/started":
        this.handleThreadStarted(message);
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
        this.appendPlanDelta(message.params.itemId, message.params.delta);
        break;
      case "item/commandExecution/outputDelta":
        this.handleCommandOutputDelta(message);
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
        if (this.pendingUserInput?.requestId === message.params.requestId) {
          this.pendingUserInput = undefined;
          this.options.publishRendererState();
        }
        break;
    }

    const shouldShowPetForUpdate =
      method === "turn/completed" ||
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      (method === "thread/status/changed" &&
        message.params.status?.type === "idle");
    if (shouldShowPetForUpdate) {
      this.options.publishRendererState();
      this.options.showPetForUpdate();
    }
  }

  /** Selects and initializes a thread announced by the app server. */
  private handleThreadStarted(
    message: Extract<ServerMessage, { method: "thread/started" }>,
  ): void {
    const { thread } = message.params;
    this.rememberWorkingDirectory(thread);
    this.threads = [
      thread,
      ...this.threads.filter((candidate) => candidate.id !== thread.id),
    ];
    const locallyStarted = this.consumeLocalThreadStarted(thread.id);
    this.pendingThreadResumeId = locallyStarted ? undefined : thread.id;
    const preservePendingPrompt =
      this.threadId === undefined &&
      this.history.some((item) => item.role === "user");
    this.switchThread(thread.id, false, preservePendingPrompt);
  }

  /** Tracks the active turn and associates it with the latest user message. */
  private handleTurnStarted(
    message: Extract<ServerMessage, { method: "turn/started" }>,
  ): void {
    const turnId = message.params.turn.id;
    this.activeTurnId = turnId;
    const last = [...this.history]
      .reverse()
      .find((item) => item.role === "user" && !item.turnId);
    if (last) last.turnId = turnId;
    this.ensureWorking();
    this.setStatus("working");
  }

  /** Adds echoed user input and visible activity from a started item. */
  private handleItemStarted(
    message: Extract<ServerMessage, { method: "item/started" }>,
  ): void {
    this.setStatus("working");
    const item = isRecord(message.params.item)
      ? (message.params.item as Record<string, unknown>)
      : undefined;
    for (const content of this.records(item?.content)) {
      if (typeof content.text === "string" && !this.consume(content.text)) {
        this.insertUser(content.text, message.params.turnId);
      }
    }
    if (item && this.isActivityItem(item)) {
      this.addOrUpdateActivity(
        item,
        stringValue(item.id),
        item.type === "plan" ? "inProgress" : undefined,
      );
    }
  }

  /** Finalizes turn state and records token usage from a completed turn. */
  private handleTurnCompleted(
    message: Extract<ServerMessage, { method: "turn/completed" }>,
  ): void {
    if (this.pendingUserInput?.threadId === message.params.threadId) {
      this.pendingUserInput = undefined;
    }
    this.activeTurnId = undefined;
    this.interrupted = message.params.turn?.status === "interrupted";
    this.setStatus("idle");
    const turn = isRecord(message.params.turn)
      ? (message.params.turn as Record<string, unknown>)
      : undefined;
    const usage = parseTokenUsageValue(turn?.tokenUsage ?? turn?.usage);
    if (
      usage &&
      !this.startingNewThread &&
      this.matchesCurrentThread(message.params)
    ) {
      this.tokenUsage = usage;
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
    if (
      usage &&
      !this.startingNewThread &&
      this.matchesCurrentThread(message.params)
    ) {
      this.tokenUsage = usage;
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
    this.modelInfo = { ...this.modelInfo, model: message.params.toModel };
    this.options.publishRendererState();
  }

  /** Updates model metadata when thread settings change. */
  private handleThreadSettingsUpdated(
    message: Extract<ServerMessage, { method: "thread/settings/updated" }>,
  ): void {
    if (message.params.threadId !== this.threadId) return;
    const mode = message.params.threadSettings.collaborationMode?.mode;
    if (mode === "plan" || mode === "default") {
      this.collaborationMode = mode;
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
    if (threadId !== this.threadId) return;
    const previous = this.status;
    this.setStatusFromStatus(status);
    if (shouldReconcileOnIdle(previous, status, this.needsReconcile)) {
      this.needsReconcile = false;
      this.read(threadId);
    }
    if (status?.type === "active" && this.pendingThreadResumeId === threadId) {
      this.pendingThreadResumeId = undefined;
      this.resume(threadId);
    } else if (shouldResumeOnActiveStatus(this.connected, status)) {
      this.resume(threadId);
    }
  }

  /** Appends streamed assistant text to the conversation. */
  private handleAgentMessageDelta(
    message: Extract<ServerMessage, { method: "item/agentMessage/delta" }>,
  ): void {
    this.appendDelta(
      message.params.delta,
      message.params.itemId,
      message.params.turnId,
    );
  }

  /** Appends streamed command output to its activity message. */
  private handleCommandOutputDelta(
    message: Extract<
      ServerMessage,
      { method: "item/commandExecution/outputDelta" }
    >,
  ): void {
    this.appendActivityOutput(message.params.itemId, message.params.delta);
  }

  /** Stores a server request_user_input request for the renderer. */
  private handleUserInputRequest(
    message: Extract<ServerMessage, { method: "item/tool/requestUserInput" }>,
  ): void {
    this.pendingUserInput = {
      requestId: message.id,
      threadId: message.params.threadId,
      turnId: message.params.turnId,
      itemId: message.params.itemId,
      questions: message.params.questions,
      isBlocking: message.params.isBlocking,
    };
    this.setStatus("waiting");
    this.options.showPetForUpdate();
    this.options.publishRendererState();
    this.options.focusUserInput();
  }

  /** Commits a completed assistant or activity item to conversation history. */
  private handleItemCompleted(
    message: Extract<ServerMessage, { method: "item/completed" }>,
  ): void {
    const item = isRecord(message.params.item)
      ? message.params.item
      : undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      this.completeAssistant(item.text, stringValue(item.id));
    } else if (item && this.isActivityItem(item)) {
      this.addOrUpdateActivity(
        item,
        stringValue(item.id),
        item.type === "plan" ? "completed" : undefined,
      );
    }
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
    this.pendingApprovals.set(requestIdKey(id), {
      requestId: id,
      command,
      reason,
      decisions,
    });
    this.pendingApproval = {
      requestId: id,
      command,
      reason,
      options: approvalOptions(decisions),
    };
    this.options.showApproval(id, command, reason);
    this.setStatus("waiting");
  }

  /** Returns whether a notification belongs to the currently selected thread. */
  private matchesCurrentThread(params: { threadId?: string }): boolean {
    return (
      typeof params.threadId !== "string" || params.threadId === this.threadId
    );
  }

  /** Starts a text turn and creates a temporary working message. */
  private startTurn(threadId: string, prompt: string): void {
    this.needsReconcile = true;
    this.ensureWorking();
    const id = ++this.nextId;
    this.setRequest<TurnStartResponse>(id, (message) => {
      this.activeTurnId = message.result?.turn.id;
      if (message.error) {
        this.setStatus("idle");
      }
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
      mode: this.collaborationMode,
      settings: {
        model: this.modelInfo?.model ?? "gpt-5.1-codex",
        reasoning_effort: this.collaborationMode === "plan" ? "medium" : null,
        developer_instructions: null,
      },
    };
    this.send({
      method: "turn/start",
      id,
      params,
    } satisfies TurnStartRequest);
    this.setStatus("working");
  }

  /** Adds a deduplicated message received from a hook or prompt submission. */
  private addMessage(role: CodexMessage["role"], text: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
    this.clearStaleApprovals();
    this.history.push({
      role,
      text: value,
      timestamp: Date.now(),
    });
    this.trim();
    this.options.publishRendererState();
  }

  /** Inserts a remote user message before any currently streaming output. */
  private insertUser(text: string, turnId?: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
    this.clearStaleApprovals();
    if (
      turnId &&
      this.history.some(
        (message) =>
          message.role === "user" &&
          message.turnId === turnId &&
          message.text === value,
      )
    ) {
      return;
    }
    this.history.splice(
      this.streamingAssistant >= 0
        ? this.streamingAssistant
        : this.history.length,
      0,
      {
        role: "user",
        text: value,
        turnId,
        timestamp: Date.now(),
      },
    );
    if (this.streamingAssistant >= 0) {
      this.streamingAssistant += 1;
    }
    this.trim();
    this.options.publishRendererState();
  }

  /** Starts the live working indicator without adding a history message. */
  private ensureWorking(): void {
    if (this.workingSince === undefined) this.workingSince = Date.now();
    this.options.publishRendererState();
  }

  /** Appends an assistant stream delta to the current conversation. */
  private appendDelta(delta: string, itemId?: string, turnId?: string): void {
    if (!delta) {
      return;
    }
    this.clearStaleApprovals();
    if (
      this.streamingAssistant < 0 ||
      (itemId !== undefined && itemId !== this.streamingAssistantItemId)
    ) {
      this.history.push({
        role: "assistant",
        text: delta,
        timestamp: Date.now(),
        turnId,
        itemId,
      });
      this.streamingAssistant = this.history.length - 1;
      this.streamingAssistantItemId = itemId;
    } else {
      const current = this.history[this.streamingAssistant];
      if (!current || current.role !== "assistant") {
        this.history.push({
          role: "assistant",
          text: delta,
          timestamp: Date.now(),
          turnId,
          itemId,
        });
        this.streamingAssistant = this.history.length - 1;
        this.streamingAssistantItemId = itemId;
      } else {
        current.text += delta;
      }
    }
    this.trim();
    this.options.publishRendererState();
  }

  /** Replaces temporary output with the completed assistant message. */
  private completeAssistant(text: string, itemId?: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
    this.clearStaleApprovals();
    const current =
      this.history.find(
        (x) => x.role === "assistant" && itemId && x.itemId === itemId,
      ) ??
      (this.streamingAssistant >= 0
        ? this.history[this.streamingAssistant]
        : undefined);
    if (current) {
      current.text = value;
      current.itemId = itemId ?? current.itemId;
    } else if (
      this.streamingAssistant >= 0 &&
      this.history[this.streamingAssistant]?.role === "assistant"
    ) {
      this.history[this.streamingAssistant].text = value;
    } else {
      this.history.push({
        role: "assistant",
        text: value,
        timestamp: Date.now(),
      });
    }
    this.streamingAssistant = -1;
    this.streamingAssistantItemId = undefined;
    this.trim();
    this.options.publishRendererState();
  }

  /** Creates or updates a visible command/file activity message. */
  private addOrUpdateActivity(
    item: Record<string, unknown>,
    itemId?: string,
    statusOverride?: string,
  ): void {
    const message = this.activityMessage(
      statusOverride && item.type === "plan"
        ? { ...item, status: statusOverride }
        : item,
      Date.now(),
    );
    message.itemId = itemId;
    const existingIndex = itemId ? this.activityIndexes.get(itemId) : undefined;
    if (existingIndex !== undefined && this.history[existingIndex]) {
      const existing = this.history[existingIndex];
      if (existing.activity && !message.activity?.output) {
        if (message.activity) {
          message.activity.output = existing.activity.output;
          message.text = formatActivityText(message.activity);
        }
      }
      existing.text = message.text;
      existing.activity = message.activity;
      existing.itemId = itemId;
    } else {
      this.history.push(message);
      if (itemId) this.activityIndexes.set(itemId, this.history.length - 1);
    }
    this.trim();
    this.options.publishRendererState();
  }

  /** Returns true for non-message items that should be visible in the activity feed. */
  private isActivityItem(item: Record<string, unknown> | undefined): boolean {
    const type = typeof item?.type === "string" ? item.type : "";
    return (
      Boolean(type) &&
      type !== "userMessage" &&
      type !== "agentMessage" &&
      !/reasoning/i.test(type)
    );
  }

  /** Appends streamed command output to its activity history entry. */
  private appendActivityOutput(
    itemId: string | undefined,
    delta: string,
  ): void {
    if (!itemId || !delta) return;
    const index = this.activityIndexes.get(itemId);
    if (index === undefined) return;
    const message = this.history[index];
    if (!message.activity) return;
    message.activity.output = `${message.activity.output ?? ""}${delta}`;
    message.text = formatActivityText(message.activity);
    this.options.publishRendererState();
  }

  /** Appends streamed plan text to its activity history entry. */
  private appendPlanDelta(itemId: string, delta: string): void {
    if (!delta) return;
    const index = this.activityIndexes.get(itemId);
    if (index === undefined) return;
    const message = this.history[index];
    if (!message.activity || message.activity.kind !== "plan") return;
    message.activity.details = `${message.activity.details ?? ""}${delta}`;
    message.text = formatActivityText(message.activity);
    this.options.publishRendererState();
  }

  /** Converts a persisted or live app-server item into a system message. */
  private activityMessage(
    item: Record<string, unknown>,
    timestamp: number,
  ): CodexMessage {
    const type = typeof item.type === "string" ? item.type : "unknown";
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
    const changes = this.records(item.changes).map((change) => {
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
      label: type,
      status:
        typeof item.status === "string"
          ? item.status
          : kind === "plan"
            ? "completed"
            : undefined,
      command: typeof item.command === "string" ? item.command : undefined,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      summary: firstText(item, ["query", "title", "name", "url", "message"]),
      output:
        typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : undefined,
      changes,
      details:
        kind === "plan"
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

  /** Removes pending approvals when a later conversation message supersedes them. */
  private clearStaleApprovals(): void {
    if (!this.pendingApprovals.size) return;
    this.pendingApprovals.clear();
    this.pendingApproval = undefined;
    const next = this.history.filter((x) => x.approval?.state !== "pending");
    if (next.length !== this.history.length) {
      this.history = next;
      this.options.publishRendererState();
    }
    if (this.status === "waiting") this.setStatus("working");
  }

  /** Clears protocol approvals during transport/session cleanup. */
  private clearPendingApprovals(): void {
    this.pendingApprovals.clear();
    this.pendingApproval = undefined;
    const next = this.history.filter((x) => x.approval?.state !== "pending");
    if (next.length !== this.history.length) this.history = next;
  }

  /** Detects an echoed prompt emitted after Pesk submitted it. */
  private consume(text: string): boolean {
    const key = text.trim();
    const at = this.prompts.get(key);
    if (at === undefined) {
      return false;
    }
    this.prompts.delete(key);
    return Date.now() - at < 10_000;
  }

  /** Retains only the most recent renderer history entries. */
  private trim(): void {
    const removed = Math.max(0, this.history.length - MAX_HISTORY);
    if (removed > 0) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
    this.rebuildActivityIndexes();

    if (removed > 0 && this.streamingAssistant >= 0) {
      this.streamingAssistant -= removed;
      if (
        this.streamingAssistant < 0 ||
        this.streamingAssistant >= this.history.length
      ) {
        this.streamingAssistant = -1;
        this.streamingAssistantItemId = undefined;
      }
    }
  }

  /** Rebuilds activity-item indexes after history changes or trimming. */
  private rebuildActivityIndexes(): void {
    this.activityIndexes.clear();
    this.history.forEach((message, index) => {
      if (message.itemId && message.activity) {
        this.activityIndexes.set(message.itemId, index);
      }
    });
  }

  /** Updates status and publishes the new renderer snapshot. */
  private setStatus(status: CodexState["status"]): void {
    if (status !== "waiting" && this.pendingApprovals.size > 0) {
      status = "waiting";
    }
    this.status = status;
    if (status === "working" && this.workingSince === undefined) {
      this.workingSince = Date.now();
    }
    if (status === "idle") {
      if (this.workingSince !== undefined) {
        this.workedElapsed = Math.max(0, Date.now() - this.workingSince);
      }
      this.workingSince = undefined;
      this.streamingAssistant = -1;
      this.streamingAssistantItemId = undefined;
    }
    this.options.publishRendererState();
  }

  /** Maps app-server thread status and approval flags to Pesk status. */
  private setStatusFromStatus(status: ThreadStatus | undefined): void {
    if (status?.type === "active") {
      this.setStatus(
        status.activeFlags?.includes("waitingOnApproval")
          ? "waiting"
          : "working",
      );
    } else if (status?.type === "idle" || status?.type === "notLoaded") {
      this.setStatus("idle");
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
    const next: CodexModelInfo = {
      model: stringValue(value.model),
      provider: stringValue(value.modelProvider),
      reasoningEffort: stringValue(value.reasoningEffort ?? value.effort),
      serviceTier: stringValue(value.serviceTier),
    };
    const defined = Object.fromEntries(
      Object.entries(next).filter(([, entry]) => entry !== undefined),
    ) as CodexModelInfo;
    if (Object.keys(defined).length > 0) {
      this.modelInfo = { ...this.modelInfo, ...defined };
      this.options.publishRendererState();
    }
  }

  /** Remembers the server-native directory associated with a thread. */
  private rememberWorkingDirectory(
    thread: Record<string, unknown> | undefined,
  ): void {
    if (typeof thread?.cwd === "string" && thread.cwd.trim()) {
      this.workingDirectory = thread.cwd.trim();
    }
  }

  /** Safely narrows an unknown value to a list of object records. */
  private records(value: unknown): Array<Record<string, unknown>> {
    return (Array.isArray(value) ? value : []).filter(
      (x): x is Record<string, unknown> => Boolean(x && typeof x === "object"),
    );
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

function firstText(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key] as string;
    }
  }
  return undefined;
}

function indentActivityContent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Converts a browser WebSocket error event into useful diagnostic text. */
function describeSocketError(error: unknown, url: string): string {
  if (error instanceof Error) {
    return `url=${url}; name=${error.name}; message=${error.message}`;
  }
  if (error && typeof error === "object") {
    const event = error as {
      type?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const nestedError =
      event.error && typeof event.error === "object"
        ? (event.error as { name?: unknown; message?: unknown })
        : undefined;
    const details = [
      `url=${url}`,
      typeof event.type === "string" ? `type=${event.type}` : "",
      typeof event.message === "string" && event.message
        ? `message=${event.message}`
        : "",
      typeof nestedError?.name === "string" ? `name=${nestedError.name}` : "",
      typeof nestedError?.message === "string" && nestedError.message
        ? `error=${nestedError.message}`
        : "",
    ].filter(Boolean);
    return details.join("; ");
  }
  return `url=${url}; error=${String(error)}`;
}

function parseTokenUsageValue(value: unknown): ThreadTokenUsage | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && "id" in value && !("method" in value);
}

function isThread(value: unknown): value is Thread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.status) &&
    typeof value.status.type === "string"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export interface ThreadStatusLike {
  type?: unknown;
}

/** Whether an active remote thread should be resumed by Pesk. */
export function shouldResumeOnActiveStatus(
  connected: boolean,
  status: ThreadStatusLike | undefined,
): boolean {
  return !connected && status?.type === "active";
}

/** Whether an idle transition should trigger a fresh history read. */
export function shouldReconcileOnIdle(
  previousStatus: string,
  status: ThreadStatusLike | undefined,
  needsReconcile: boolean,
): boolean {
  return (
    status?.type === "idle" && (previousStatus === "working" || needsReconcile)
  );
}
