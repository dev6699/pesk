import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { RendererState } from "../src/app/renderer-state";

const rendererRoot = path.resolve(process.env.PESK_BUILD_DIR || "build", "renderer");

export interface FixtureStateOptions {
  threadItems?: Array<{ id: string; name?: string | null; preview?: string }>;
  projects?: RendererState["codex"]["projects"]["items"];
  messages?: RendererState["codex"]["threads"]["current"]["thread"]["messages"];
  modelPicker?: NonNullable<RendererState["codex"]["modelPicker"]>;
  status?: "idle" | "working" | "waiting";
  remoteTerminal?: boolean;
  interrupted?: boolean;
  pendingApproval?: NonNullable<
    RendererState["codex"]["threads"]["current"]["thread"]["pendingApproval"]
  >;
  pendingUserInput?: NonNullable<
    RendererState["codex"]["threads"]["current"]["thread"]["pendingUserInput"]
  >;
}

export interface FixtureBehaviorOptions {
  rejectAuthentication?: boolean;
  rejectPairing?: boolean;
}

export function fixtureState(messageText = "", options: FixtureStateOptions = {}): RendererState {
  const threadItems = options.threadItems ?? [
    { id: "thread-1", preview: messageText || "Test session" },
  ];
  const selectedId = threadItems[0]?.id ?? "thread-1";
  return {
    settings: {
      animation: "idle",
      animationMode: "selected",
      scale: 1,
      paused: false,
      locked: false,
      visible: true,
      codexStatusSound: true,
    },
    codex: {
      connection: { status: "ready" },
      account: {},
      threads: {
        selectedId,
        items: threadItems,
        activities: [],
        backgroundWork: { completed: 0, total: 0 },
        current: {
          readOnly: false,
          history: { loading: false, hasOlder: false },
          thread: {
            status: options.status ?? "idle",
            connected: true,
            interrupted: options.interrupted,
            collaborationMode: "default",
            pendingApproval: options.pendingApproval,
            pendingUserInput: options.pendingUserInput,
            queuedSubmissions: [],
            messages:
              options.messages ??
              (messageText
                ? [
                    { role: "user", text: "hello" },
                    { role: "assistant", text: messageText },
                  ]
                : []),
          },
        },
      },
      projects: { items: options.projects ?? [] },
      modelPicker: options.modelPicker,
    },
    assets: { codexStatusSoundUrl: "", themeName: "amber" },
    features: { remoteTerminal: { enabled: options.remoteTerminal ?? false } },
  };
}

export class WebChatFixture {
  readonly server: Server;
  readonly sockets = new Set<WebSocket>();
  private readonly webSockets: WebSocketServer;
  private currentState = fixtureState();
  private port = 0;
  lastPermission: { requestId: string | number; optionId: string } | undefined;
  lastUserInput: { requestId: string | number; answers: Record<string, string[]> } | undefined;
  lastCommand: string | undefined;
  selectedThread: string | undefined;
  lastPrompt: string | undefined;
  lastSteer: string | undefined;
  lastImages: Array<{ url: string; name: string }> | undefined;
  lastModel: { model: string; effort: string } | undefined;
  lastPlanImplementation: { planText: string; clearContext: boolean } | undefined;

