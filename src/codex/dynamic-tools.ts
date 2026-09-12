import type { RequestId } from "../codex-schema";
import { requestIdKey } from "./protocol";
import { CodexThreadManager } from "./thread-manager";

interface PendingDynamicApproval {
  threadId: string;
  resolve: (approved: boolean) => void;
}

export interface DynamicApprovalDependencies {
  threadManager: CodexThreadManager;
  notifyStateChanged: () => void;
  onAttentionCleared?: () => void;
}

/** Owns Pesk-local approval state for dynamic tool calls. */
export class DynamicToolApprovalManager {
  private readonly pending = new Map<string, PendingDynamicApproval>();

  constructor(private readonly dependencies: DynamicApprovalDependencies) {}

  /** Resolves a local approval response, returning false when it belongs to the app server. */
  respond(requestId: RequestId, optionId: string): boolean {
    const key = requestIdKey(requestId);
    const approval = this.pending.get(key);
    if (!approval) return false;
    this.pending.delete(key);
    this.dependencies.threadManager.withThread(approval.threadId, (thread) => {
      thread.clearLocalApproval(requestId);
      this.dependencies.threadManager.clearAttention(approval.threadId);
    });
    this.dependencies.notifyStateChanged();
    this.dependencies.onAttentionCleared?.();
    approval.resolve(optionId === "approve");
    return true;
  }

  /** Blocks a dynamic tool call behind Pesk's normal approval renderer. */
  request(threadId: string, callId: string, command: string, reason: string): Promise<boolean> {
    const requestId = `dynamic:${callId}`;
    return new Promise((resolve) => {
      this.pending.set(requestIdKey(requestId), { threadId, resolve });
      this.dependencies.threadManager.withThread(threadId, (thread) => {
        thread.setLocalApproval({
          requestId,
          command,
          reason,
          options: [
            { id: "approve", label: "Approve", description: "Run this command remotely." },
            { id: "reject", label: "Reject", description: "Do not run this command." },
          ],
        });
        this.dependencies.threadManager.noteAttention(threadId, "approval");
      });
      this.dependencies.notifyStateChanged();
    });
  }
}
