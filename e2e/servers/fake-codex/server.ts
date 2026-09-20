import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

export interface FakeCodexThread {
  id: string;
  preview: string;
  cwd: string;
  projectId: string | null;
  name?: string | null;
  status?: { type: "idle" | "active"; activeFlags?: string[] };
  turns?: Array<Record<string, unknown>>;
}

export interface FakeCodexProject {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
  metadata: Record<string, string>;
  position: number;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
}

export interface FakeCodexFileChange {
  kind: "added" | "modified" | "deleted";
  path: string;
  diff?: string;
}

/**
 * Minimal app-server protocol fixture for Electron E2E tests.
 * It speaks over the same WebSocket endpoint as CodexWebSocketTransport and
 * deliberately keeps server state outside Electron so restart/switch tests
 * can control the authoritative source independently.
 */
export class FakeCodexAppServer {
  port: number;
  readonly threads: FakeCodexThread[];
  readonly projects: FakeCodexProject[];
  readonly methods: string[] = [];
  readonly serverMethods: string[] = [];
  readonly prompts: string[] = [];
  readonly streamDeltas: string[] = [];
  readonly turnEvents: string[] = [];
  readonly permissionResponses: unknown[] = [];
  readonly userInputResponses: unknown[] = [];
  readonly dynamicToolResponses: unknown[] = [];
  lateMutationAttempts = 0;
  private approvalEnabled = false;
  private userInputEnabled = false;
  private longRunning = false;
  private fileChangeEnabled = false;
  private fileChanges: FakeCodexFileChange[] = [];
  private remoteTerminalEnabled = false;
  private turnDelayMs = 20;
  private streamingDelayMs = 0;
  private nextQueuedSubmissionId = 1;
  private readonly longRunningTurns = new Map<string, WebSocket>();
  private readonly threadResponses = new Map<string, string>();
  private readonly pendingPrompts = new Map<string, string>();
  private readonly queuedPrompts = new Map<
    string,
    Array<{ id: string; text: string; clientUserMessageId: string }>
  >();
  private approvalSocket: WebSocket | undefined;
  private approvalThreadId = "";
  private expectedApprovalResponses = 1;
  private receivedApprovalResponses = 0;
  private attentionRequestId = 700;
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(
    options: {
      port?: number;
      threads?: FakeCodexThread[];
      projects?: FakeCodexProject[];
    } = {},
  ) {
    this.port = options.port ?? 0;
    this.threads = options.threads ?? [
      {
        id: "e2e-thread-1",
        preview: "Fixture thread",
        cwd: "/tmp/pesk-e2e-workspace",
        projectId: null,
      },
    ];
    this.projects = options.projects ?? [];
    this.server = new WebSocketServer({ port: this.port });
    this.server.on("connection", (socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      socket.on("message", (raw) => this.handle(socket, String(raw)));
    });
  }

