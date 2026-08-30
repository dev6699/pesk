import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import webpush from "web-push";
import QRCode from "qrcode";

interface PushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  deviceId?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface ChatWebServerOptions {
  enabled: boolean;
  port: number;
  listenHost?: string;
  tlsKey?: string;
  tlsCert?: string;
  rendererDirectory: string;
  webPushVapidPath: string;
  webPushSubscriptionsPath: string;
  deviceCredentialsPath: string;
  getState: () => unknown;
  handleCommand: (command: unknown, reply: (message: unknown) => void) => void;
  debug: (...values: unknown[]) => void;
}

export interface PairingDevice {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  pushEnabled: boolean;
  pushRegistered: boolean;
}

export interface PairingInfo {
  code: string;
  urls: string[];
  expiresAt: number;
  qrDataUrl: string;
  deviceName: string;
}

interface StoredDevice extends PairingDevice {
  credentialHash: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Serves the chat renderer to LAN browsers and bridges commands to Codex. */
export class ChatWebServer {
  private readonly clients = new Map<WebSocket, string>();
  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private started = false;
  private subscriptions = new Map<string, PushSubscription>();
  private vapidKeys: VapidKeys | undefined;
  private preferredAddress: string | undefined;
  private devices = new Map<string, StoredDevice>();
  private pairing: { codeHash: string; expiresAt: number; deviceName: string } | undefined;
  private completedPairingName: string | undefined;
  private listeningPort: number | undefined;

