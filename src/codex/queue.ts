import type {
  JsonRpcResponse,
  LocalQueueDeleteRequest,
  LocalQueueDeleteResponse,
  LocalQueueListRequest,
  LocalQueueListResponse,
  OutgoingRequestInput,
} from "./protocol";
import { CodexThreadManager } from "./thread-manager";

export interface QueueManagerOptions {
  request: (
    request: OutgoingRequestInput,
    callback: (message: JsonRpcResponse<unknown>) => void,
  ) => boolean;
  threadManager: CodexThreadManager;
  onStateChanged: () => void;
}

/** Owns server queue synchronization for individual Codex threads. */
export class CodexQueueManager {
  constructor(private readonly options: QueueManagerOptions) {}

  /** Refreshes the complete queue for one thread, including all cursor pages. */
  refresh(threadId: string): void {
    this.loadPage(threadId, null, true);
  }

  /** Deletes one server-backed queued submission and refreshes the queue. */
  delete(threadId: string, queuedSubmissionId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const accepted = this.options.request(
        {
          method: "thread/queue/delete",
          params: { threadId, queuedSubmissionId },
        },
        (message) => {
          const deleted =
            (message.result as LocalQueueDeleteResponse | undefined)?.deleted === true;
          if (deleted) this.refresh(threadId);
          resolve(deleted);
        },
      );
      if (!accepted) resolve(false);
    });
  }

  private loadPage(threadId: string, cursor: string | null, replace: boolean): void {
    const accepted = this.options.request(
      {
        method: "thread/queue/list",
        params: cursor === null ? { threadId, limit: 100 } : { threadId, cursor, limit: 100 },
      },
      (message) => {
        const result = message as JsonRpcResponse<LocalQueueListResponse>;
        this.options.threadManager.withThread(threadId, (thread) => {
          if (replace) thread.replaceQueueFromServer(result.result?.data ?? []);
          else thread.appendQueueFromServer(result.result?.data ?? []);
          this.options.onStateChanged();
          const nextCursor = result.result?.nextCursor;
          if (nextCursor) this.loadPage(threadId, nextCursor, false);
        });
      },
    );
    if (!accepted) return;
  }
}
