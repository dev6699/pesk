import WebSocket from "ws";
import { randomUUID } from "node:crypto";

export type RtermState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface RtermSnapshot {
  enabled: boolean;
  state: RtermState;
  output: string;
  hostLabel: string;
  authFailed: boolean;
}

export interface RtermExecution {
  id: string;
  status: "running" | "completed";
  exitCode?: number;
  output: string;
  startOffset: number;
}

export interface RtermClientOptions {
  enabled?: boolean;
  url?: string;
  onChanged: (snapshot: RtermSnapshot) => void;
  onOutput?: (text: string) => void;
  maxBytes?: number;
}

/** Connects to one forwarded rterm WebSocket and preserves its PTY bytes. */
export class RtermClient {
  private socket: WebSocket | undefined;
  private state: RtermState = "disconnected";
  private buffer = "";
  private completionFragment = "";
  private truncated = false;
  private hostLabel = "";
  private authFailed = false;
  private url: string;
  private readonly maxBytes: number;
  private readonly executions = new Map<string, RtermExecution>();

  constructor(private readonly options: RtermClientOptions) {
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.url = options.url ?? "";
    try {
      this.hostLabel = this.url ? new URL(this.url).hostname || "remote shell" : "";
    } catch {
      this.hostLabel = "remote shell";
    }
  }

  getSnapshot(): RtermSnapshot {
    return {
      enabled: this.options.enabled !== false,
      state: this.state,
      output: this.buffer,
      hostLabel: this.hostLabel,
      authFailed: this.authFailed,
    };
  }

  connect(url: string): boolean {
    if (this.options.enabled === false) return false;
    if (!/^wss?:\/\//.test(url)) return false;
    this.disconnect();
    this.buffer = "";
    this.truncated = false;
    this.authFailed = false;
    this.url = url;
    try {
      this.hostLabel = new URL(url).hostname || "remote shell";
    } catch {
      this.hostLabel = "remote shell";
    }
    this.state = "connecting";
    this.publish();
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => this.publish());
    socket.on("message", (value) => {
      if (this.socket !== socket) return;
      this.handleMessage(value.toString());
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearTerminalBuffer();
      this.state = "disconnected";
      this.publish();
    });
    socket.on("error", () => {
      if (this.socket !== socket) return;
      this.state = "disconnected";
      this.clearTerminalBuffer();
      this.publish();
    });
    return true;
  }

  reconnect(): boolean {
    if (!this.url) return false;
    return this.connect(this.url);
  }

  toggleConnection(): boolean {
    if (this.options.enabled === false) return false;
    if (this.state === "disconnected") return this.reconnect();
    this.disconnect();
    return true;
  }

  getEmbedUrl(): string {
    if (this.options.enabled === false) return "";
    if (!this.url) return "";
    try {
      const pageUrl = new URL(this.url);
      pageUrl.protocol = pageUrl.protocol === "wss:" ? "https:" : "http:";
      pageUrl.pathname = pageUrl.pathname.replace(/\/ws\/?$/, "");
      pageUrl.searchParams.set("embed", "1");
      pageUrl.searchParams.set("bridge", "parent");
      return pageUrl.toString();
    } catch {
      const pageUrl = this.url.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
      return `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}embed=1&bridge=parent`;
    }
  }

  resize(cols: number, rows: number): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(`2${JSON.stringify({ cols, rows })}`);
    return true;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    const hadOutput = this.buffer.length > 0 || this.truncated;
    this.clearTerminalBuffer();
    if (this.state !== "disconnected") {
      this.state = "disconnected";
      this.publish();
    } else if (hadOutput) {
      this.publish();
    }
    this.executions.clear();
  }

  authenticate(code: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(`b${code}`);
    return true;
  }

  execute(command: string): RtermExecution | undefined {
    if (this.state !== "connected") return undefined;
    const id = randomUUID();
    const execution: RtermExecution = {
      id,
      status: "running",
      output: "",
      startOffset: this.buffer.length,
    };
    this.executions.set(id, execution);
    // Emit an internal OSC (Operating System Command) completion marker after
    // the command. The client uses its execution ID and shell status to resolve waits.
    const wrapped = `{ ${command}\n}; status=$?; printf '\\033]9;pesk-done;${id};%s\\007' "$status"\n`;
    if (!this.write(wrapped)) {
      this.executions.delete(id);
      return undefined;
    }
    return execution;
  }

  async wait(executionId: string, timeoutMs = 5000): Promise<RtermExecution | undefined> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const execution = this.executions.get(executionId);
      if (!execution || execution.status === "completed") return execution;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.executions.get(executionId);
  }

  write(input: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(`0${input}`);
    return true;
  }

  clearBuffer(): void {
    this.clearTerminalBuffer();
    this.publish();
  }

  private clearTerminalBuffer(): void {
    this.buffer = "";
    this.completionFragment = "";
    this.truncated = false;
  }

  readRecent(maxLines = 200): { output: string; truncated: boolean } {
    const lines = this.buffer.split("\n");
    const truncated = lines.length > maxLines || this.truncated;
    return { output: lines.slice(-maxLines).join("\n"), truncated };
  }

  private handleMessage(message: string): void {
    if (!message) return;
    const kind = message[0];
    if (kind === "a") {
      this.state = "authenticating";
      this.authFailed = false;
      this.publish();
      return;
    }
    if (kind === "c") {
      this.state = "connected";
      this.authFailed = false;
      this.publish();
      return;
    }
    if (kind === "d") {
      this.state = "authenticating";
      this.authFailed = true;
      this.publish();
      return;
    }
    if (kind !== "1") return;
    const text = Buffer.from(message.slice(1), "base64").toString("utf8");
    this.buffer += text;
    const completionText = this.completionFragment + text;
    for (const match of completionText.matchAll(/\u001b\]9;pesk-done;([\da-f-]+);(-?\d+)\u0007/g)) {
      const execution = this.executions.get(match[1]);
      if (!execution) continue;
      execution.status = "completed";
      execution.exitCode = Number(match[2]);
      execution.output = this.buffer.slice(execution.startOffset);
    }
    const fragmentStart = completionText.lastIndexOf("\u001b]9;pesk-done;");
    const trailingFragment = fragmentStart >= 0 ? completionText.slice(fragmentStart) : "";
    this.completionFragment = /^\u001b\]9;pesk-done;[\da-f-]*(?:;-?\d*)?$/.test(trailingFragment)
      ? trailingFragment
      : "";
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      const bytes = Buffer.from(this.buffer, "utf8");
      this.buffer = bytes.subarray(bytes.length - this.maxBytes).toString("utf8");
      this.truncated = true;
    }
    this.options.onOutput?.(text);
    this.publish();
  }

  private publish(): void {
    this.options.onChanged(this.getSnapshot());
  }
}
