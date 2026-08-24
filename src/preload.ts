import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("petApi", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getAnimations: () => ipcRenderer.invoke("get-animations"),
  getChatSize: () => ipcRenderer.invoke("get-chat-size"),
  movePet: (dx: number, dy: number) => ipcRenderer.send("move-pet", dx, dy),
  startDrag: () => ipcRenderer.send("drag-start"),
  endDrag: () => ipcRenderer.send("drag-end"),
  zoomPet: (scale: number) => ipcRenderer.send("zoom-pet", scale),
  showPetMenu: () => ipcRenderer.send("show-pet-menu"),
  togglePaused: () => ipcRenderer.send("toggle-paused"),
  toggleWandering: () => ipcRenderer.send("toggle-wandering"),
  toggleLocked: () => ipcRenderer.send("toggle-locked"),
  togglePetVisibility: () => ipcRenderer.send("toggle-pet-visibility"),
  openConfigFolder: () => ipcRenderer.send("open-config-folder"),
  toggleCodexChat: () => ipcRenderer.send("toggle-codex-chat"),
  selectCodexThread: (threadId: string) => ipcRenderer.send("select-codex-thread", threadId),
  selectAnimation: (name: string) => ipcRenderer.send("select-animation", name),
  setAnimationMode: (mode: "selected" | "shuffle") => ipcRenderer.send("set-animation-mode", mode),
  quitPesk: () => ipcRenderer.send("quit-pesk"),
  respondCodexPermission: (requestId: string | number, decision: "allow" | "deny") =>
    ipcRenderer.send("respond-codex-permission", requestId, decision),
  submitCodexPrompt: (prompt: string) => ipcRenderer.invoke("submit-codex-prompt", prompt),
  getPresets: () => ipcRenderer.invoke("get-presets"),
  runPreset: (name: string) => ipcRenderer.send("run-preset", name),
  closeMenuWindow: () => ipcRenderer.send("close-menu-window"),
  onMenuUpdated: (callback: () => void) => {
    ipcRenderer.on("menu-updated", () => callback());
  },
  onMenuFocusChanged: (callback: (focused: boolean) => void) => {
    ipcRenderer.on("menu-focus-changed", (_event, focused: boolean) => callback(focused));
  },
  onPetFocusChanged: (callback: (focused: boolean) => void) => {
    ipcRenderer.on("pet-focus-changed", (_event, focused: boolean) => callback(focused));
  },
  onCodexChatVisibility: (callback: (visible: boolean) => void) => {
    ipcRenderer.on("codex-chat-visibility", (_event, visible: boolean) => callback(visible));
  },
  onCodexInputFocus: (callback: () => void) => {
    ipcRenderer.on("codex-input-focus", () => callback());
  },
  onSettingsChanged: (callback: (settings: unknown) => void) => {
    ipcRenderer.on("settings-changed", (_event, settings) => callback(settings));
  },
});
