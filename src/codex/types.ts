import type { RequestId } from "../codex-schema";
import type { Model, Project } from "../codex-schema/v2";
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

/** Incremental stream update for high-frequency output. */
export interface CodexStreamDelta {
  threadId?: string;
  itemId?: string;
  kind: "assistant" | "command";
  delta: string;
  completed?: boolean;
}

export interface CodexModelInfo {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface CodexModelPicker {
  stage: "model" | "effort";
  models: Model[];
  selectedModel?: Model;
}

/** Conversation state owned by one thread runtime. */
export interface CodexThreadSnapshot {
  projectId?: string | null;
  status: "idle" | "working" | "waiting";
  connected: boolean;
  messages: CodexMessage[];
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

export interface CodexConnectionSnapshot {
  status: "disconnected" | "connecting" | "ready";
  error?: string;
}
export interface CodexAccountSnapshot {
  rateLimits?: RateLimitSnapshot;
}
export interface CodexProjectsSnapshot {
  items: Project[];
}
export interface CodexThreadsSnapshot {
  items: Thread[];
  activities: CodexThreadActivity[];
  backgroundWork: { completed: number; total: number };
  selectedId?: string;
  current: {
    thread: CodexThreadSnapshot;
    readOnly: boolean;
    history: { loading: boolean; hasOlder: boolean };
  };
}
/** Component-owned snapshots published to application consumers. */
export interface CodexState {
  connection: CodexConnectionSnapshot;
  account: CodexAccountSnapshot;
  threads: CodexThreadsSnapshot;
  projects: CodexProjectsSnapshot;
  modelPicker?: CodexModelPicker;
}

export type ApprovalDecision = CommandExecutionApprovalDecision | FileChangeApprovalDecision;

export interface PendingApproval {
  requestId: RequestId;
  command: string;
  reason: string;
  decisions: Map<string, ApprovalDecision>;
}
