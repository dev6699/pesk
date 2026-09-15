import { randomUUID } from "node:crypto";
import { RtermClient, type RtermSessionsRequest, type RtermSessionsResponse } from "./rterm-client";

export interface RemoteTerminalManagerOptions {
  enabled: boolean;
  url: string;
  requestSessions: (
    threadId: string,
    request: RtermSessionsRequest,
  ) => Promise<RtermSessionsResponse>;
  selectSession: (threadId: string, sessionId: string) => boolean;
}

/** Owns one independent remote-terminal client for each thread. */
export class RemoteTerminalManager {
  private readonly clients = new Map<string, RtermClient>();
  private readonly roomIds = new Map<string, string>();
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
        requestSessions: (request) => this.options.requestSessions(threadId, request),
        selectSession: (sessionId) => this.options.selectSession(threadId, sessionId),
      });
      this.clients.set(threadId, client);
    }
    return client;
  }

  getSnapshot(threadId = this.currentThreadId): RtermSnapshot {
    if (!threadId) return this.emptySnapshot();
    return this.getClient(threadId).getSnapshot();
  }

  getEmbedUrlForSession(threadId = this.currentThreadId): Promise<string> {
    return threadId
      ? this.getClient(threadId).getEmbedUrlForSession(this.getRoomId(threadId))
      : Promise.resolve("");
  }

  disconnectAll(): void {
    this.clients.clear();
    this.roomIds.clear();
  }

  private getRoomId(threadId: string): string {
    let roomId = this.roomIds.get(threadId);
    if (!roomId) {
      roomId = randomUUID();
      this.roomIds.set(threadId, roomId);
    }
    return roomId;
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
