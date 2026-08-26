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
  codexConnected: boolean;
  codexThreadId?: string;
  codexCwd?: string;
  codexError?: string;
  codexThreads: Array<{ id: string; preview?: string; status?: string }>;
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
  codexHistory: Array<{
    role: "user" | "assistant" | "system";
    text: string;
    timestamp?: number;
    temporary?: boolean;
    turnId?: string;
    itemId?: string;
    activity?: {
      kind: "command" | "fileChange" | "webSearch" | "tool" | "other";
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
    toggleCodexStatusSound: () => void;
    openConfigFolder: () => void;
    selectCodexThread: (threadId: string) => void;
    interruptCodexTurn: () => Promise<boolean>;
    selectAnimation: (name: string) => void;
    setAnimationMode: (mode: "selected" | "shuffle") => void;
    quitPesk: () => void;
    respondCodexPermission: (
      requestId: string | number,
      decision: "allow" | "deny",
    ) => void;
    submitCodexPrompt: (prompt: string) => Promise<PeskSettings>;
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
    onCodexInputFocus: (callback: () => void) => void;
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
