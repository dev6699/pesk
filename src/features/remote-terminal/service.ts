import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import { RemoteTerminalToolHandler } from "./handler";
import type { DynamicApprovalKind } from "../../codex/dynamic-tools";
import { RemoteTerminalManager } from "./manager";
import { REMOTE_TERMINAL_TOOLS } from "./tools";
import type { RtermSessionsRequest, RtermSessionsResponse } from "./rterm-client";

const RTERM_REQUEST_TIMEOUT_MS = 15_000;

export interface RemoteTerminalServiceOptions {
  enabled: boolean;
  url: string;
  sendSessionsRequest: (threadId: string, request: RtermSessionsRequest) => boolean;
  sendSessionSelection: (threadId: string, sessionId: string) => boolean;
  readWorkspaceFile: (path: string) => Promise<string>;
  writeWorkspaceFile: (path: string, dataBase64: string) => Promise<void>;
  requestApproval: (
    threadId: string,
    callId: string,
    command: string,
    reason: string,
    kind?: DynamicApprovalKind,
    toolName?: string,
  ) => Promise<boolean>;
}

/** Application-facing remote-terminal boundary; the manager and tool handler stay internal. */
export class RemoteTerminalService {
  private readonly manager: RemoteTerminalManager;
  private readonly toolHandler: RemoteTerminalToolHandler;
  private readonly pending = new Map<
    string,
    { threadId: string; resolve: (response: RtermSessionsResponse) => void; timer: NodeJS.Timeout }
  >();

  constructor(options: RemoteTerminalServiceOptions) {
    this.manager = new RemoteTerminalManager({
      ...options,
      requestSessions: (threadId, request) =>
        this.requestSessionsFromRenderer(options, threadId, request),
      selectSession: (threadId, sessionId) => options.sendSessionSelection(threadId, sessionId),
    });
    this.toolHandler = new RemoteTerminalToolHandler({
      getRterm: (threadId) => this.manager.getClient(threadId),
      readWorkspaceFile: options.readWorkspaceFile,
      writeWorkspaceFile: options.writeWorkspaceFile,
      requestApproval: options.requestApproval,
    });
  }

  get dynamicTools() {
    return REMOTE_TERMINAL_TOOLS;
  }

  setCurrentThread(threadId: string | undefined): void {
    this.manager.setCurrentThread(threadId);
  }

  getSnapshot(): RtermSnapshot {
    return this.manager.getSnapshot();
  }

  getEmbedUrlForSession(): Promise<string> {
    return this.manager.getEmbedUrlForSession();
  }

  handleToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    return this.toolHandler.handle(params);
  }

  handleSessionsResponse(threadId: string, response: RtermSessionsResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.threadId !== threadId) return;
    // Multiple chat clients can receive the same request. An iframe that is
    // loaded but not authenticated reports an empty result, so only a response
    // from an actually connected rterm client may win the request.
    if (response.connected !== true) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  disconnectAll(): void {
    this.manager.disconnectAll();
  }

  private requestSessionsFromRenderer(
    options: RemoteTerminalServiceOptions,
    threadId: string,
    request: RtermSessionsRequest,
  ): Promise<RtermSessionsResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve({
          requestId: request.requestId,
          ok: false,
          error: "Timed out waiting for a response from the rterm iframe.",
        });
      }, RTERM_REQUEST_TIMEOUT_MS);
      this.pending.set(request.requestId, { threadId, resolve, timer });
      if (!options.sendSessionsRequest(threadId, request)) {
        this.pending.delete(request.requestId);
        clearTimeout(timer);
        resolve({
          requestId: request.requestId,
          ok: false,
          error: "The rterm panel is unavailable.",
        });
      }
    });
  }
}
