import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("peskApi", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  refreshCodexRateLimits: () => ipcRenderer.invoke("refresh-codex-rate-limits"),
  getAnimations: () => ipcRenderer.invoke("get-animations"),
  getChatSize: () => ipcRenderer.invoke("get-chat-size"),
  movePet: (dx: number, dy: number) => ipcRenderer.send("move-pet", dx, dy),
  startDrag: () => ipcRenderer.send("drag-start"),
  endDrag: () => ipcRenderer.send("drag-end"),
  focusPet: () => ipcRenderer.send("focus-pet"),
  zoomPet: (scale: number) => ipcRenderer.send("zoom-pet", scale),
  showPetMenu: () => ipcRenderer.send("show-pet-menu"),
  togglePaused: () => ipcRenderer.send("toggle-paused"),
  toggleLocked: () => ipcRenderer.send("toggle-locked"),
  togglePetVisibility: () => ipcRenderer.send("toggle-pet-visibility"),
  createPairing: (name: string) => ipcRenderer.invoke("create-pairing", name),
  getPairingStatus: () => ipcRenderer.invoke("get-pairing-status"),
  getPairingDevices: () => ipcRenderer.invoke("get-pairing-devices"),
  revokePairingDevice: (id: string) => ipcRenderer.invoke("revoke-pairing-device", id),
  setPairingDevicePush: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("set-pairing-device-push", id, enabled),
  toggleCodexStatusSound: () => ipcRenderer.send("toggle-codex-status-sound"),
  openConfigFolder: () => ipcRenderer.send("open-config-folder"),
  selectCodexThread: (threadId: string) =>
    ipcRenderer.send("select-codex-thread", threadId),
  setCodexCollaborationMode: (mode: "default" | "plan") =>
    ipcRenderer.send("set-codex-collaboration-mode", mode),
  focusCodexInput: () => ipcRenderer.send("focus-codex-input"),
  implementCodexPlan: (planText: string, clearContext: boolean) =>
    ipcRenderer.invoke("implement-codex-plan", planText, clearContext),
  respondCodexUserInput: (
    requestId: string | number,
    answers: Record<string, string[]>,
  ) => ipcRenderer.send("respond-codex-user-input", requestId, answers),
  interruptCodexTurn: () => ipcRenderer.invoke("interrupt-codex-turn"),
  selectAnimation: (name: string) => ipcRenderer.send("select-animation", name),
  setAnimationMode: (mode: "selected" | "shuffle") =>
    ipcRenderer.send("set-animation-mode", mode),
  quitPesk: () => ipcRenderer.send("quit-pesk"),
  respondCodexPermission: (
    requestId: string | number,
    optionId: string,
  ) => ipcRenderer.send("respond-codex-permission", requestId, optionId),
  submitCodexPrompt: (prompt: string) =>
    ipcRenderer.invoke("submit-codex-prompt", prompt),
  fuzzyFileSearch: (query: string, roots: string[]) =>
    ipcRenderer.invoke("fuzzy-file-search", query, roots),
  getPresets: () => ipcRenderer.invoke("get-presets"),
  runPreset: (name: string) => ipcRenderer.send("run-preset", name),
  closeMenuWindow: () => ipcRenderer.send("close-menu-window"),
  onMenuUpdated: (callback: () => void) => {
    ipcRenderer.on("menu-updated", () => callback());
  },
  onMenuFocusChanged: (callback: (focused: boolean) => void) => {
    ipcRenderer.on("menu-focus-changed", (_event, focused: boolean) =>
      callback(focused),
    );
  },
  onPetFocusChanged: (callback: (focused: boolean) => void) => {
    ipcRenderer.on("pet-focus-changed", (_event, focused: boolean) =>
      callback(focused),
    );
  },
  onPetCodexUpdateChanged: (callback: (active: boolean) => void) => {
    ipcRenderer.on("pet-codex-update-changed", (_event, active: boolean) =>
      callback(active),
    );
  },
  onCodexInputFocus: (callback: () => void) => {
    ipcRenderer.on("codex-input-focus", () => callback());
  },
  onCodexUserInputFocus: (callback: () => void) => {
    ipcRenderer.on("codex-user-input-focus", () => callback());
  },
  onSettingsChanged: (callback: (settings: unknown) => void) => {
    ipcRenderer.on("settings-changed", (_event, settings) =>
      callback(settings),
    );
  },
});
