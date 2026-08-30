import type { RequestId } from "../codex-schema";
import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  RateLimitSnapshot,
  Thread,
  ThreadTokenUsage,
  ThreadGoal,
  ToolRequestUserInputParams,
} from "../codex-schema/v2";

export interface CodexMessage {
  role: "user" | "assistant" | "system";
  text: string;
  images?: Array<{ url: string; name?: string }>;
  timestamp?: number;
  temporary?: boolean;
  turnId?: string;
  itemId?: string;
  activity?: {
    kind: "command" | "fileChange" | "webSearch" | "tool" | "plan" | "other";
    source?: "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
    userInitiated?: boolean;
    label?: string;
    status?: string;
    command?: string;
    cwd?: string;
    summary?: string;
    output?: string;
    changes?: string[];
    details?: string;
  };
  approval?: {
    requestId: string | number;
    state: "pending" | "approved" | "denied";
    options?: Array<{ id: string; label: string; description: string }>;
  };
}

export interface CodexPendingUserInput {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputParams["questions"];
  isBlocking: boolean;
}

export interface CodexPendingApproval {
  requestId: string | number;
  command: string;
  reason: string;
  options: Array<{ id: string; label: string; description: string }>;
}

export interface CodexQueuedSubmission {
  id: string;
  text: string;
  images?: Array<{ url: string; name?: string }>;
  clientUserMessageId: string;
}

export interface CodexThreadActivity {
  threadId: string;
  preview: string;
  status: "idle" | "working" | "waiting";
  workingSince?: number;
  attention?: "approval" | "userInput";
}

export interface CodexModelInfo {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

/** Renderer-facing state owned by one thread runtime. */
export interface CodexThreadSnapshot {
  status: "idle" | "working" | "waiting";
  connected: boolean;
  history: CodexMessage[];
  workingDirectory?: string;
  workingSince?: number;
  workedElapsed?: number;
  interrupted: boolean;
  tokenUsage?: ThreadTokenUsage;
  modelInfo?: CodexModelInfo;
  collaborationMode: "default" | "plan";
  pendingUserInput?: CodexPendingUserInput;
  pendingApproval?: CodexPendingApproval;
  queuedSubmissions: CodexQueuedSubmission[];
  goal?: ThreadGoal;
  commandNotice?: string;
}

/** Complete state published by the Codex controller to renderer clients. */
export interface CodexState {
  threadId?: string;
  readOnly: boolean;
  cwd?: string;
  error?: string;
  status: "idle" | "working" | "waiting";
  aggregateStatus: "idle" | "working" | "waiting";
  connected: boolean;
  history: CodexMessage[];
  threads: Thread[];
  threadActivities: CodexThreadActivity[];
  workingSince?: number;
  workedElapsed?: number;
  interrupted?: boolean;
  tokenUsage?: ThreadTokenUsage;
  modelInfo?: CodexModelInfo;
  rateLimits?: RateLimitSnapshot;
  collaborationMode: "default" | "plan";
  pendingUserInput?: CodexPendingUserInput;
  pendingApproval?: CodexPendingApproval;
  queuedSubmissions: CodexQueuedSubmission[];
  goal?: ThreadGoal;
  commandNotice?: string;
}

export type ApprovalDecision = CommandExecutionApprovalDecision | FileChangeApprovalDecision;

export interface PendingApproval {
  requestId: RequestId;
  command: string;
  reason: string;
  decisions: Map<string, ApprovalDecision>;
}
