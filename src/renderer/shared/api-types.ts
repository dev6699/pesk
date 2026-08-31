/// <reference path="./types.d.ts" />

export interface PeskApi {
  getSettings: () => Promise<PeskSettings>;
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
  implementCodexPlan: (planText: string, clearContext: boolean) => Promise<PeskSettings>;
  respondCodexUserInput: (requestId: string | number, answers: Record<string, string[]>) => void;
  interruptCodexTurn: () => Promise<boolean>;
  steerCodexTurn: (prompt: string) => Promise<PeskSettings>;
  selectAnimation: (name: string) => void;
  setAnimationMode: (mode: "selected" | "shuffle") => void;
  quitPesk: () => void;
  respondCodexPermission: (requestId: string | number, optionId: string) => void;
  submitCodexPrompt: (
    prompt: string,
    images?: Array<{ url: string; name: string }>,
  ) => Promise<PeskSettings>;
  startCodexReview: (instructions: string) => Promise<PeskSettings>;
  fuzzyFileSearch: (query: string, roots: string[]) => Promise<FuzzyFileSearchResult[]>;
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
}