  async ready(): Promise<void> {
    const current = this.server.address();
    if (current && typeof current === "object") {
      this.port = (current as AddressInfo).port;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      this.server.once("listening", onListening);
      this.server.once("error", onError);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Fake app-server has no address");
    this.port = (address as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  enableApproval(): void {
    this.approvalEnabled = true;
    this.expectedApprovalResponses = 1;
    this.receivedApprovalResponses = 0;
  }

  enableMultipleApprovals(): void {
    this.approvalEnabled = true;
    this.expectedApprovalResponses = 2;
    this.receivedApprovalResponses = 0;
  }

  disableApproval(): void {
    this.approvalEnabled = false;
    this.expectedApprovalResponses = 1;
    this.receivedApprovalResponses = 0;
  }

  emitLateApprovalCompletion(): void {
    this.lateMutationAttempts += 1;
    if (this.approvalSocket?.readyState === WebSocket.OPEN) {
      this.emitTurnCompletion(this.approvalSocket, this.approvalThreadId);
    }
  }

  enableUserInput(): void {
    this.userInputEnabled = true;
  }

  enableLongRunning(): void {
    this.longRunning = true;
  }

  disableLongRunning(): void {
    this.longRunning = false;
  }

  setThreadResponse(threadId: string, response: string): void {
    this.threadResponses.set(threadId, response);
  }

  setTurnDelay(milliseconds: number): void {
    this.turnDelayMs = milliseconds;
  }

  setStreamingDelay(milliseconds: number): void {
    this.streamingDelayMs = milliseconds;
  }

  completeLongRunning(threadId?: string): void {
    const entries = threadId
      ? [[threadId, this.longRunningTurns.get(threadId)] as const]
      : [...this.longRunningTurns.entries()];
    for (const [activeThreadId, socket] of entries) {
      if (!socket) continue;
      this.longRunningTurns.delete(activeThreadId);
      this.emitTurnCompletion(socket, activeThreadId);
    }
  }

  hasLongRunningTurn(threadId = this.threads[0]?.id ?? "e2e-thread-1"): boolean {
    return this.longRunningTurns.has(threadId);
  }

  queuedSubmissionTexts(threadId = this.threads[0]?.id ?? "e2e-thread-1"): string[] {
    return (this.queuedPrompts.get(threadId) ?? []).map((submission) => submission.text);
  }

  enableFileChange(
    changes: FakeCodexFileChange[] = [
      {
        kind: "modified",
        path: "src/example.ts",
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
  ): void {
    this.fileChangeEnabled = true;
    this.fileChanges = changes.map((change) => ({ ...change }));
  }

  enableRemoteTerminal(): void {
    this.remoteTerminalEnabled = true;
  }

  disconnect(): void {
    for (const client of this.clients) client.terminate();
  }

  emitApprovalForThread(threadId: string, command: string): void {
    const socket = [...this.clients].find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("Fake Codex app-server has no connected client");
    const requestId = this.attentionRequestId++;
    this.approvalSocket = socket;
    this.approvalThreadId = threadId;
    this.notify(
      socket,
      "item/commandExecution/requestApproval",
      {
        threadId,
        turnId: `attention-turn-${requestId}`,
        itemId: `attention-item-${requestId}`,
        approvalId: null,
        kind: "command",
        environmentId: null,
        command,
        cwd: "/tmp/pesk-e2e-workspace",
        reason: "E2E attention request",
        startedAtMs: 1,
      },
      requestId,
    );
  }

  emitTurnStartedForThread(threadId: string): void {
    const socket = [...this.clients].find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("Fake Codex app-server has no connected client");
    this.notify(socket, "turn/started", {
      threadId,
      turn: this.turn(`attention-turn-${this.attentionRequestId++}`, "inProgress"),
    });
  }

  async close(): Promise<void> {
    if (!this.server.address()) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.disconnect();
    });
  }

  private handle(socket: WebSocket, raw: string): void {
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      const method = typeof message.method === "string" ? message.method : "";
      if (method) this.methods.push(method);
      if (!method && typeof message.id === "number" && message.result) {
        if (message.id === 303 && this.remoteTerminalEnabled) {
          this.dynamicToolResponses.push(message.result);
          this.notifyRemoteExecute(socket);
        } else if (message.id === 304) this.dynamicToolResponses.push(message.result);
        else if (this.userInputEnabled) this.userInputResponses.push(message.result);
        else this.permissionResponses.push(message.result);
        if (message.id === 304 && this.approvalSocket) {
          this.emitTurnCompletion(this.approvalSocket, this.approvalThreadId);
        } else if (this.approvalSocket && message.id !== 303 && message.id !== 304) {
          this.receivedApprovalResponses += 1;
          if (this.receivedApprovalResponses >= this.expectedApprovalResponses)
            this.emitTurnCompletion(this.approvalSocket, this.approvalThreadId);
        }
        continue;
      }
      if (typeof message.id !== "number") continue;
      switch (method) {
        case "initialize":
          this.reply(socket, message.id, {
            userAgent: "fake-codex-e2e",
            codexHome: "/tmp/pesk-e2e-codex-home",
            platformFamily: "unix",
            platformOs: "linux",
          });
          break;
        case "thread/list":
          this.reply(socket, message.id, {
            data: this.threads.map((thread) => this.threadSummary(thread)),
            nextCursor: null,
            backwardsCursor: null,
          });
          break;
        case "project/list":
          this.reply(socket, message.id, { data: this.projects, nextCursor: null });
          break;
        case "project/create": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const project: FakeCodexProject = {
            id: `e2e-project-${this.projects.length + 1}`,
            name: String(params.name ?? "Created project"),
            roots: Array.isArray(params.roots) ? (params.roots as Array<{ path: string }>) : [],
            metadata: (params.metadata ?? {}) as Record<string, string>,
            position: this.projects.length,
            createdAt: 1,
            updatedAt: 1,
            recencyAt: null,
          };
          this.projects.push(project);
          this.reply(socket, message.id, { project });
          break;
        }
        case "project/update": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const project = this.projects.find((entry) => entry.id === params.projectId);
          if (!project) {
            this.reply(socket, message.id, { error: "Project not found" });
            break;
          }
          if (typeof params.name === "string") project.name = params.name;
          if (Array.isArray(params.roots)) project.roots = params.roots as Array<{ path: string }>;
          if (params.metadata && typeof params.metadata === "object") {
            project.metadata = params.metadata as Record<string, string>;
          }
          this.reply(socket, message.id, { project });
          break;
        }
        case "project/move": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const projectId = String(params.projectId ?? "");
          const beforeProjectId =
            typeof params.beforeProjectId === "string" ? params.beforeProjectId : null;
          const currentIndex = this.projects.findIndex((entry) => entry.id === projectId);
          if (currentIndex >= 0) {
            const [project] = this.projects.splice(currentIndex, 1);
            const beforeIndex = beforeProjectId
              ? this.projects.findIndex((entry) => entry.id === beforeProjectId)
              : this.projects.length;
            this.projects.splice(beforeIndex < 0 ? this.projects.length : beforeIndex, 0, project);
            this.projects.forEach((entry, position) => (entry.position = position));
          }
          this.reply(socket, message.id, {});
          break;
        }
        case "project/delete": {
          const projectId = String(
            (message.params as Record<string, unknown> | undefined)?.projectId ?? "",
          );
          const index = this.projects.findIndex((entry) => entry.id === projectId);
          if (index >= 0) this.projects.splice(index, 1);
          this.reply(socket, message.id, {});
          break;
        }
        case "thread/start": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const thread: FakeCodexThread = {
            id: `e2e-thread-${this.threads.length + 1}`,
            preview: "Created thread",
            cwd: String(params.cwd ?? "/tmp/pesk-e2e-workspace"),
            projectId: typeof params.projectId === "string" ? params.projectId : null,
          };
          this.threads.push(thread);
          this.reply(socket, message.id, {
            thread: this.threadSummary(thread),
            model: "fixture-model",
            modelProvider: "fixture-provider",
            serviceTier: null,
            cwd: thread.cwd,
            instructionSources: [],
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: null,
          });
          break;
        }
        case "thread/name/set": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const thread = this.threads.find((entry) => entry.id === params.threadId);
          if (!thread || typeof params.name !== "string") {
            this.reply(socket, message.id, { error: "Thread not found" });
            break;
          }
          thread.name = params.name;
          this.reply(socket, message.id, {});
          this.notify(socket, "thread/name/updated", {
            threadId: thread.id,
            threadName: thread.name,
          });
          break;
        }
        case "thread/archive":
        case "thread/delete": {
          const threadId = this.threadId(message);
          if (threadId) {
            const index = this.threads.findIndex((thread) => thread.id === threadId);
            if (index >= 0) this.threads.splice(index, 1);
            this.reply(socket, message.id, {});
            this.notify(
              socket,
              method === "thread/archive" ? "thread/archived" : "thread/deleted",
              {
                threadId,
              },
            );
          } else {
            this.reply(socket, message.id, {});
          }
          break;
        }
        case "thread/resume":
        case "thread/read": {
          const threadId = this.threadId(message);
          const thread =
            this.threads.find((candidate) => candidate.id === threadId) ?? this.threads[0];
          this.reply(socket, message.id, {
            thread: this.threadSummary(thread),
            model: "fixture-model",
            modelProvider: "fixture-provider",
            serviceTier: null,
            cwd: thread.cwd,
            instructionSources: [],
            approvalPolicy: "never",
            approvalsReviewer: null,
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: null,
            turnsBackwardsCursor: null,
            itemsBackwardsCursor: null,
          });
          break;
        }
        case "thread/turns/list":
          this.reply(socket, message.id, {
            data: this.threads.find((thread) => thread.id === this.threadId(message))?.turns ?? [],
            nextCursor: null,
          });
          break;
        case "thread/queue/add": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const threadId = String(params.threadId ?? this.threads[0]?.id ?? "e2e-thread-1");
          const input = Array.isArray(params.input) ? params.input : [];
          const text = input
            .filter((entry): entry is Record<string, unknown> => typeof entry === "object")
            .map((entry) => String(entry.text ?? ""))
            .join("");
          const clientUserMessageId = String(params.clientUserMessageId ?? "");
          const queuedSubmission = {
            id: `e2e-queued-${this.nextQueuedSubmissionId++}`,
            text,
            clientUserMessageId,
          };
          const queued = this.queuedPrompts.get(threadId) ?? [];
          queued.push(queuedSubmission);
          this.queuedPrompts.set(threadId, queued);
          this.prompts.push(text);
          this.reply(socket, message.id, {
            queuedSubmission: {
              id: queuedSubmission.id,
              input,
              clientUserMessageId,
            },
          });
          if (!this.longRunningTurns.has(threadId)) {
            const next = queued.shift();
            if (queued.length) this.queuedPrompts.set(threadId, queued);
            else this.queuedPrompts.delete(threadId);
            this.pendingPrompts.set(threadId, next?.text ?? text);
            setTimeout(() => this.emitTurn(socket, threadId), this.turnDelayMs);
          }
          break;
        }
        case "thread/queue/delete": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const threadId = String(params.threadId ?? this.threads[0]?.id ?? "e2e-thread-1");
          const id = String(params.queuedSubmissionId ?? "");
          const queued = this.queuedPrompts.get(threadId) ?? [];
          const remaining = queued.filter((submission) => submission.id !== id);
          const deleted = remaining.length !== queued.length;
          if (remaining.length) this.queuedPrompts.set(threadId, remaining);
          else this.queuedPrompts.delete(threadId);
          this.reply(socket, message.id, { deleted });
          break;
        }
        case "thread/queue/list": {
          const threadId = this.threadId(message) ?? "e2e-thread-1";
          const queued = this.queuedPrompts.get(threadId) ?? [];
          this.reply(socket, message.id, {
            data: queued.map((submission) => ({
              id: submission.id,
              input: [{ type: "text", text: submission.text, text_elements: [] }],
              clientUserMessageId: submission.clientUserMessageId,
            })),
            nextCursor: null,
          });
          break;
        }
        case "turn/start": {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const threadId = String(params.threadId ?? this.threads[0]?.id ?? "e2e-thread-1");
          const input = Array.isArray(params.input) ? params.input : [];
          const prompt = input
            .filter((entry): entry is Record<string, unknown> => typeof entry === "object")
            .map((entry) => String(entry.text ?? ""))
            .join("");
          this.prompts.push(prompt);
          this.pendingPrompts.set(threadId, prompt);
          this.reply(socket, message.id, { turn: this.turn("e2e-turn-1", "inProgress") });
          setTimeout(() => this.emitTurn(socket, threadId), this.turnDelayMs);
          break;
        }
        case "turn/interrupt": {
          const threadId = this.threadId(message) ?? this.threads[0]?.id ?? "e2e-thread-1";
          const queued = this.queuedPrompts.get(threadId) ?? [];
          const next = queued.shift();
          if (queued.length) this.queuedPrompts.set(threadId, queued);
          else this.queuedPrompts.delete(threadId);
          this.longRunningTurns.delete(threadId);
          this.reply(socket, message.id, {});
          this.notify(socket, "turn/completed", {
            threadId,
            turn: this.turn("e2e-turn-1", "interrupted"),
          });
          if (next) {
            this.pendingPrompts.set(threadId, next.text);
            setTimeout(() => this.emitTurn(socket, threadId), this.turnDelayMs);
          }
          break;
        }
        case "turn/steer":
          this.reply(socket, message.id, {});
          break;
        default:
          this.reply(socket, message.id, {});
          break;
      }
    }
  }

  private reply(socket: WebSocket, id: number, result: unknown): void {
    socket.send(`${JSON.stringify({ id, result })}\n`);
  }

  private threadId(message: Record<string, unknown>): string | undefined {
    const params = message.params;
    return params && typeof params === "object"
      ? String((params as Record<string, unknown>).threadId ?? "")
      : undefined;
  }

  private threadSummary(thread: FakeCodexThread): Record<string, unknown> {
    return {
      id: thread.id,
      sessionId: `${thread.id}-session`,
      forkedFromId: null,
      parentThreadId: null,
      preview: thread.preview,
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: thread.projectId,
      historyMode: "paginated",
      modelProvider: "fixture-provider",
      model: "fixture-model",
      reasoningEffort: null,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: thread.status ?? { type: "idle" },
      path: null,
      cwd: thread.cwd,
      cliVersion: "fixture",
      originator: null,
      source: "appServer",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: thread.name ?? thread.preview,
      turns: [],
    };
  }

  private turn(
    id: string,
    status: "inProgress" | "completed" | "interrupted",
  ): Record<string, unknown> {
    return {
      id,
      items: [],
      itemsView: "full",
      status,
      error: null,
      startedAt: 1,
      completedAt: status === "completed" ? 2 : null,
      durationMs: status === "completed" ? 1 : null,
    };
  }

  private emitTurn(socket: WebSocket, threadId: string): void {
    const turnId = "e2e-turn-1";
    const itemId = "e2e-agent-message-1";
    const item = this.approvalEnabled
      ? {
          type: "commandExecution",
          id: itemId,
          command: "echo approval-required",
          status: "inProgress",
        }
      : this.remoteTerminalEnabled
        ? {
            type: "dynamicToolCall",
            id: itemId,
            namespace: "remote_terminal",
            tool: "sessions",
            arguments: {},
            status: "inProgress",
            contentItems: null,
            success: null,
            durationMs: null,
          }
        : this.fileChangeEnabled
          ? {
              type: "fileChange",
              id: itemId,
              status: "completed",
              changes: this.fileChanges,
            }
          : {
              type: "agentMessage",
              id: itemId,
              text: "Hello from fake Codex app-server.",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            };
    this.notify(socket, "turn/started", { threadId, turn: this.turn(turnId, "inProgress") });
    this.notify(socket, "item/started", { threadId, turnId, item, startedAtMs: 1 });
    if (this.approvalEnabled) {
      this.approvalSocket = socket;
      this.approvalThreadId = threadId;
      this.notify(
        socket,
        "item/commandExecution/requestApproval",
        {
          threadId,
          turnId,
          itemId,
          approvalId: null,
          kind: "command",
          environmentId: null,
          command: "echo approval-required",
          cwd: "/tmp/pesk-e2e-workspace",
          reason: "E2E approval request",
          startedAtMs: 1,
        },
        101,
      );
      if (this.expectedApprovalResponses > 1) {
        this.notify(
          socket,
          "item/commandExecution/requestApproval",
          {
            threadId,
            turnId,
            itemId: `${itemId}-second`,
            approvalId: null,
            kind: "command",
            environmentId: null,
            command: "echo second-approval-required",
            cwd: "/tmp/pesk-e2e-workspace",
            reason: "E2E second approval request",
            startedAtMs: 1,
          },
          102,
        );
      }
      return;
    }
    if (this.userInputEnabled) {
      this.approvalSocket = socket;
      this.approvalThreadId = threadId;
      this.notify(
        socket,
        "item/tool/requestUserInput",
        {
          threadId,
          turnId,
          itemId,
          questions: [
            {
              id: "choice",
              header: "Environment",
              question: "Which environment?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Test", description: "Use the test environment" }],
            },
          ],
          isBlocking: true,
        },
        202,
      );
      return;
    }
    if (this.remoteTerminalEnabled) {
      this.approvalSocket = socket;
      this.approvalThreadId = threadId;
      this.notify(
        socket,
        "item/tool/call",
        {
          threadId,
          turnId,
          callId: "rterm-sessions-1",
          namespace: "remote_terminal",
          tool: "sessions",
          arguments: {},
        },
        303,
      );
      return;
    }
    if (this.fileChangeEnabled) {
      this.notify(socket, "item/completed", { threadId, turnId, item, completedAtMs: 2 });
      this.notify(socket, "turn/completed", { threadId, turn: this.turn(turnId, "completed") });
      const prompt = this.pendingPrompts.get(threadId);
      const thread = this.threads.find((candidate) => candidate.id === threadId);
      if (thread && prompt) {
        thread.turns ??= [];
        thread.turns.push({
          id: turnId,
          startedAt: 1,
          status: "completed",
          items: [
            {
              id: `${turnId}-user`,
              type: "userMessage",
              content: [{ type: "text", text: prompt }],
            },
            { ...item },
          ],
        });
        this.pendingPrompts.delete(threadId);
      }
      return;
    }
    if (this.longRunning) {
      this.longRunningTurns.set(threadId, socket);
      return;
    }
    this.emitTurnCompletion(socket, threadId);
  }

  private emitTurnCompletion(socket: WebSocket, threadId: string): void {
    const turnId = "e2e-turn-1";
    const itemId = "e2e-agent-message-1";
    const response = this.threadResponses.get(threadId) ?? "Hello from fake Codex app-server.";
    const split = Math.max(1, Math.floor(response.length / 2));
    const deltas = this.threadResponses.has(threadId)
      ? [response.slice(0, split), response.slice(split)]
      : ["Hello from fake ", "Codex app-server."];
    const item = {
      type: "agentMessage",
      id: itemId,
      text: response,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    this.notify(socket, "item/agentMessage/delta", {
      threadId,
      turnId,
      itemId,
      delta: deltas[0],
    });
    const finish = (): void => {
      this.notify(socket, "item/agentMessage/delta", {
        threadId,
        turnId,
        itemId,
        delta: deltas[1],
      });
      this.notify(socket, "item/completed", { threadId, turnId, item, completedAtMs: 2 });
      this.notify(socket, "turn/completed", { threadId, turn: this.turn(turnId, "completed") });
      const prompt = this.pendingPrompts.get(threadId);
      const thread = this.threads.find((candidate) => candidate.id === threadId);
      if (thread && prompt) {
        thread.turns ??= [];
        thread.turns.push({
          id: turnId,
          startedAt: 1,
          status: "completed",
          items: [
            {
              id: `${turnId}-user`,
              type: "userMessage",
              content: [{ type: "text", text: prompt }],
            },
            { ...item },
          ],
        });
        this.pendingPrompts.delete(threadId);
      }
      const queued = this.queuedPrompts.get(threadId) ?? [];
      const next = queued.shift();
      if (next) {
        if (queued.length) this.queuedPrompts.set(threadId, queued);
        else this.queuedPrompts.delete(threadId);
        this.pendingPrompts.set(threadId, next.text);
        setTimeout(() => this.emitTurn(socket, threadId), this.turnDelayMs);
      }
    };
    if (this.streamingDelayMs > 0) setTimeout(finish, this.streamingDelayMs);
    else finish();
  }

  private notifyRemoteExecute(socket: WebSocket): void {
    this.notify(
      socket,
      "item/tool/call",
      {
        threadId: this.approvalThreadId,
        turnId: "e2e-turn-1",
        callId: "rterm-execute-1",
        namespace: "remote_terminal",
        tool: "execute",
        arguments: { command: "echo from codex", reason: "E2E remote terminal command" },
      },
      304,
    );
  }

  private notify(socket: WebSocket, method: string, params: unknown, id?: number): void {
    this.serverMethods.push(method);
    if (method === "item/agentMessage/delta") {
      const delta = (params as { delta?: unknown }).delta;
      if (typeof delta === "string") this.streamDeltas.push(delta);
    }
    if (method === "turn/started" || method === "turn/completed") this.turnEvents.push(method);
    socket.send(`${JSON.stringify({ ...(id === undefined ? {} : { id }), method, params })}\n`);
  }
}
