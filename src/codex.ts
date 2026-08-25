/** A message displayed in the Pesk Codex conversation. */
export interface CodexMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
  temporary?: boolean;
  turnId?: string;
  itemId?: string;
  activity?: {
    kind: "command" | "fileChange" | "webSearch" | "tool" | "other";
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
  };
}

/** The session metadata required by the renderer's session selector. */
export interface CodexThreadSummary {
  id: string;
  preview?: string;
  status?: string;
}

/** Codex-related settings persisted alongside the pet settings. */
/** State exposed by the controller to the Electron renderer. */
export interface CodexState {
  threadId?: string;
  error?: string;
  status: "idle" | "working" | "waiting";
  connected: boolean;
  activity: Record<string, unknown> | null;
  history: CodexMessage[];
  threads: CodexThreadSummary[];
  workingSince?: number;
  workedElapsed?: number;
}

interface Options {
  sendSettings: () => void;
  showPetForUpdate: () => void;
  showApproval: (requestId: number, command: string, reason: string) => void;
  debug: (...values: unknown[]) => void;
}

/**
 * Owns the Codex app-server connection and translates protocol events into
 * renderer-friendly conversation and status state.
 *
 * Window management remains in main.ts; callbacks notify it about UI changes.
 */
export class CodexController {
  private socket: WebSocket | null = null;
  private url = "ws://127.0.0.1:4500";
  private workingDirectory = process.cwd();
  private threadId: string | undefined;
  private status: CodexState["status"] = "idle";
  private connected = false;
  private activity: Record<string, unknown> | null = null;
  private connectionError: string | undefined;
  private history: CodexMessage[] = [];
  private threads: CodexThreadSummary[] = [];
  private workingSince: number | undefined;
  private workedElapsed: number | undefined;
  private streamingAssistant = -1;
  private streamingAssistantItemId: string | undefined;
  private readonly activityIndexes = new Map<string, number>();
  private needsReconcile = false;
  private initialized = false;
  private nextId = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private discoveryPending = false;
  private readonly requests = new Map<
    number,
    (message: Record<string, unknown>) => void
  >();
  private readonly prompts = new Map<string, number>();
  constructor(private readonly options: Options) {}

  /** Returns the current state snapshot for renderer IPC responses. */
  getState(): CodexState {
    return {
      threadId: this.threadId,
      error: this.connectionError,
      status: this.status,
      connected: this.connected,
      activity: this.activity,
      history: this.history,
      threads: this.threads,
      workingSince: this.workingSince,
      workedElapsed: this.workedElapsed,
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
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }
    this.socket?.close();
  }

  /** Selects a known Codex thread and resumes it. */
  selectThread(id: string): void {
    this.switchThread(id);
  }