  constructor(
    initialState = fixtureState(),
    private readonly behavior: FixtureBehaviorOptions = {},
    private readonly fuzzyFiles: FuzzyFileSearchResult[] = [],
  ) {
    this.currentState = initialState;
    this.server = createServer(async (request, response) => {
      const requested = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && requested === "/pair/exchange") {
        await readRequest(request);
        if (this.behavior.rejectPairing) {
          response.writeHead(400).end(JSON.stringify({ error: "Pairing code expired" }));
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({ credential: "fixture-credential", deviceId: "fixture-device" }),
        );
        return;
      }
      const relative = requested === "/" ? "web-chat.html" : requested.slice(1);
      const filePath = path.resolve(rendererRoot, relative);
      if (!filePath.startsWith(`${rendererRoot}${path.sep}`) || !existsSync(filePath)) {
        response.writeHead(404).end();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(filePath));
      createReadStream(filePath).pipe(response);
    });
    this.webSockets = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/web-socket") {
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (client) => {
        this.webSockets.emit("connection", client);
      });
    });
    this.webSockets.on("connection", (socket: WebSocket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", (raw) =>
        this.handle(socket, JSON.parse(String(raw)) as Record<string, unknown>),
      );
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}/web-chat.html`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    for (const socket of this.webSockets.clients) socket.terminate();
    await new Promise<void>((resolve) => {
      this.webSockets.close(() => resolve());
    });
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private handle(socket: WebSocket, message: Record<string, unknown>): void {
    if (message.type === "authenticate") {
      if (this.behavior.rejectAuthentication) {
        socket.close(1008, "Unauthorized");
        return;
      }
      socket.send(JSON.stringify({ type: "state", state: this.currentState }));
      return;
    }
    if (message.type === "fuzzyFileSearch") {
      socket.send(
        JSON.stringify({
          type: "fuzzyFileSearchResult",
          requestId: message.requestId,
          files: this.fuzzyFiles,
        }),
      );
      return;
    }
    if (message.type === "selectModel" || message.type === "cancelModel") {
      this.lastCommand = String(message.type);
      if (message.type === "selectModel") {
        this.lastModel = { model: String(message.model), effort: String(message.effort ?? "") };
      }
      const nextState = structuredClone(this.currentState);
      if (message.type === "selectModel" && nextState.codex.modelPicker?.stage === "model") {
        const selected = nextState.codex.modelPicker.models.find(
          (model) => model.model === message.model,
        );
        nextState.codex.modelPicker = selected
          ? { stage: "effort", selectedModel: selected, models: nextState.codex.modelPicker.models }
          : undefined;
      } else {
        nextState.codex.modelPicker = undefined;
      }
      this.currentState = nextState;
      socket.send(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: nextState,
        }),
      );
      socket.send(JSON.stringify({ type: "state", state: nextState }));
      return;
    }
    if (message.type === "implementPlan") {
      this.lastCommand = "implementPlan";
      this.lastPlanImplementation = {
        planText: String(message.planText ?? ""),
        clearContext: message.clearContext === true,
      };
      socket.send(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: this.currentState,
        }),
      );
      return;
    }
    if (
      message.type === "listProjects" ||
      message.type === "readProject" ||
      message.type === "createProject" ||
      message.type === "updateProject" ||
      message.type === "moveProject" ||
      message.type === "deleteProject"
    ) {
      this.lastCommand = String(message.type);
      const nextState = structuredClone(this.currentState);
      const projects = nextState.codex.projects.items;
      if (message.type === "createProject") {
        projects.push({
          id: `project-${projects.length + 1}`,
          name: String(message.name ?? "New project"),
          roots: [{ path: String(message.root ?? "") }],
          metadata: {},
          position: projects.length,
          createdAt: 1,
          updatedAt: 1,
          recencyAt: null,
        });
      } else if (message.type === "updateProject") {
        const project = projects.find((entry) => entry.id === String(message.projectId));
        const changes = (message.changes ?? {}) as {
          name?: string;
          roots?: string[];
          metadata?: Record<string, string>;
        };
        if (project) {
          if (typeof changes.name === "string") project.name = changes.name;
          if (Array.isArray(changes.roots)) project.roots = changes.roots.map((path) => ({ path }));
          if (changes.metadata) project.metadata = { ...project.metadata, ...changes.metadata };
        }
      } else if (message.type === "moveProject") {
        const index = projects.findIndex((entry) => entry.id === String(message.projectId));
        const beforeIndex =
          message.beforeProjectId === null
            ? projects.length
            : projects.findIndex((entry) => entry.id === String(message.beforeProjectId));
        if (index >= 0 && beforeIndex >= 0) {
          const [project] = projects.splice(index, 1);
          projects.splice(Math.min(beforeIndex, projects.length), 0, project);
          projects.forEach((entry, position) => (entry.position = position));
        }
      } else if (message.type === "deleteProject") {
        nextState.codex.projects.items = projects.filter(
          (entry) => entry.id !== String(message.projectId),
        );
      }
      this.currentState = nextState;
      this.replyCommand(socket, message, nextState);
      return;
    }
    if (message.type === "selectThread") {
      this.lastCommand = "selectThread";
      this.selectedThread = String(message.threadId);
      this.currentState = {
        ...this.currentState,
        codex: {
          ...this.currentState.codex,
          threads: { ...this.currentState.codex.threads, selectedId: this.selectedThread },
        },
      };
      socket.send(JSON.stringify({ type: "state", state: this.currentState }));
      return;
    }
    if (message.type === "startProjectThread") {
      this.lastCommand = "startProjectThread";
      const nextState = structuredClone(this.currentState);
      const projectId = String(message.projectId ?? "");
      const cwd = String(message.cwd ?? "");
      const threadId = `thread-project-${nextState.codex.threads.items.length + 1}`;
      nextState.codex.threads.items.unshift({
        id: threadId,
        preview: "New project thread",
        projectId,
      });
      nextState.codex.threads.selectedId = threadId;
      nextState.codex.threads.current.thread = {
        ...nextState.codex.threads.current.thread,
        projectId,
        workingDirectory: cwd,
        messages: [],
      };
      this.currentState = nextState;
      this.selectedThread = threadId;
      this.replyCommand(socket, message, nextState);
      socket.send(JSON.stringify({ type: "state", state: nextState }));
      return;
    }
    if (message.type === "renameThread") {
      this.lastCommand = "renameThread";
      const nextState = structuredClone(this.currentState);
      const thread = nextState.codex.threads.items.find(
        (entry) => entry.id === nextState.codex.threads.selectedId,
      );
      if (thread && typeof message.name === "string") thread.name = message.name;
      this.currentState = nextState;
      this.replyCommand(socket, message, nextState, Boolean(thread));
      socket.send(JSON.stringify({ type: "state", state: nextState }));
      return;
    }
    if (message.type === "submitPrompt") {
      this.lastCommand = "submitPrompt";
      this.lastPrompt = String(message.prompt ?? "");
      this.lastImages = Array.isArray(message.images)
        ? (message.images as Array<{ url: string; name: string }>)
        : undefined;
      this.currentState = fixtureState("Hello from the deterministic Codex fixture.");
      this.broadcast(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: this.currentState,
        }),
      );
      this.broadcast(
        JSON.stringify({
          type: "codexStreamDelta",
          delta: {
            threadId: "thread-1",
            itemId: "assistant-1",
            kind: "assistant",
            delta: "Hello from the deterministic Codex fixture.",
            completed: true,
          },
        }),
      );
      this.broadcast(JSON.stringify({ type: "state", state: this.currentState }));
      return;
    }
    if (message.type === "steerTurn") {
      this.lastCommand = "steerTurn";
      this.lastSteer = String(message.prompt ?? "");
      socket.send(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: this.currentState,
        }),
      );
      return;
    }
    if (message.type === "interruptTurn") {
      this.lastCommand = "interruptTurn";
      this.currentState = {
        ...this.currentState,
        codex: {
          ...this.currentState.codex,
          threads: {
            ...this.currentState.codex.threads,
            current: {
              ...this.currentState.codex.threads.current,
              thread: {
                ...this.currentState.codex.threads.current.thread,
                status: "idle",
                interrupted: true,
              },
            },
          },
        },
      };
      socket.send(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: this.currentState,
        }),
      );
      socket.send(JSON.stringify({ type: "state", state: this.currentState }));
      return;
    }
    if (message.type === "getRterm") {
      socket.send(
        JSON.stringify({
          type: "rterm",
          requestId: message.requestId,
          snapshot: {
            enabled: true,
            state: "connected",
            output: "fixture terminal",
            hostLabel: "fixture-host",
            authFailed: false,
          },
        }),
      );
      return;
    }
    if (message.type === "getRtermEmbedUrl") {
      socket.send(
        JSON.stringify({
          type: "rtermEmbedUrl",
          requestId: message.requestId,
          url: "/rterm-proxy/embed",
        }),
      );
      return;
    }
    if (message.type === "respondPermission") {
      this.lastPermission = {
        requestId: message.requestId as string | number,
        optionId: String(message.optionId),
      };
      return;
    }
    if (message.type === "respondUserInput") {
      this.lastUserInput = {
        requestId: message.requestId as string | number,
        answers: message.answers as Record<string, string[]>,
      };
    }
  }

  private broadcast(message: string): void {
    for (const client of this.sockets) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }

  private replyCommand(
    socket: WebSocket,
    message: Record<string, unknown>,
    state: RendererState,
    ok = true,
  ): void {
    socket.send(JSON.stringify({ type: "commandResult", requestId: message.requestId, ok, state }));
  }
}

function readRequest(request: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    request.on("data", () => undefined);
    request.on("end", resolve);
    request.on("error", reject);
  });
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return `application/octet-stream;${statSync(filePath).size}`;
  }
}
