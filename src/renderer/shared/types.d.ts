interface SavedPeskSettings {
  animation: string;
  animationMode: "selected" | "shuffle";
  scale: number;
  paused: boolean;
  locked: boolean;
  visible: boolean;
  codexStatusSound: boolean;
}

interface CodexRuntimeState {
  codexStatusSoundUrl: string;
  codexStatus: "idle" | "working" | "waiting";
  codexAggregateStatus: "idle" | "working" | "waiting";
  codexConnected: boolean;
  codexThreadId?: string;
  codexReadOnly: boolean;
  codexCwd?: string;
  codexError?: string;
  codexCommandNotice?: string;
  codexThreads: Array<{ id: string; preview?: string; status?: unknown }>;
  codexThreadActivities: Array<{
    threadId: string;
    preview: string;
    status: "idle" | "working" | "waiting";
    workingSince?: number;
    attention?: "approval" | "userInput";
  }>;
  codexWorkingSince?: number;
  codexWorkedElapsed?: number;
  codexInterrupted?: boolean;
  codexTokenUsage?: {
    total: TokenCounts;
    last: TokenCounts;
    modelContextWindow: number | null;
  };
  codexModelInfo?: {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
  codexRateLimits?: {
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
  };
  codexCollaborationMode: "default" | "plan";
  codexPendingUserInput?: {
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
  };
  codexPendingApproval?: {
    requestId: string | number;
    command: string;
    reason: string;
    options: Array<{ id: string; label: string; description: string }>;
  };
  codexQueuedSubmissions: Array<{
    id: string;
    text: string;
    images?: Array<{ url: string; name?: string }>;
    clientUserMessageId: string;
  }>;
  codexHasOlderHistory: boolean;
  codexHistoryLoading: boolean;
  codexGoal?: {
    threadId: string;
    objective: string;
    status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
  };
  codexHistory: Array<{
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
  }>;
}

interface AnimationFrames {
  name: string;
  frames: string[];
  fps: number;
  size: number;
}

interface Window {
  peskApi: import("./api-types").PeskApi;
}

interface FuzzyFileSearchResult {
  root: string;
  path: string;
  match_type: "file" | "directory";
  file_name: string;
  score: number;
  indices: number[] | null;
}

type PeskSettings = SavedPeskSettings & CodexRuntimeState;

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
