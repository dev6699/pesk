export type RtermState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface RtermSnapshot {
  enabled: boolean;
  state: RtermState;
  output: string;
  hostLabel: string;
  authFailed: boolean;
}

export interface ProviderSessionDescriptor {
  sessionId: string;
  provider: string;
  target: string;
  user: string;
}

export type RtermSessionsRequest = { requestId: string };

export interface RtermSessionsResponse {
  requestId: string;
  ok: boolean;
  connected?: boolean;
  result?: unknown;
  error?: string;
  unavailable?: boolean;
}

export interface RtermProviderSession extends ProviderSessionDescriptor {
  token: string;
}

export interface RtermClientOptions {
  enabled?: boolean;
  url?: string;
  requestSessions: (request: RtermSessionsRequest) => Promise<RtermSessionsResponse>;
  selectSession: (sessionId: string) => boolean;
}

/** Represents the rterm embed and delegates provider operations to it. */
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

  async requestSessions(request: RtermSessionsRequest): Promise<RtermSessionsResponse> {
    const response = await this.options.requestSessions(request);
    if (response.ok) this.adoptSessions(response.result);
    return response;
  }

  selectProviderSession(sessionId: string): boolean {
    const selected = this.options.selectSession(sessionId);
    if (selected) {
      this.activeSessionId = sessionId;
      this.updateHostLabel();
    }
    return selected;
  }

  getProviderSessionTabLabel(sessionId?: string): string | undefined {
    const selectedSessionId = sessionId ?? this.activeSessionId;
    const session = selectedSessionId ? this.providerSessions.get(selectedSessionId) : undefined;
    return session
      ? `${session.user}@${session.target} · ${session.sessionId.slice(0, 8)}`
      : undefined;
  }

  async readProvider(maxLines = 200, sessionId?: string) {
    const session = this.resolveProviderSession(sessionId);
    if (!session) return undefined;
    const response = await fetch(`${this.providerApiUrl(session)}/read?maxLines=${maxLines}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as { output: string; truncated: boolean };
  }

  async executeProvider(command: string, sessionId?: string) {
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

  async uploadProviderBytes(
    data: Uint8Array,
    remotePath: string,
    filename?: string,
    sessionId?: string,
  ) {
    const session = this.resolveProviderSession(sessionId);
    if (!session) return undefined;
    const query = new URLSearchParams({ path: remotePath });
    if (filename) query.set("filename", filename);
    const response = await fetch(`${this.providerApiUrl(session)}/upload?${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}` },
      body: data as unknown as BodyInit,
    });
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as { bytes?: unknown };
    return typeof result.bytes === "number" ? result.bytes : data.byteLength;
  }

  async downloadProviderBytes(remotePath: string, sessionId?: string) {
    const session = this.resolveProviderSession(sessionId);
    if (!session) return undefined;
    const response = await fetch(
      `${this.providerApiUrl(session)}/download?path=${encodeURIComponent(remotePath)}`,
      {
        headers: { Authorization: `Bearer ${session.token}` },
      },
    );
    if (!response.ok) throw new Error(await response.text());
    return new Uint8Array(await response.arrayBuffer());
  }

  async getEmbedUrlForSession(roomId?: string): Promise<string> {
    if (this.options.enabled === false || !this.options.url) return "";
    try {
      const pageUrl = new URL(this.options.url);
      pageUrl.searchParams.set("embed", "1");
      if (roomId) pageUrl.searchParams.set("roomId", roomId);
      return pageUrl.toString();
    } catch {
      return "";
    }
  }

  private getUrlHost(url: string): string {
    try {
      return url ? new URL(url).hostname || "remote shell" : "";
    } catch {
      return "remote shell";
    }
  }

  private adoptSessions(value: unknown): void {
    if (!Array.isArray(value)) return;
    const sessions = new Map<string, RtermProviderSession>();
    for (const item of value) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.sessionId !== "string" ||
        typeof item.token !== "string"
      )
        continue;
      const session = item as RtermProviderSession;
      sessions.set(session.sessionId, session);
    }
    this.providerSessions.clear();
    for (const [sessionId, session] of sessions) this.providerSessions.set(sessionId, session);
    if (!this.activeSessionId || !this.providerSessions.has(this.activeSessionId)) {
      this.activeSessionId = this.providerSessions.keys().next().value as string | undefined;
    }
    this.updateHostLabel();
  }

  private updateHostLabel(): void {
    const session = this.activeSessionId
      ? this.providerSessions.get(this.activeSessionId)
      : undefined;
    this.hostLabel =
      session && typeof session.user === "string" && typeof session.target === "string"
        ? `${session.user}@${session.target}`
        : this.getUrlHost(this.options.url ?? "");
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
}
