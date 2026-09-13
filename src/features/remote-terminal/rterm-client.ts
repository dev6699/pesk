export type RtermState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface RtermSnapshot {
  enabled: boolean;
  state: RtermState;
  output: string;
  hostLabel: string;
  authFailed: boolean;
}

export interface RtermProviderSession {
  sessionId: string;
  token: string;
  provider: string;
  target: string;
  user: string;
}

export interface RtermClientOptions {
  enabled?: boolean;
  url?: string;
  onChanged: (snapshot: RtermSnapshot) => void;
}

/** Tracks one Pesk thread's provider session and its HTTP tool endpoint. */
export class RtermClient {
  private state: RtermState = "disconnected";
  private hostLabel = "";
  private readonly providerSessions = new Map<string, RtermProviderSession>();
  private activeSessionId: string | undefined;

  constructor(private readonly options: RtermClientOptions) {
    this.hostLabel = this.getUrlHost(options.url ?? "");
  }

  getSnapshot(): RtermSnapshot {
    return {
      enabled: this.options.enabled !== false,
      state: this.state,
      output: "",
      hostLabel: this.hostLabel,
      authFailed: false,
    };
  }

  setProviderSession(session: RtermProviderSession): void {
    this.providerSessions.set(session.sessionId, session);
    this.activeSessionId = session.sessionId;
    this.hostLabel = `${session.user}@${session.target}`;
    this.state = "connected";
    this.publish();
  }

  clearProviderSession(sessionId?: string): void {
    if (sessionId) this.providerSessions.delete(sessionId);
    else this.providerSessions.clear();
    if (this.activeSessionId && !this.providerSessions.has(this.activeSessionId))
      this.activeSessionId = [...this.providerSessions.keys()].at(-1);
    const active = this.activeSessionId
      ? this.providerSessions.get(this.activeSessionId)
      : undefined;
    if (active) this.hostLabel = `${active.user}@${active.target}`;
    this.state = active ? "connected" : "disconnected";
    this.publish();
  }

  getProviderSessions(): RtermProviderSession[] {
    return [...this.providerSessions.values()];
  }

  selectProviderSession(sessionId: string): boolean {
    const session = this.providerSessions.get(sessionId);
    if (!session) return false;
    this.activeSessionId = sessionId;
    this.hostLabel = `${session.user}@${session.target}`;
    this.state = "connected";
    this.publish();
    return true;
  }

  async readProvider(
    maxLines = 200,
    sessionId?: string,
  ): Promise<{ output: string; truncated: boolean } | undefined> {
    const session = this.resolveProviderSession(sessionId);
    if (!session) return undefined;
    const response = await fetch(`${this.providerApiUrl(session)}/read?maxLines=${maxLines}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as { output: string; truncated: boolean };
  }

  async executeProvider(
    command: string,
    sessionId?: string,
  ): Promise<{ output: string; exitCode: number } | undefined> {
    const session = this.resolveProviderSession(sessionId);
    if (!session) return undefined;
    const response = await fetch(`${this.providerApiUrl(session)}/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as { output: string; exitCode: number };
  }

  getEmbedUrl(): string {
    if (this.options.enabled === false || !this.options.url) return "";
    try {
      const pageUrl = new URL(this.options.url);
      pageUrl.searchParams.set("embed", "1");
      return pageUrl.toString();
    } catch {
      return "";
    }
  }

  private providerApiUrl(session: RtermProviderSession): string {
    const base = (this.options.url ?? "").replace(/\/$/, "");
    return base.replace(
      /\/provider\/[^/]+$/,
      `/api/sessions/${encodeURIComponent(session.sessionId)}`,
    );
  }

  private resolveProviderSession(sessionId?: string): RtermProviderSession | undefined {
    if (sessionId) return this.providerSessions.get(sessionId);
    if (this.activeSessionId) return this.providerSessions.get(this.activeSessionId);
    return this.providerSessions.values().next().value as RtermProviderSession | undefined;
  }

  private getUrlHost(url: string): string {
    try {
      return url ? new URL(url).hostname || "remote shell" : "";
    } catch {
      return "remote shell";
    }
  }

  private publish(): void {
    this.options.onChanged(this.getSnapshot());
  }
}