  /** Starts a prompt turn when the controller is initialized and idle. */
  submitPrompt(value: unknown): boolean {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      !this.initialized ||
      this.status !== "idle"
    )
      return false;
    const prompt = value.trim();
    this.workingSince = undefined;
    this.workedElapsed = undefined;
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
        cwd: process.cwd(),
        serviceName: "pesk",
      },
    });
    this.requests.set(id, (message) => {
      const thread = this.resultThread(message);
      if (typeof thread?.id === "string") {
        this.connected = true;
        this.options.sendSettings();
        this.rememberWorkingDirectory(thread);
        this.startTurn(thread.id, prompt);
      }
    });
    return true;
  }

  /** Starts and selects a fresh Codex session without sending a prompt. */
  startNewThread(workingDirectory?: string): boolean {
    if (!this.initialized || this.status !== "idle") {
      return false;
    }
    const cwd = (workingDirectory ?? this.workingDirectory).trim();
    if (!cwd) {
      return false;
    }
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
    });
    this.requests.set(id, (message) => {
      const thread = this.resultThread(message);
      if (typeof thread?.id !== "string") {
        return;
      }
      this.rememberWorkingDirectory(thread);
      this.threadId = thread.id;
      this.connected = true;
      this.history = [];
      this.streamingAssistant = -1;
      this.streamingAssistantItemId = undefined;
      this.workingSince = undefined;
      this.workedElapsed = undefined;
      this.activityIndexes.clear();
      this.threads = [
        { id: thread.id, status: "idle" },
        ...this.threads.filter((candidate) => candidate.id !== thread.id),
      ];
      this.options.sendSettings();
    });
    return true;
  }

  /** Sends an approval response for an app-server request. */
  respondPermission(requestId: unknown, decision: unknown): void {
    if (
      this.activity?.approval !== true ||
      typeof requestId !== "number" ||
      typeof decision !== "string"
    )
      return;
    this.send({
      id: requestId,
      result: {
        decision,
      },
    });
    this.updateApproval(
      requestId,
      decision === "accept" || decision === "acceptForSession"
        ? "approved"
        : "denied",
    );
    this.activity = null;
    this.setStatus("working");
  }

  /** Sends one newline-delimited JSON-RPC message to the app server. */
  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(`${JSON.stringify(message)}\n`);
    }
  }

  /** Opens the socket and wires protocol, close, and error events. */
  private connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    )
      return;
    try {
      this.socket = new WebSocket(this.url);
    } catch (error) {
      this.options.debug("Codex connection failed", error);
      this.scheduleReconnect();
      return;
    }
    this.socket.addEventListener("open", () => {
      this.connectionError = undefined;
      this.options.sendSettings();
      const id = ++this.nextId;
      this.requests.set(id, () => {
        this.send({
          method: "initialized",
          params: {},
        });
        this.initialized = true;
        this.connected = false;
        this.threadId = undefined;
        this.options.sendSettings();
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
        },
      });
    });
    this.socket.addEventListener("message", (event) => {
      try {
        this.handle(JSON.parse(String(event.data)) as Record<string, unknown>);
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
      this.threads = [];
      this.streamingAssistant = -1;
      this.activity = null;
      this.options.sendSettings();
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
      this.options.sendSettings();
    });
  }

  /** Finds the loaded or most recent active Codex session after initialization. */
  private discover(): void {
    if (!this.initialized || this.discoveryPending) {
      return;
    }
    this.discoveryPending = true;
    const choose = (id: string): void => {
      this.discoveryPending = false;
      this.switchThread(id);
    };
    const list = (): void => {
      const id = ++this.nextId;
      this.requests.set(id, (message) => {
        const data = (message.result as Record<string, unknown> | undefined)
          ?.data;
        const active = (Array.isArray(data) ? data : [])
          .filter((x): x is Record<string, unknown> =>
            Boolean(x && typeof x === "object"),
          )
          .filter((x) => {
            const s =
              x.status && typeof x.status === "object"
                ? (x.status as Record<string, unknown>)
                : undefined;
            return s?.type === "active" || s?.type === "idle";
          });
        this.threads = active
          .filter((x) => typeof x.id === "string")
          .map((x) => ({
            id: x.id as string,
            preview: typeof x.preview === "string" ? x.preview : undefined,
            status: (x.status as Record<string, unknown> | undefined)?.type as
              string | undefined,
          }));
        if (!active.length) {
          this.threadId = undefined;
          this.history = [];
          this.streamingAssistant = -1;
          this.streamingAssistantItemId = undefined;
          this.workingSince = undefined;
          this.workedElapsed = undefined;
          this.activityIndexes.clear();
          this.activity = null;
        }
        this.options.sendSettings();
        const firstSession = active.find(
          (session) => typeof session.id === "string",
        );
        if (firstSession) {
          choose(firstSession.id as string);
        }
      });
      this.send({
        method: "thread/list",
        id,
        params: {
          limit: 20,
          sortKey: "recency_at",
          sortDirection: "desc",
        },
      });
    };
    const id = ++this.nextId;
    this.requests.set(id, (message) => {
      const data = (message.result as Record<string, unknown> | undefined)
        ?.data;
      const loaded = Array.isArray(data)
        ? data.filter((x): x is string => typeof x === "string")
        : [];
      if (loaded.length === 1) {
        choose(loaded[0]);
      } else {
        list();
      }
    });
    this.send({
      method: "thread/loaded/list",
      id,
    });
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
      this.options.sendSettings();
      return;
    }
    this.threadId = id;
    if (!preserveHistory) this.history = [];
    this.streamingAssistant = -1;
    this.streamingAssistantItemId = undefined;
    this.workingSince = undefined;
    this.workedElapsed = undefined;
    this.activityIndexes.clear();
    this.options.sendSettings();
    if (resume) {
      this.resume(id);
    }
  }

  /** Resumes a thread, retrying briefly while its rollout is being created. */
  private resume(threadId: string, attempt = 0): void {
    if (!this.initialized) {
      return;
    }
    const id = ++this.nextId;
    this.requests.set(id, (message) => {
      if (!message.error) {
        this.read(threadId);
        return;
      }
      const text =
        typeof (message.error as Record<string, unknown>).message === "string"
          ? ((message.error as Record<string, unknown>).message as string)
          : "";
      if (text.includes("no rollout found") && attempt < 3) {
        this.resumeTimer = setTimeout(
          () => this.resume(threadId, attempt + 1),
          500,
        );
        return;
      }
      if (text.includes("already has an active writer")) {
        this.threadId = undefined;
        this.connected = false;
        this.history = [];
        this.threads = this.threads.filter((thread) => thread.id !== threadId);
        this.options.sendSettings();
      }
    });
    this.send({
      method: "thread/resume",
      id,
      params: {
        threadId,
      },
    });
  }

  /** Reads persisted turns and converts them into renderer messages. */
  private read(threadId: string): void {
    const id = ++this.nextId;
    this.requests.set(id, (message) => {
      const thread = this.resultThread(message);
      if (thread?.canAcceptDirectInput === false) {
        this.threadId = undefined;
        this.connected = false;
        this.history = [];
        this.options.sendSettings();
        return;
      }
      this.rememberWorkingDirectory(thread);
      this.connected = true;
      this.setStatusFromThread(thread);
      const restored: CodexMessage[] = [];
      for (const turn of this.records(thread?.turns)) {
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
        this.rebuildActivityIndexes();
      }
      this.options.sendSettings();
    });
    this.send({
      method: "thread/read",
      id,
      params: {
        threadId,
        includeTurns: true,
      },
    });
  }

  /** Dispatches JSON-RPC responses and app-server notifications. */
  private handle(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) {
      const callback = this.requests.get(id);
      if (callback) {
        this.requests.delete(id);
        callback(message);
      }
    }
    const method = typeof message.method === "string" ? message.method : "";
    const params =
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    if (
      [
        "turn/started",
        "item/started",
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
        "thread/status/changed",
      ].includes(method)
    )
      this.hidePendingApprovals();
    const threadStatus =
      params.status && typeof params.status === "object"
        ? (params.status as Record<string, unknown>)
        : undefined;
    if (
      method === "turn/completed" ||
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      (method === "thread/status/changed" && threadStatus?.type === "idle")
    )
      this.options.showPetForUpdate();
    const thread =
      params.thread && typeof params.thread === "object"
        ? (params.thread as Record<string, unknown>)
        : undefined;
    if (
      (method === "thread/started" || method === "thread/resumed") &&
      typeof thread?.id === "string"
    ) {
      this.rememberWorkingDirectory(thread);
      if (method === "thread/started") {
        this.threads = [
          {
            id: thread.id,
            status: "active",
          },
        ];
      }
      const preservePendingPrompt =
        method === "thread/started" &&
        this.threadId === undefined &&
        this.history.some((item) => item.role === "user");
      this.switchThread(
        thread.id,
        method !== "thread/started",
        preservePendingPrompt,
      );
    }
    if (method === "turn/started") {
      const turn =
        params.turn && typeof params.turn === "object"
          ? (params.turn as Record<string, unknown>)
          : undefined;
      const turnId = typeof turn?.id === "string" ? turn.id : undefined;
      const last = [...this.history]
        .reverse()
        .find((item) => item.role === "user" && !item.turnId);
      if (last) {
        last.turnId = turnId;
      }
      this.ensureWorking(turnId);
      this.setStatus("working");
    }
    if (method === "item/started") {
      this.setStatus("working");
      const item =
        params.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : undefined;
      for (const content of this.records(item?.content)) {
        if (typeof content.text === "string" && !this.consume(content.text)) {
          this.insertUser(
            content.text,
            typeof params.turnId === "string" ? params.turnId : undefined,
          );
        }
      }
      if (item && this.isActivityItem(item)) {
        this.addOrUpdateActivity(
          item,
          typeof item.id === "string" ? item.id : undefined,
        );
      }
    }
    if (method === "turn/completed") {
      this.activity = message;
      this.setStatus("idle");
    }
    if (
      method === "thread/status/changed" &&
      params.threadId === this.threadId
    ) {
      const status =
        params.status && typeof params.status === "object"
          ? (params.status as Record<string, unknown>)
          : undefined;
      const previous = this.status;
      this.setStatusFromThread({
        status,
      });
      if (shouldReconcileOnIdle(previous, status, this.needsReconcile)) {
        this.needsReconcile = false;
        this.read(params.threadId as string);
      }
      if (shouldResumeOnActiveStatus(this.connected, status)) {
        this.resume(params.threadId as string);
      }
    }
    if (method === "item/agentMessage/delta") {
      this.appendDelta(
        typeof params.delta === "string" ? params.delta : "",
        typeof params.itemId === "string" ? params.itemId : undefined,
        typeof params.turnId === "string" ? params.turnId : undefined,
      );
      this.activity = message;
    }
    if (method === "item/commandExecution/outputDelta") {
      this.appendActivityOutput(
        typeof params.itemId === "string" ? params.itemId : undefined,
        typeof params.delta === "string" ? params.delta : "",
      );
    }
    if (method === "item/completed") {
      const item =
        params.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.completeAssistant(
          item.text,
          typeof item.id === "string" ? item.id : undefined,
        );
      } else if (item && this.isActivityItem(item)) {
        this.addOrUpdateActivity(
          item,
          typeof item.id === "string" ? item.id : undefined,
        );
      }
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.options.showApproval(
        id ?? 0,
        typeof params.command === "string" ? params.command : "",
        typeof params.reason === "string" ? params.reason : "",
      );
      this.activity = {
        ...message,
        approval: true,
        requestId: id,
      };
      this.addApproval(
        id ?? 0,
        typeof params.command === "string" ? params.command : "",
        typeof params.reason === "string" ? params.reason : "",
      );
      this.setStatus("waiting");
    }
  }

  /** Starts a text turn and creates a temporary working message. */
  private startTurn(threadId: string, prompt: string): void {
    this.needsReconcile = true;
    this.ensureWorking();
    const id = ++this.nextId;
    this.requests.set(id, (message) => {
      if (message.error) {
        this.setStatus("idle");
      }
    });
    this.send({
      method: "turn/start",
      id,
      params: {
        threadId,
        input: [
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    });
    this.setStatus("working");
  }

  /** Adds a deduplicated message received from a hook or prompt submission. */
  private addMessage(role: CodexMessage["role"], text: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
    this.history.push({
      role,
      text: value,
      timestamp: Date.now(),
    });
    this.trim();
    this.options.sendSettings();
  }

  /** Inserts a remote user message before any currently streaming output. */
  private insertUser(text: string, turnId?: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
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
    this.rebuildActivityIndexes();
    this.trim();
    this.options.sendSettings();
  }

  /** Starts the live working indicator without adding a history message. */
  private ensureWorking(turnId?: string): void {
    if (this.workingSince === undefined) this.workingSince = Date.now();
    this.options.sendSettings();
  }

  /** Appends an assistant stream delta to the current conversation. */
  private appendDelta(delta: string, itemId?: string, turnId?: string): void {
    if (!delta) {
      return;
    }
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
    this.options.sendSettings();
  }

  /** Replaces temporary output with the completed assistant message. */
  private completeAssistant(text: string, itemId?: string): void {
    const value = text.trim();
    if (!value) {
      return;
    }
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
    this.options.sendSettings();
  }

  /** Creates or updates a visible command/file activity message. */
  private addOrUpdateActivity(
    item: Record<string, unknown>,
    itemId?: string,
  ): void {
    const message = this.activityMessage(item, Date.now());
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
    this.options.sendSettings();
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
    this.options.sendSettings();
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
      status: typeof item.status === "string" ? item.status : undefined,
      command: typeof item.command === "string" ? item.command : undefined,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      summary: firstText(item, ["query", "title", "name", "url", "message"]),
      output:
        typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : undefined,
      changes,
      details:
        kind === "command" || kind === "fileChange"
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

  /** Adds a pending command or file-change approval to conversation history. */
  private addApproval(
    requestId: string | number,
    command: string,
    reason: string,
  ): void {
    if (
      this.history.some(
        (message) =>
          message.approval?.requestId === requestId &&
          message.approval.state === "pending",
      )
    ) {
      return;
    }
    this.history.push({
      role: "system",
      text:
        [command, reason].filter(Boolean).join("\n") ||
        "Codex requests approval.",
      timestamp: Date.now(),
      approval: {
        requestId,
        state: "pending",
      },
    });
    this.trim();
    this.options.sendSettings();
  }

  /** Marks a matching pending approval as accepted or denied. */
  private updateApproval(
    id: string | number,
    state: "approved" | "denied",
  ): void {
    const item = this.history.find(
      (x) => x.approval?.requestId === id && x.approval.state === "pending",
    );
    if (item?.approval) {
      item.approval.state = state;
      this.options.sendSettings();
    }
  }

  /** Removes stale pending approvals once new live activity arrives. */
  private hidePendingApprovals(): void {
    const next = this.history.filter((x) => x.approval?.state !== "pending");
    if (next.length !== this.history.length) {
      this.history = next;
      this.options.sendSettings();
    }
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

  /** Retains the complete renderer history for scrolling and review. */
  private trim(): void {
    // History is intentionally unbounded; the renderer's history panel scrolls.
  }

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
    this.options.sendSettings();
  }

  /** Maps app-server thread status and approval flags to Pesk status. */
  private setStatusFromThread(
    thread: Record<string, unknown> | undefined,
  ): void {
    const status =
      thread?.status && typeof thread.status === "object"
        ? (thread.status as Record<string, unknown>)
        : undefined;
    if (status?.type === "active") {
      this.setStatus(
        Array.isArray(status.activeFlags) &&
          status.activeFlags.includes("waitingOnApproval")
          ? "waiting"
          : "working",
      );
    } else if (status?.type === "idle" || status?.type === "notLoaded") {
      this.setStatus("idle");
    }
  }

  /** Extracts a thread object from a JSON-RPC result. */
  private resultThread(
    message: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    return (message.result as Record<string, unknown> | undefined)?.thread as
      Record<string, unknown> | undefined;
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
