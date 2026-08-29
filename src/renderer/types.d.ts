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
  codexThreads: Array<{ id: string; preview?: string; status?: string }>;
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
      source?:
        "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
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
  speed: number;
  size: number;
}

interface Window {
  peskApi: {
    getSettings: () => Promise<PeskSettings>;
    refreshCodexRateLimits: () => Promise<void>;
    getAnimations: () => Promise<AnimationFrames[]>;
    getChatSize: () => Promise<{ width: number; height: number }>;
    movePet: (dx: number, dy: number) => void;
    startDrag: () => void;
    endDrag: () => void;
    focusPet: () => void;
    zoomPet: (scale: number) => void;
    showPetMenu: () => void;
    togglePaused: () => void;
    toggleLocked: () => void;
    togglePetVisibility: () => void;
    createPairing: (
      name: string,
    ) => Promise<
      { expiresAt: number; qrDataUrl: string; deviceName: string } | undefined
    >;
    getPairingStatus: () => Promise<{
      active: boolean;
      pairedDeviceName?: string;
    }>;
    getPairingDevices: () => Promise<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        lastUsedAt: number | null;
        pushEnabled: boolean;
        pushRegistered: boolean;
      }>
    >;
    revokePairingDevice: (id: string) => Promise<void>;
    setPairingDevicePush: (id: string, enabled: boolean) => Promise<void>;
    toggleCodexStatusSound: () => void;
    openConfigFolder: () => void;
    selectCodexThread: (threadId: string) => void;
    setCodexCollaborationMode: (mode: "default" | "plan") => void;
    focusCodexInput: () => void;
    setChatFileDialogOpen: (open: boolean) => void;
    implementCodexPlan: (
      planText: string,
      clearContext: boolean,
    ) => Promise<PeskSettings>;
    respondCodexUserInput: (
      requestId: string | number,
      answers: Record<string, string[]>,
    ) => void;
    interruptCodexTurn: () => Promise<boolean>;
    steerCodexTurn: (prompt: string) => Promise<PeskSettings>;
    selectAnimation: (name: string) => void;
    setAnimationMode: (mode: "selected" | "shuffle") => void;
    quitPesk: () => void;
    respondCodexPermission: (
      requestId: string | number,
      optionId: string,
    ) => void;
    submitCodexPrompt: (
      prompt: string,
      images?: Array<{ url: string; name: string }>,
    ) => Promise<PeskSettings>;
    startCodexReview: (instructions: string) => Promise<PeskSettings>;
    fuzzyFileSearch: (
      query: string,
      roots: string[],
    ) => Promise<FuzzyFileSearchResult[]>;
    getPresets: () => Promise<{ name: string }[]>;
    runPreset: (name: string) => void;
    closeMenuWindow: () => void;
    onMenuUpdated: (callback: () => void) => void;
    onMenuFocusChanged: (callback: (focused: boolean) => void) => void;
    onPetFocusChanged: (callback: (focused: boolean) => void) => void;
    onPetCodexUpdateChanged: (callback: (active: boolean) => void) => void;
    onPetCodexStatusSound: (callback: () => void) => void;
    onCodexInputFocus: (callback: () => void) => void;
    onCodexUserInputFocus: (callback: () => void) => void;
    onSettingsChanged: (callback: (settings: PeskSettings) => void) => void;
  };
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
