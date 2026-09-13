import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import { RemoteTerminalToolHandler } from "./handler";
import { RemoteTerminalManager } from "./manager";
import { REMOTE_TERMINAL_TOOLS } from "./tools";
import type {
  ProviderSessionDescriptor,
  RtermProviderSession,
  RtermSnapshot,
} from "./rterm-client";

export interface RemoteTerminalServiceOptions {
  enabled: boolean;
  url: string;
  onChanged: (threadId: string, snapshot: RtermSnapshot) => void;
  onSessionSelected?: (threadId: string, sessionId: string) => void;
  requestApproval: (
    threadId: string,
    callId: string,
    command: string,
    reason: string,
  ) => Promise<boolean>;
}

/** Application-facing remote-terminal boundary; the manager and tool handler stay internal. */
export class RemoteTerminalService {
  private readonly manager: RemoteTerminalManager;
  private readonly toolHandler: RemoteTerminalToolHandler;

  constructor(options: RemoteTerminalServiceOptions) {
    this.manager = new RemoteTerminalManager(options);
    this.toolHandler = new RemoteTerminalToolHandler({
      getRterm: (threadId) => this.manager.getClient(threadId),
      onSessionSelected: options.onSessionSelected,
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

  getEmbedUrl(): string {
    return this.manager.getEmbedUrl();
  }

  setProviderSession(session: RtermProviderSession, threadId?: string): boolean {
    return this.manager.setProviderSession(session, threadId);
  }

  adoptProviderSession(
    session: ProviderSessionDescriptor,
    handoff: string,
    threadId?: string,
  ): Promise<boolean> {
    return this.manager.adoptProviderSession(session, handoff, threadId);
  }

  clearProviderSession(sessionId?: string): boolean {
    return this.manager.clearProviderSession(sessionId);
  }

  handleToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    return this.toolHandler.handle(params);
  }

  disconnectAll(): void {
    this.manager.disconnectAll();
  }
}
