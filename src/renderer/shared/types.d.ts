interface SavedPeskSettings {
  animation: string;
  animationMode: "selected" | "shuffle";
  scale: number;
  paused: boolean;
  locked: boolean;
  visible: boolean;
  codexStatusSound: boolean;
}

interface AnimationFrames {
  name: string;
  frames: string[];
  fps: number;
  size: number;
}

interface FuzzyFileSearchResult {
  root: string;
  path: string;
  match_type: "file" | "directory";
  file_name: string;
  score: number;
  indices: number[] | null;
}

interface CodexHistoryItem {
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

interface CodexThreadActivity {
  threadId: string;
  preview: string;
  status: "idle" | "working" | "waiting";
  workingSince?: number;
  attention?: "approval" | "userInput";
}

interface CodexStreamDelta {
  threadId?: string;
  itemId?: string;
  kind: "assistant" | "command";
  delta: string;
}

interface TokenCounts {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}

interface CodexTokenUsage {
  total: TokenCounts;
  last: TokenCounts;
  modelContextWindow: number | null;
}

interface CodexModelInfo {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface CodexRateLimits {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

interface CodexPendingUserInput {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
  isBlocking: boolean;
}

interface CodexPendingApproval {
  requestId: string | number;
  command: string;
  reason: string;
  options: Array<{ id: string; label: string; description: string }>;
}

interface CodexQueuedSubmission {
  id: string;
  text: string;
  images?: Array<{ url: string; name?: string }>;
  clientUserMessageId: string;
}

interface CodexGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

interface CodexRuntimeState {
  threadId?: string;
  readOnly: boolean;
  cwd?: string;
  error?: string;
  status: "idle" | "working" | "waiting";
  aggregateStatus: "idle" | "working" | "waiting";
  connected: boolean;
  history: CodexHistoryItem[];
  threads: Array<{ id: string; preview?: string; status?: unknown }>;
  threadActivities: CodexThreadActivity[];
  workingSince?: number;
  workedElapsed?: number;
  interrupted?: boolean;
  tokenUsage?: CodexTokenUsage;
  modelInfo?: CodexModelInfo;
  rateLimits?: CodexRateLimits;
  collaborationMode: "default" | "plan";
  pendingUserInput?: CodexPendingUserInput;
  pendingApproval?: CodexPendingApproval;
  queuedSubmissions: CodexQueuedSubmission[];
  goal?: CodexGoal;
  commandNotice?: string;
  hasOlderHistory: boolean;
  historyLoading: boolean;
}

interface RendererAssets {
  codexStatusSoundUrl: string;
}

interface RendererState {
  settings: SavedPeskSettings;
  codex: CodexRuntimeState;
  assets: RendererAssets;
}

interface Window {
  peskApi: import("./api-types").PeskApi;
}
