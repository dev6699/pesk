import type { JsonRpcResponse, LocalQueueListRequest, LocalQueueListResponse } from "./protocol";
import { CodexThreadManager } from "./thread-manager";

export interface QueueManagerOptions {
  request: (
    request: Omit<LocalQueueListRequest, "id">,
    callback: (message: JsonRpcResponse<LocalQueueListResponse>) => void,
  ) => boolean;
  threadManager: CodexThreadManager;
  publishRendererState: () => void;
}

/** Owns server queue synchronization for individual Codex threads. */
export class CodexQueueManager {
  constructor(private readonly options: QueueManagerOptions) {}

  /** Refreshes the complete queue for one thread, including all cursor pages. */
  refresh(threadId: string): void {
    this.loadPage(threadId, null, true);
  }

  private loadPage(threadId: string, cursor: string | null, replace: boolean): void {
    const accepted = this.options.request(
      {
        method: "thread/queue/list",
        params: cursor === null ? { threadId, limit: 100 } : { threadId, cursor, limit: 100 },
      },
      (message) => {
        this.options.threadManager.withThread(threadId, (thread) => {
          if (replace) thread.replaceQueueFromServer(message.result?.data ?? []);
          else thread.appendQueueFromServer(message.result?.data ?? []);
          this.options.publishRendererState();
          const nextCursor = message.result?.nextCursor;
          if (nextCursor) this.loadPage(threadId, nextCursor, false);
        });
      },
    );
    if (!accepted) return;
  }
}
