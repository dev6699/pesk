import {
  RtermClient,
  type ProviderSessionDescriptor,
  type RtermProviderSession,
  type RtermSnapshot,
} from "./rterm-client";

export interface RemoteTerminalManagerOptions {
  enabled: boolean;
  url: string;
  onChanged: (threadId: string, snapshot: RtermSnapshot) => void;
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

  setProviderSession(session: RtermProviderSession, threadId = this.currentThreadId): boolean {
    if (!threadId || !this.options.url) return false;
    this.getClient(threadId).setProviderSession(session);
    return true;
  }

  adoptProviderSession(
    session: ProviderSessionDescriptor,
    handoff: string,
    threadId = this.currentThreadId,
  ): Promise<boolean> {
    if (!threadId || !this.options.url) return Promise.resolve(false);
    return this.getClient(threadId).adoptProviderSession(session, handoff);
  }

  clearProviderSession(sessionId?: string, threadId = this.currentThreadId): boolean {
    if (!threadId) return false;
    this.getClient(threadId).clearProviderSession(sessionId);
    return true;
  }

  disconnectAll(): void {
    this.clients.clear();
  }

  private emptySnapshot(): RtermSnapshot {
    return {
      enabled: this.options.enabled,
      sessions: [],
      activeSessionId: undefined,
      state: "disconnected",
      output: "",
      hostLabel: "",
      authFailed: false,
    };
  }
}
