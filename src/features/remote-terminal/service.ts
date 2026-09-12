import type { DynamicToolCallParams, DynamicToolCallResponse } from "../../codex-schema/v2";
import { RemoteTerminalToolHandler } from "./handler";
import { RemoteTerminalManager } from "./manager";
import { REMOTE_TERMINAL_TOOLS } from "./tools";
import type { RtermSnapshot } from "./rterm-client";

export interface RemoteTerminalServiceOptions {
  enabled: boolean;
  url: string;
  onChanged: (threadId: string, snapshot: RtermSnapshot) => void;
  onOutput?: (threadId: string, data: string) => void;
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

  toggleConnection(): boolean {
    return this.manager.toggleConnection();
  }

  authenticate(code: string): boolean {
    return this.manager.authenticate(code);
  }

  write(input: string): boolean {
    return this.manager.write(input);
  }

  resize(cols: number, rows: number): boolean {
    return this.manager.resize(cols, rows);
  }

  handleToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    return this.toolHandler.handle(params);
  }

  disconnectAll(): void {
    this.manager.disconnectAll();
  }
}
