import { createReadStream, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export interface ChatWebServerOptions {
  enabled: boolean;
  port: number;
  token?: string;
  rendererDirectory: string;
  tokenPath: string;
  getState: () => unknown;
  handleCommand: (command: unknown, reply: (message: unknown) => void) => void;
  debug: (...values: unknown[]) => void;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Serves the chat renderer to LAN browsers and bridges commands to Codex. */
export class ChatWebServer {
  private readonly clients = new Set<WebSocket>();
  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private token = "";
  private started = false;

  constructor(private readonly options: ChatWebServerOptions) {
    this.server = createServer((request, response) =>
      this.handleHttpRequest(request, response),
    );
    this.sockets = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/web-socket") {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (client) =>
        this.sockets.emit(
          "connection",
          client,
          request,
          requestUrl.searchParams.get("token"),
        ),
      );
    });
    this.sockets.on(
      "connection",
      (client: WebSocket, _request: IncomingMessage, token?: unknown) =>
        this.handleConnection(
          client,
          typeof token === "string" ? token : undefined,
        ),
    );
  }

  start(): void {
    if (!this.options.enabled) return;
    this.token =
      this.options.token?.trim() || loadOrCreateToken(this.options.tokenPath);
    this.started = true;
    this.server.listen(this.options.port, "0.0.0.0", () => {
      this.options.debug("web chat", {
        urls: accessUrls(this.options.port, this.token),
      });
    });
    this.server.on("error", (error) =>
      this.options.debug("web chat error", error),
    );
  }

  broadcast(state = this.options.getState()): void {
    if (!this.options.enabled) return;
    const message = JSON.stringify({ type: "state", state });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  stop(): void {
    if (!this.started) return;
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.sockets.close();
    this.server.close();
    this.started = false;
  }

  getAccessInfo(): { urls: string[]; token: string } | undefined {
    if (!this.options.enabled) return undefined;
    if (!this.token)
      this.token =
        this.options.token?.trim() || loadOrCreateToken(this.options.tokenPath);
    return {
      urls: accessUrls(this.options.port, this.token),
      token: this.token,
    };
  }

  private handleConnection(client: WebSocket, handshakeToken?: string): void {
    let authenticated = handshakeToken === this.token;
    if (authenticated) this.addAuthenticatedClient(client);

    const authenticate = (message: Record<string, unknown>): boolean => {
      if (message.type !== "authenticate" || message.token !== this.token) {
        client.close(1008, "Authentication required");
        return false;
      }
      authenticated = true;
      this.addAuthenticatedClient(client);
      return true;
    };

    client.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        client.close(1007, "Invalid JSON");
        return;
      }
      if (!message || typeof message !== "object") return;
      if (!authenticated) {
        authenticate(message as Record<string, unknown>);
        return;
      }
      this.options.handleCommand(message, (reply) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(reply));
        }
      });
    });
    client.on("close", () => this.clients.delete(client));
  }

  private addAuthenticatedClient(client: WebSocket): void {
    if (this.clients.has(client)) return;
    this.clients.add(client);
    client.send(
      JSON.stringify({ type: "state", state: this.options.getState() }),
    );
  }

  private handleHttpRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    const requested = request.url?.split("?")[0] ?? "/";
    const relative = requested === "/" ? "web-chat.html" : requested.slice(1);
    if (!relative || relative.includes("..") || path.isAbsolute(relative)) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(this.options.rendererDirectory, relative);
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(response);
  }
}

function loadOrCreateToken(file: string): string {
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    // Generate the first token below.
  }
  const token = randomBytes(24).toString("base64url");
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function lanUrls(port: number): string[] {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}/`);
  return addresses.length ? addresses : [`http://127.0.0.1:${port}/`];
}

function accessUrls(port: number, token: string): string[] {
  const query = `?token=${encodeURIComponent(token)}`;
  return lanUrls(port).map((url) => `${url}${query}`);
}
