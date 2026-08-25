interface PetSettings {
  animation: string;
  animationMode: "selected" | "shuffle";
  scale: number;
  paused: boolean;
  locked: boolean;
  visible: boolean;
  codexStatus: "idle" | "working" | "waiting";
  codexConnected: boolean;
  codexThreadId?: string;
  codexError?: string;
  codexThreads: Array<{ id: string; preview?: string; status?: string }>;
  codexActivity: Record<string, unknown> | null;
  codexWorkingSince?: number;
  codexWorkedElapsed?: number;
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
    getSettings: () => Promise<PetSettings>;
    getAnimations: () => Promise<AnimationFrames[]>;
    getChatSize: () => Promise<{ width: number; height: number }>;
    movePet: (dx: number, dy: number) => void;
    startDrag: () => void;
    endDrag: () => void;
    zoomPet: (scale: number) => void;
    showPetMenu: () => void;
    togglePaused: () => void;
    toggleLocked: () => void;
    togglePetVisibility: () => void;
    openConfigFolder: () => void;
    selectCodexThread: (threadId: string) => void;
    selectAnimation: (name: string) => void;
    setAnimationMode: (mode: "selected" | "shuffle") => void;
    quitPesk: () => void;
    respondCodexPermission: (
      requestId: string | number,
      decision: "allow" | "deny",
    ) => void;
    submitCodexPrompt: (prompt: string) => Promise<PetSettings>;
    getPresets: () => Promise<{ name: string }[]>;
    runPreset: (name: string) => void;
    closeMenuWindow: () => void;
    onMenuUpdated: (callback: () => void) => void;
    onMenuFocusChanged: (callback: (focused: boolean) => void) => void;
    onPetFocusChanged: (callback: (focused: boolean) => void) => void;
    onPetCodexUpdateChanged: (callback: (active: boolean) => void) => void;
    onCodexInputFocus: (callback: () => void) => void;
    onSettingsChanged: (callback: (settings: PetSettings) => void) => void;
  };
}