  constructor(private readonly options: ChatWebServerOptions) {
    const requestHandler = (
      request: IncomingMessage,
      response: import("node:http").ServerResponse,
    ) => this.handleHttpRequest(request, response);
    if (options.tlsKey || options.tlsCert) {
      if (!options.tlsKey || !options.tlsCert) {
        throw new Error("Both webTlsKey and webTlsCert are required for HTTPS web access.");
      }
      this.server = createTlsServer(
        {
          key: readFileSync(options.tlsKey),
          cert: readFileSync(options.tlsCert),
        },
        requestHandler,
      );
    } else {
      this.server = createServer(requestHandler);
    }
    this.sockets = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/web-socket") {
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (client) =>
        this.sockets.emit("connection", client, request, undefined),
      );
    });
    this.sockets.on("connection", (client: WebSocket) => this.handleConnection(client));
  }

  start(): Promise<void> {
    if (!this.options.enabled) return Promise.resolve();
    this.vapidKeys = loadOrCreateVapidKeys(this.options.webPushVapidPath);
    this.preferredAddress = this.options.tlsCert
      ? certificateAddress(this.options.tlsCert)
      : undefined;
    this.subscriptions = loadSubscriptions(this.options.webPushSubscriptionsPath);
    this.devices = loadDevices(this.options.deviceCredentialsPath);
    webpush.setVapidDetails(
      "mailto:pesk@localhost",
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey,
    );
    this.started = true;
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.on("error", (error) => this.options.debug("web chat error", error));
      this.server.listen(this.options.port, this.options.listenHost ?? "0.0.0.0", () => {
        this.listeningPort = (this.server.address() as AddressInfo).port;
        this.options.debug("web chat", {
          urls: accessUrls(this.listeningPort, this.isSecure(), this.preferredAddress),
        });
        resolve();
      });
    });
  }

  broadcast(state = this.options.getState()): void {
    if (!this.options.enabled) return;
    const message = JSON.stringify({ type: "state", state });
    for (const client of this.clients.keys()) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  /** Sends a push notification for the same background attention event used by desktop. */
  notifyCodexAttention(kind: "finished" | "approval" | "input"): void {
    this.sendPush(notificationForKind(kind));
  }

  stop(): Promise<void> {
    if (!this.started) return Promise.resolve();
    for (const client of this.clients.keys()) client.close();
    this.clients.clear();
    this.sockets.close();
    this.started = false;
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  getAccessInfo(): { urls: string[] } | undefined {
    if (!this.options.enabled) return undefined;
    return {
      urls: accessUrls(
        this.listeningPort ?? this.options.port,
        this.isSecure(),
        this.preferredAddress,
      ),
    };
  }

  /** Returns the actual bound port, including when configured with port zero. */
  getPort(): number {
    return this.listeningPort ?? this.options.port;
  }

  async createPairing(deviceName: string): Promise<PairingInfo | undefined> {
    if (!this.options.enabled) return undefined;
    const code = randomBytes(4).toString("hex").toUpperCase();
    const expiresAt = Date.now() + 5 * 60_000;
    const requestedName = deviceName.trim().slice(0, 80);
    if (
      !requestedName ||
      [...this.devices.values()].some(
        (device) => device.name.toLowerCase() === requestedName.toLowerCase(),
      )
    ) {
      throw new Error("Device name is empty or already in use");
    }
    const uniqueName = requestedName;
    this.completedPairingName = undefined;
    this.pairing = {
      codeHash: hashSecret(code),
      expiresAt,
      deviceName: uniqueName,
    };
    const urls = accessUrls(this.options.port, this.isSecure(), this.preferredAddress);
    const pairingUrl = `${urls[0] ?? ""}pair?code=${encodeURIComponent(code)}`;
    return {
      code,
      expiresAt,
      urls: urls.map((url) => `${url}pair?code=${encodeURIComponent(code)}`),
      qrDataUrl: await QRCode.toDataURL(pairingUrl, { width: 220, margin: 2 }),
      deviceName: uniqueName,
    };
  }

  getPairingStatus(): { active: boolean; pairedDeviceName?: string } {
    return {
      active: Boolean(this.pairing && this.pairing.expiresAt > Date.now()),
      pairedDeviceName: this.completedPairingName,
    };
  }

  listDevices(): PairingDevice[] {
    return [...this.devices.values()].map(({ credentialHash: _, ...device }) => ({
      ...device,
      pushRegistered: [...this.subscriptions.values()].some(
        (subscription) => subscription.deviceId === device.id,
      ),
    }));
  }

  setDevicePushEnabled(id: string, enabled: boolean): void {
    const device = this.devices.get(id);
    if (!device) return;
    device.pushEnabled = enabled;
    saveDevices(this.options.deviceCredentialsPath, this.devices);
  }

  revokeDevice(id: string): void {
    this.devices.delete(id);
    for (const [client, deviceId] of this.clients) {
      if (deviceId === id) {
        this.clients.delete(client);
        client.close(1008, "Device revoked");
      }
    }
    saveDevices(this.options.deviceCredentialsPath, this.devices);
    for (const [endpoint, subscription] of this.subscriptions) {
      if (subscription.deviceId === id) this.subscriptions.delete(endpoint);
    }
    saveSubscriptions(this.options.webPushSubscriptionsPath, this.subscriptions);
  }

  private handleConnection(client: WebSocket): void {
    let authenticated = false;

    const authenticate = (message: Record<string, unknown>): boolean => {
      if (message.type !== "authenticate" || typeof message.credential !== "string") {
        client.close(1008, "Authentication required");
        return false;
      }
      const device = this.authenticateCredential(message.credential);
      if (!device) {
        client.close(1008, "Authentication required");
        return false;
      }
      authenticated = true;
      this.addAuthenticatedClient(client, device.id);
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
      const record = message as Record<string, unknown>;
      if (!authenticated) {
        authenticate(record);
        return;
      }
      if (!this.clients.has(client)) return;
      this.options.handleCommand(message, (reply) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(reply));
        }
      });
    });
    client.on("close", () => {
      this.options.debug("web chat disconnected");
      this.clients.delete(client);
    });
  }

  private addAuthenticatedClient(client: WebSocket, deviceId: string): void {
    if (this.clients.has(client)) return;
    this.clients.set(client, deviceId);
    this.options.debug("web chat authenticated", {
      clients: this.clients.size,
    });
    client.send(JSON.stringify({ type: "state", state: this.options.getState() }));
  }

  private authenticatedDevice(request: IncomingMessage): StoredDevice | undefined {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? this.authenticateCredential(header.slice(7)) : undefined;
  }

  private authenticateCredential(credential: string): StoredDevice | undefined {
    const hash = hashSecret(credential);
    for (const device of this.devices.values()) {
      if (device.credentialHash !== hash) continue;
      device.lastUsedAt = Date.now();
      saveDevices(this.options.deviceCredentialsPath, this.devices);
      return device;
    }
    return undefined;
  }

  private async handlePairExchange(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      const body = JSON.parse(await readRequestBody(request)) as {
        code?: unknown;
        name?: unknown;
      };
      if (
        !this.pairing ||
        this.pairing.expiresAt < Date.now() ||
        typeof body.code !== "string" ||
        hashSecret(body.code.toUpperCase()) !== this.pairing.codeHash
      ) {
        this.writeJson(response, { error: "Pairing code expired or invalid" }, 400);
        return;
      }
      const id = randomBytes(12).toString("hex");
      const credential = randomBytes(32).toString("base64url");
      const device: StoredDevice = {
        id,
        name: this.pairing.deviceName,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        pushEnabled: true,
        pushRegistered: false,
        credentialHash: hashSecret(credential),
      };
      this.devices.set(id, device);
      saveDevices(this.options.deviceCredentialsPath, this.devices);
      this.completedPairingName = device.name;
      this.pairing = undefined;
      this.writeJson(response, { credential, deviceId: id });
    } catch {
      this.writeJson(response, { error: "Invalid pairing request" }, 400);
    }
  }

  private isSecure(): boolean {
    return Boolean(this.options.tlsKey && this.options.tlsCert);
  }

  private handleHttpRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/pair/exchange") {
      void this.handlePairExchange(request, response);
      return;
    }
    if (requestUrl.pathname === "/web-push/config") {
      if (!this.isHttpAuthenticated(request)) {
        response.writeHead(401).end("Authentication required");
        return;
      }
      this.writeJson(response, { publicKey: this.vapidKeys?.publicKey });
      return;
    }
    if (requestUrl.pathname === "/web-push/subscribe") {
      void this.handleSubscriptionRequest(request, response, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/pair") {
      this.writeWebChat(
        request,
        response,
        path.join(this.options.rendererDirectory, "web-chat.html"),
      );
      return;
    }
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
    if (relative === "manifest.webmanifest") {
      this.writeManifest(request, response, file);
      return;
    }
    if (relative === "web-chat.html") {
      this.writeWebChat(request, response, file);
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(response);
  }

  private writeManifest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    file: string,
  ): void {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      response.writeHead(500).end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[".json"],
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(manifest));
  }

  private writeWebChat(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    file: string,
  ): void {
    let html = readFileSync(file, "utf8");
    html = html.replace("web-adapter.js", "web-adapter.js?v=12");
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[".html"],
      "Cache-Control": "no-store",
    });
    response.end(html);
  }

  private isHttpAuthenticated(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    return Boolean(this.authenticateCredential(header.slice(7)));
  }

  private writeJson(
    response: import("node:http").ServerResponse,
    value: unknown,
    status = 200,
  ): void {
    response.writeHead(status, {
      "Content-Type": MIME_TYPES[".json"],
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(value));
  }

  private async handleSubscriptionRequest(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
    requestUrl: URL,
  ): Promise<void> {
    const device = this.authenticatedDevice(request);
    if (!device) {
      response.writeHead(401).end("Authentication required");
      return;
    }
    if (request.method === "DELETE") {
      const endpoint = requestUrl.searchParams.get("endpoint");
      if (endpoint) {
        this.subscriptions.delete(endpoint);
        saveSubscriptions(this.options.webPushSubscriptionsPath, this.subscriptions);
      }
      this.writeJson(response, { ok: true });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    try {
      const subscription = JSON.parse(await readRequestBody(request)) as PushSubscription;
      if (!isPushSubscription(subscription)) {
        this.writeJson(response, { error: "Invalid subscription" }, 400);
        return;
      }
      subscription.deviceId = device.id;
      for (const [endpoint, stored] of this.subscriptions) {
        if (stored.deviceId === device.id && endpoint !== subscription.endpoint) {
          this.subscriptions.delete(endpoint);
        }
      }
      this.subscriptions.set(subscription.endpoint, subscription);
      saveSubscriptions(this.options.webPushSubscriptionsPath, this.subscriptions);
      this.writeJson(response, { ok: true });
    } catch {
      this.writeJson(response, { error: "Invalid subscription" }, 400);
    }
  }

  private sendPush(notification: { kind: string; title: string; body: string }): void {
    if (!this.vapidKeys || !this.subscriptions.size) {
      this.options.debug("web push not dispatched", {
        kind: notification.kind,
        hasVapidKeys: Boolean(this.vapidKeys),
        storedSubscriptions: this.subscriptions.size,
      });
      return;
    }
    this.options.debug("web push dispatch", {
      kind: notification.kind,
      stored: [...this.subscriptions.keys()].map(endpointFingerprint),
    });
    const payload = JSON.stringify({
      ...notification,
      url: "./web-chat.html",
    });
    for (const [endpoint, subscription] of this.subscriptions) {
      const device = subscription.deviceId ? this.devices.get(subscription.deviceId) : undefined;
      if (!device || !device.pushEnabled) continue;
      this.options.debug("web push sending", {
        kind: notification.kind,
        endpoint: endpointFingerprint(endpoint),
      });
      void webpush
        .sendNotification(subscription, payload)
        .catch((error: { statusCode?: number }) => {
          this.options.debug("web push failed", {
            kind: notification.kind,
            endpoint: endpointFingerprint(endpoint),
            statusCode: error.statusCode,
          });
          if (error.statusCode !== 404 && error.statusCode !== 410) return;
          this.subscriptions.delete(endpoint);
          saveSubscriptions(this.options.webPushSubscriptionsPath, this.subscriptions);
        });
    }
  }
}

function notificationForKind(kind: "finished" | "approval" | "input"): {
  kind: string;
  title: string;
  body: string;
} {
  if (kind === "finished") {
    return {
      kind,
      title: "Pesk finished",
      body: "Your Pesk response is ready.",
    };
  }
  if (kind === "approval") {
    return {
      kind,
      title: "Pesk needs approval",
      body: "Open Pesk to review the request.",
    };
  }
  return {
    kind,
    title: "Pesk needs your input",
    body: "Open Pesk to answer the questions.",
  };
}

function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
}

