import { RtermClient, type RtermSnapshot } from "./rterm-client";

export interface RemoteTerminalManagerOptions {
  enabled: boolean;
  url: string;
  onChanged: (threadId: string, snapshot: RtermSnapshot) => void;
  onOutput?: (threadId: string, data: string) => void;
}

/** Owns one independent remote-terminal client for each thread. */
export class RemoteTerminalManager {
  private readonly clients = new Map<string, RtermClient>();
  private currentThreadId: string | undefined;

  constructor(private readonly options: RemoteTerminalManagerOptions) {}

  setCurrentThread(threadId: string | undefined): void {
    this.currentThreadId = threadId;
  }

  getClient(threadId: string): RtermClient {
    let client = this.clients.get(threadId);
    if (!client) {
      client = new RtermClient({
        enabled: this.options.enabled,
        url: this.options.url,
        onChanged: (snapshot) => this.options.onChanged(threadId, snapshot),
        onOutput: (data) => this.options.onOutput?.(threadId, data),
      });
      this.clients.set(threadId, client);
    }
    return client;
  }

  getSnapshot(threadId = this.currentThreadId): RtermSnapshot {
    if (!threadId) return this.emptySnapshot();
    return this.getClient(threadId).getSnapshot();
  }

  getEmbedUrl(threadId = this.currentThreadId): string {
    return threadId ? this.getClient(threadId).getEmbedUrl() : "";
  }

  toggleConnection(threadId = this.currentThreadId): boolean {
    if (!threadId || !this.options.url) return false;
    return this.getClient(threadId).toggleConnection();
  }

  authenticate(code: string): boolean {
    return this.currentThreadId ? this.getClient(this.currentThreadId).authenticate(code) : false;
  }

  write(input: string): boolean {
    return this.currentThreadId ? this.getClient(this.currentThreadId).write(input) : false;
  }

  resize(cols: number, rows: number): boolean {
    return this.currentThreadId ? this.getClient(this.currentThreadId).resize(cols, rows) : false;
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
  }

  private emptySnapshot(): RtermSnapshot {
    return {
      enabled: this.options.enabled,
      state: "disconnected",
      output: "",
      hostLabel: "",
      authFailed: false,
    };
  }
}
