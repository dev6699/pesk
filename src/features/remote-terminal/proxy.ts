import { randomBytes } from "node:crypto";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

export interface RtermProxyOptions {
  url: string;
  getEmbedUrl: () => Promise<string>;
  isDeviceAuthorized: (deviceId: string) => boolean;
  secure: boolean;
  pathPrefix?: string;
}

interface Capability {
  deviceId: string;
  expiresAt: number;
}

/** Adapts the fixed rterm target to authenticated browser embeds. */
export class RtermProxy {
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<WebSocket>();
  private readonly upstreamSockets = new Set<WebSocket>();
  private readonly capabilities = new Map<string, Capability>();

  constructor(private readonly options: RtermProxyOptions) {}

  get pathPrefix(): string {
    return this.options.pathPrefix ?? "/rterm-proxy/";
  }

  /** Creates a short-lived, device-scoped URL for a browser rterm embed. */
  async getEmbedUrl(deviceId: string): Promise<string> {
    const directUrl = await this.options.getEmbedUrl();
    if (!directUrl) return "";
    try {
      const token = randomBytes(32).toString("base64url");
      this.capabilities.set(token, { deviceId, expiresAt: Date.now() + 10 * 60_000 });
      const parsed = new URL(directUrl);
      parsed.searchParams.set("proxyToken", token);
      parsed.pathname = `${this.pathPrefix.slice(0, -1)}${parsed.pathname}`;
      parsed.protocol = this.options.secure ? "https:" : "http:";
      parsed.host = "";
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return "";
    }
  }

  /** Authenticates and forwards an HTTP request to the fixed rterm target. */
  handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const capability = this.validCapability(request, requestUrl);
    if (!capability) {
      response.writeHead(401).end("Authentication required");
      return;
    }
    const upstream = this.upstreamUrl(requestUrl);
    if (!upstream) {
      response.writeHead(502).end("rterm is not configured");
      return;
    }
    const headers = { ...request.headers, host: upstream.host };
    delete headers.authorization;
    delete headers["accept-encoding"];
    const upstreamCookie = removeCookie(headers.cookie, "pesk-rterm-proxy");
    if (upstreamCookie) headers.cookie = upstreamCookie;
    else delete headers.cookie;
    const requester = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamRequest = requester(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path: `${upstream.pathname}${upstream.search}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        if (requestUrl.searchParams.has("proxyToken")) {
          responseHeaders["set-cookie"] = [
            `pesk-rterm-proxy=${encodeURIComponent(capability.token)}; HttpOnly; Path=/rterm-proxy; SameSite=Strict${this.options.secure ? "; Secure" : ""}`,
          ];
        }
        const contentType = upstreamResponse.headers["content-type"] ?? "";
        if (!contentType.includes("text/html")) {
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          const body = this.rewriteHtml(Buffer.concat(chunks).toString("utf8"));
          delete responseHeaders["content-encoding"];
          delete responseHeaders["content-length"];
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          response.end(body);
        });
      },
    );
    this.handleProxyError(upstreamRequest, response);
    request.pipe(upstreamRequest);
  }

  /** Authenticates and bridges a browser WebSocket upgrade to rterm. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const capability = this.validCapability(request, requestUrl);
    const upstream = capability && this.upstreamUrl(requestUrl);
    if (!upstream) {
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (client) => {
      this.clients.add(client);
      const upstreamUrl = new URL(upstream);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      const upstreamSocket = new WebSocket(upstreamUrl.toString(), {
        headers: { host: upstream.host },
      });
      this.upstreamSockets.add(upstreamSocket);
      const close = (): void => {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING)
          client.close();
        if (
          upstreamSocket.readyState === WebSocket.OPEN ||
          upstreamSocket.readyState === WebSocket.CONNECTING
        )
          upstreamSocket.close();
      };
      client.on("close", () => this.clients.delete(client));
      client.on("close", close);
      client.on("error", close);
      client.on("message", (data, isBinary) => {
        if (upstreamSocket.readyState === WebSocket.OPEN)
          upstreamSocket.send(data, { binary: isBinary });
      });
      upstreamSocket.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      upstreamSocket.on("close", () => {
        this.upstreamSockets.delete(upstreamSocket);
        close();
      });
      upstreamSocket.on("error", close);
    });
  }

  /** Closes active proxy sockets and invalidates all embed capabilities. */
  close(): void {
    for (const client of this.clients) client.terminate();
    for (const upstreamSocket of this.upstreamSockets) upstreamSocket.terminate();
    this.clients.clear();
    this.upstreamSockets.clear();
    this.sockets.close();
    this.capabilities.clear();
  }

  private validCapability(
    request: IncomingMessage,
    requestUrl: URL,
  ): { token: string; deviceId: string } | undefined {
    const token =
      requestUrl.searchParams.get("proxyToken") ?? readCookie(request, "pesk-rterm-proxy");
    if (!token) return undefined;
    const stored = this.capabilities.get(token);
    if (
      !stored ||
      stored.expiresAt <= Date.now() ||
      !this.options.isDeviceAuthorized(stored.deviceId)
    ) {
      this.capabilities.delete(token);
      return undefined;
    }
    return { token, deviceId: stored.deviceId };
  }

  private upstreamUrl(requestUrl: URL): URL | undefined {
    try {
      const configured = new URL(this.options.url);
      const proxyPath = requestUrl.pathname.slice(this.pathPrefix.length - 1) || "/";
      const providerIndex = configured.pathname.indexOf("/provider/");
      const prefix = providerIndex >= 0 ? configured.pathname.slice(0, providerIndex) : "";
      configured.pathname = `${prefix}${proxyPath}`.replace(/\/\/+/g, "/");
      configured.search = requestUrl.search;
      configured.searchParams.delete("proxyToken");
      return configured;
    } catch {
      return undefined;
    }
  }

  private rewriteHtml(body: string): string {
    return body.replace(/(src|href)=(['"])\/([^"' >]*)/g, (match, attribute, quote, path) => {
      if (`/${path}`.startsWith(this.pathPrefix)) return match;
      return `${attribute}=${quote}${this.pathPrefix}${path}`;
    });
  }

  private handleProxyError(request: ClientRequest, response: ServerResponse): void {
    request.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Unable to reach rterm");
    });
  }
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function removeCookie(header: string | string[] | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const values = Array.isArray(header) ? header : [header];
  const cookies = values.flatMap((value) =>
    value
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item && item.slice(0, item.indexOf("=")).trim() !== name),
  );
  return cookies.length ? cookies.join("; ") : undefined;
}