function clientAddress(address: string | undefined): string | undefined {
  return address?.replace(/^::ffff:/, "");
}

function isPushSubscription(value: PushSubscription): boolean {
  return Boolean(
    value &&
    typeof value.endpoint === "string" &&
    value.endpoint.startsWith("https://") &&
    value.keys &&
    typeof value.keys.p256dh === "string" &&
    typeof value.keys.auth === "string",
  );
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 100_000) reject(new Error("Request too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function loadOrCreateVapidKeys(file: string): VapidKeys {
  try {
    const keys = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
    if (keys.publicKey && keys.privateKey) return keys;
  } catch {
    // Generate the first key pair below.
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function loadSubscriptions(file: string): Map<string, PushSubscription> {
  try {
    const values = JSON.parse(readFileSync(file, "utf8")) as PushSubscription[];
    return new Map(
      values
        .filter(isPushSubscription)
        .map((subscription) => [subscription.endpoint, subscription]),
    );
  } catch {
    return new Map();
  }
}

function loadDevices(file: string): Map<string, StoredDevice> {
  try {
    const values = JSON.parse(readFileSync(file, "utf8")) as StoredDevice[];
    return new Map(
      values
        .filter(
          (device) =>
            typeof device.id === "string" &&
            typeof device.name === "string" &&
            typeof device.credentialHash === "string",
        )
        .map((device) => [
          device.id,
          {
            ...device,
            pushEnabled: device.pushEnabled !== false,
            pushRegistered: false,
          },
        ]),
    );
  } catch {
    return new Map();
  }
}

function saveDevices(file: string, devices: Map<string, StoredDevice>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const persisted = [...devices.values()].map(({ pushRegistered: _, ...device }) => device);
  writeFileSync(file, JSON.stringify(persisted, null, 2), {
    mode: 0o600,
  });
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function saveSubscriptions(file: string, subscriptions: Map<string, PushSubscription>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...subscriptions.values()], null, 2), {
    mode: 0o600,
  });
}

function lanUrls(port: number, secure: boolean): string[] {
  const protocol = secure ? "https" : "http";
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => `${protocol}://${item.address}:${port}/`);
  return addresses.length ? addresses : [`${protocol}://127.0.0.1:${port}/`];
}

function accessUrls(port: number, secure: boolean, preferredAddress?: string): string[] {
  const urls = lanUrls(port, secure);
  if (!preferredAddress) return urls;
  return [
    ...urls.filter((url) => url.includes(`://${preferredAddress}:`)),
    ...urls.filter((url) => !url.includes(`://${preferredAddress}:`)),
  ];
}

function certificateAddress(file: string): string | undefined {
  try {
    const subjectAltName = new X509Certificate(readFileSync(file)).subjectAltName ?? "";
    return subjectAltName.match(/IP Address:([0-9.]+)/)?.[1];
  } catch {
    return undefined;
  }
}
