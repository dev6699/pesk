import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export class FakeRtermServer {
  readonly server: Server;
  readonly webSockets = new Set<WebSocket>();
  port = 0;
  httpRequests: string[] = [];
  readonly commands: string[] = [];
  readonly socketMessages: string[] = [];

  private readonly socketServer = new WebSocketServer({ noServer: true });

  constructor() {
    this.server = createServer((request, response) => {
      this.httpRequests.push(request.url ?? "/");
      if (request.url?.startsWith("/provider/ssh")) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          "<!doctype html><html><body><main id='fake-rterm'>Fake rterm</main><pre id='fake-rterm-output'></pre>" +
            "<script src='/provider/ssh/client.js'></script>" +
            "<script>" +
            "const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';" +
            "let socket; const connect = () => { socket = new WebSocket(protocol + '//' + location.host + location.pathname + location.search);" +
            "socket.addEventListener('open', () => document.body.dataset.websocket = 'connected');" +
            "socket.addEventListener('message', event => { const append = value => document.getElementById('fake-rterm-output').textContent += value; if (typeof event.data === 'string') append(event.data); else event.data.text().then(append); });" +
            "socket.addEventListener('close', () => { document.body.dataset.websocket = 'disconnected'; setTimeout(connect, 25); }); }; connect();" +
            "window.fakeRtermSend = value => socket?.send(value);" +
            "window.addEventListener('message', event => {" +
            " if (event.data?.source !== 'pesk') return;" +
            " if (event.data.type === 'sessions-request') { document.body.dataset.sessionsRequested = 'true'; event.source.postMessage({source:'rterm',type:'sessions-response',requestId:event.data.requestId,bridgeToken:event.data.bridgeToken,ok:true,connected:true,result:[{sessionId:'session-1',provider:'fake',target:'e2e-host',user:'e2e',token:'e2e-token'}]}, '*'); }" +
            "});" +
            "</script></body></html>",
        );
        return;
      }
      if (request.url?.startsWith("/provider/ssh/client.js")) {
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end("window.fakeRtermClientLoaded = true;");
        return;
      }
      if (request.url?.startsWith("/api/sessions/session-1/execute")) {
        if (request.headers.authorization !== "Bearer e2e-token") {
          response.writeHead(401).end("unauthorized");
          return;
        }
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          const command = (JSON.parse(body) as { command?: unknown }).command;
          if (typeof command === "string") this.commands.push(command);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ output: "fake command output\n", exitCode: 0 }));
        });
        return;
      }
      response.writeHead(404).end();
    });
    this.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/provider/ssh")) {
        socket.destroy();
        return;
      }
      this.socketServer.handleUpgrade(request, socket, head, (client) => {
        this.webSockets.add(client);
        this.socketServer.emit("connection", client);
      });
    });
    this.socketServer.on("connection", (socket: WebSocket) => {
      socket.on("close", () => this.webSockets.delete(socket));
      socket.on("message", (message) => {
        this.socketMessages.push(String(message));
        socket.send(message);
      });
    });
  }

  async ready(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return "http://127.0.0.1:" + this.port + "/provider/ssh";
  }

  async close(): Promise<void> {
    for (const socket of this.webSockets) socket.terminate();
    this.socketServer.close();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
