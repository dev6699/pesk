/// <reference path="./renderer/shared/types.d.ts" />

import { contextBridge, ipcRenderer } from "electron";
import type { IpcEventContract, IpcInvokeContract, RendererEventContract } from "./app/ipc-contract";
import type { PeskApi } from "./renderer/shared/api-types";

function invoke<K extends keyof IpcInvokeContract>(
  channel: K,
  ...args: IpcInvokeContract[K]["args"]
): Promise<IpcInvokeContract[K]["result"]> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcInvokeContract[K]["result"]>;
}

function send<K extends keyof IpcEventContract>(channel: K, ...args: IpcEventContract[K]): void {
  ipcRenderer.send(channel, ...args);
}

function sendChannel<K extends keyof IpcEventContract>(
  channel: K,
): (...args: IpcEventContract[K]) => void {
  return (...args) => send(channel, ...args);
}

function invokeChannel<K extends keyof IpcInvokeContract>(
  channel: K,
): (...args: IpcInvokeContract[K]["args"]) => Promise<IpcInvokeContract[K]["result"]> {
  return (...args) => invoke(channel, ...args);
}

function listenChannel<K extends keyof RendererEventContract>(
  channel: K,
): (callback: (...args: RendererEventContract[K]) => void) => void {
  return (callback) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...(args as RendererEventContract[K])));
  };
}

const api: PeskApi = {
  getSettings: invokeChannel("get-settings"),
  refreshCodexRateLimits: sendChannel("refresh-codex-rate-limits"),
  getAnimations: invokeChannel("get-animations"),
  getChatSize: invokeChannel("get-chat-size"),
  movePet: sendChannel("move-pet"),
  startDrag: sendChannel("drag-start"),
  endDrag: sendChannel("drag-end"),
  focusPet: sendChannel("focus-pet"),
  unfocusPesk: sendChannel("unfocus-pesk"),
  zoomPet: sendChannel("zoom-pet"),
  showPetMenu: sendChannel("show-pet-menu"),
  togglePaused: sendChannel("toggle-paused"),
  toggleLocked: sendChannel("toggle-locked"),
  togglePetVisibility: sendChannel("toggle-pet-visibility"),
  createPairing: invokeChannel("create-pairing"),
  getPairingStatus: invokeChannel("get-pairing-status"),
  getPairingDevices: invokeChannel("get-pairing-devices"),
  revokePairingDevice: invokeChannel("revoke-pairing-device"),
  setPairingDevicePush: invokeChannel("set-pairing-device-push"),
  toggleCodexStatusSound: sendChannel("toggle-codex-status-sound"),
  openConfigFolder: sendChannel("open-config-folder"),
  selectCodexThread: sendChannel("select-codex-thread"),
  loadOlderCodexHistory: invokeChannel("load-older-codex-history"),
  setCodexCollaborationMode: sendChannel("set-codex-collaboration-mode"),
  focusCodexInput: sendChannel("focus-codex-input"),
  setChatFileDialogOpen: sendChannel("chat-file-dialog"),
  implementCodexPlan: invokeChannel("implement-codex-plan"),
  respondCodexUserInput: sendChannel("respond-codex-user-input"),
  interruptCodexTurn: invokeChannel("interrupt-codex-turn"),
  steerCodexTurn: invokeChannel("steer-codex-turn"),
  selectAnimation: sendChannel("select-animation"),
  setAnimationMode: sendChannel("set-animation-mode"),
  quitPesk: sendChannel("quit-pesk"),
  respondCodexPermission: sendChannel("respond-codex-permission"),
  submitCodexPrompt: invokeChannel("submit-codex-prompt"),
  startCodexReview: invokeChannel("start-codex-review"),
  fuzzyFileSearch: invokeChannel("fuzzy-file-search"),
  getPresets: invokeChannel("get-presets"),
  runPreset: sendChannel("run-preset"),
  closeMenuWindow: sendChannel("close-menu-window"),
  onMenuUpdated: listenChannel("menu-updated"),
  onMenuFocusChanged: listenChannel("menu-focus-changed"),
  onPetFocusChanged: listenChannel("pet-focus-changed"),
  onPetCodexUpdateChanged: listenChannel("pet-codex-update-changed"),
  onPetCodexStatusSound: listenChannel("pet-codex-status-sound"),
  onCodexInputFocus: listenChannel("codex-input-focus"),
  onCodexUserInputFocus: listenChannel("codex-user-input-focus"),
  onSettingsChanged: listenChannel("settings-changed"),
} satisfies Window["peskApi"];

contextBridge.exposeInMainWorld("peskApi", api);
