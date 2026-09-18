import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { RendererState } from "../../src/app/renderer-state";

const rendererRoot = path.resolve(process.env.PESK_BUILD_DIR || "build", "renderer");

export function fixtureState(messageText = ""): RendererState {
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
        selectedId: "thread-1",
        items: [{ id: "thread-1", preview: messageText || "Test session" }],
        activities: [],
        backgroundWork: { completed: 0, total: 0 },
        current: {
          readOnly: false,
          history: { loading: false, hasOlder: false },
          thread: {
            status: "idle",
            connected: true,
            collaborationMode: "default",
            queuedSubmissions: [],
            messages: messageText
              ? [
                  { role: "user", text: "hello" },
                  { role: "assistant", text: messageText },
                ]
              : [],
          },
        },
      },
      projects: { items: [] },
    },
    assets: { codexStatusSoundUrl: "", themeName: "amber" },
    features: { remoteTerminal: { enabled: false } },
  };
}

export class WebChatFixture {
  readonly server: Server;
  readonly sockets = new Set<WebSocket>();
  private readonly webSockets: WebSocketServer;
  private currentState = fixtureState();
  private port = 0;

  constructor() {
    this.server = createServer((request, response) => {
      const requested = new URL(request.url ?? "/", "http://localhost").pathname;
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
    for (const socket of this.sockets) socket.close();
    this.webSockets.close();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private handle(socket: WebSocket, message: Record<string, unknown>): void {
    if (message.type === "authenticate") {
      socket.send(JSON.stringify({ type: "state", state: this.currentState }));
      return;
    }
    if (message.type === "submitPrompt") {
      this.currentState = fixtureState("Hello from the deterministic Codex fixture.");
      socket.send(
        JSON.stringify({
          type: "commandResult",
          requestId: message.requestId,
          ok: true,
          state: this.currentState,
        }),
      );
      socket.send(
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
    }
  }
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
