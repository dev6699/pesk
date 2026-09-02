/// <reference path="./types.d.ts" />

export interface PeskApi {
  getSettings: () => Promise<RendererState>;
  refreshCodexRateLimits: () => void;
  getAnimations: () => Promise<AnimationFrames[]>;
  getChatSize: () => Promise<{ width: number; height: number }>;
  movePet: (dx: number, dy: number) => void;
  startDrag: () => void;
  endDrag: () => void;
  focusPet: () => void;
  unfocusPesk: () => void;
  zoomPet: (scale: number) => void;
  showPetMenu: () => void;
  togglePaused: () => void;
  toggleLocked: () => void;
  togglePetVisibility: () => void;
  createPairing: (
    name: string,
  ) => Promise<{ expiresAt: number; qrDataUrl: string; deviceName: string } | undefined>;
  getPairingStatus: () => Promise<{ active: boolean; pairedDeviceName?: string }>;
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
  loadOlderCodexHistory: () => Promise<boolean>;
  setCodexCollaborationMode: (mode: "default" | "plan") => void;
  focusCodexInput: () => void;
  setChatFileDialogOpen: (open: boolean) => void;
  implementCodexPlan: (planText: string, clearContext: boolean) => Promise<RendererState>;
  respondCodexUserInput: (requestId: string | number, answers: Record<string, string[]>) => void;
  interruptCodexTurn: () => Promise<boolean>;
  steerCodexTurn: (prompt: string) => Promise<RendererState>;
  selectAnimation: (name: string) => void;
  setAnimationMode: (mode: "selected" | "shuffle") => void;
  quitPesk: () => void;
  respondCodexPermission: (requestId: string | number, optionId: string) => void;
  submitCodexPrompt: (
    prompt: string,
    images?: Array<{ url: string; name: string }>,
  ) => Promise<RendererState>;
  startCodexProjectThread: (projectId: string, cwd: string) => Promise<RendererState>;
  startCodexReview: (instructions: string) => Promise<RendererState>;
  fuzzyFileSearch: (query: string, roots: string[]) => Promise<FuzzyFileSearchResult[]>;
  listCodexProjects: () => Promise<RendererState>;
  readCodexProject: (id: string) => Promise<RendererState>;
  createCodexProject: (
    name: string,
    root: string,
    idempotencyKey?: string,
  ) => Promise<RendererState>;
  importCodexProject: (
    name: string,
    roots: string[],
    threadIds: string[],
    idempotencyKey?: string,
  ) => Promise<RendererState>;
  updateCodexProject: (
    id: string,
    changes: { name?: string; roots?: string[]; metadata?: Record<string, string> },
  ) => Promise<RendererState>;
  moveCodexProject: (id: string, beforeId: string | null) => Promise<RendererState>;
  deleteCodexProject: (id: string) => Promise<RendererState>;
  chooseCodexProjectRoot: () => Promise<string | undefined>;
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
  onSettingsChanged: (callback: (state: RendererState) => void) => void;
  onCodexStreamDelta: (callback: (delta: CodexStreamDelta) => void) => void;
}
