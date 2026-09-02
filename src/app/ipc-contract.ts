import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { ChatSize } from "../windows/chat";
import type { PairingDevice, PairingInfo, PairingStatus } from "../services/chat-web-server";
import type { AnimationFrames } from "../windows/pet";
import type { FuzzyFileSearchResult } from "../codex-schema/FuzzyFileSearchResult";
import type { ImageInput, RequestId } from "./validation";
import type { CodexStreamDelta } from "../codex/types";
import type { RendererState } from "./renderer-state";

export interface RendererEventContract {
  "menu-updated": [];
  "menu-focus-changed": [focused: boolean];
  "pet-focus-changed": [focused: boolean];
  "pet-codex-update-changed": [active: boolean];
  "pet-codex-status-sound": [];
  "codex-input-focus": [];
  "codex-user-input-focus": [];
  "settings-changed": [state: RendererState];
  "codex-stream-delta": [delta: CodexStreamDelta];
}

export interface PresetInfo {
  name: string;
}

export interface IpcInvokeContract {
  "get-settings": { args: []; result: RendererState };
  "get-animations": { args: []; result: AnimationFrames[] };
  "get-chat-size": { args: []; result: ChatSize };
  "get-presets": { args: []; result: PresetInfo[] };
  "create-pairing": { args: [name: string]; result: PairingInfo | undefined };
  "get-pairing-status": { args: []; result: PairingStatus };
  "get-pairing-devices": { args: []; result: PairingDevice[] };
  "revoke-pairing-device": { args: [id: string]; result: void };
  "set-pairing-device-push": { args: [id: string, enabled: boolean]; result: void };
  "submit-codex-prompt": { args: [prompt: string, images?: ImageInput[]]; result: RendererState };
  "start-codex-review": { args: [instructions: string]; result: RendererState };
  "implement-codex-plan": {
    args: [planText: string, clearContext: boolean];
    result: RendererState;
  };
  "interrupt-codex-turn": { args: []; result: boolean };
  "steer-codex-turn": { args: [prompt: string]; result: RendererState };
  "load-older-codex-history": { args: []; result: boolean };
  "fuzzy-file-search": { args: [query: string, roots: string[]]; result: FuzzyFileSearchResult[] };
  "list-codex-projects": { args: []; result: RendererState };
  "read-codex-project": { args: [id: string]; result: RendererState };
  "create-codex-project": {
    args: [name: string, root: string, idempotencyKey?: string];
    result: RendererState;
  };
  "import-codex-project": {
    args: [name: string, roots: string[], threadIds: string[], idempotencyKey?: string];
    result: RendererState;
  };
  "update-codex-project": {
    args: [
      id: string,
      changes: { name?: string; roots?: string[]; metadata?: Record<string, string> },
    ];
    result: RendererState;
  };
  "move-codex-project": { args: [id: string, beforeId: string | null]; result: RendererState };
  "delete-codex-project": { args: [id: string]; result: RendererState };
  "choose-codex-project-root": { args: []; result: string | undefined };
}

export interface IpcEventContract {
  "refresh-codex-rate-limits": [];
  "open-config-folder": [];
  "toggle-paused": [];
  "toggle-locked": [];
  "toggle-pet-visibility": [];
  "toggle-codex-status-sound": [];
  "select-animation": [name: string];
  "set-animation-mode": [mode: "selected" | "shuffle"];
  "move-pet": [dx: number, dy: number];
  "zoom-pet": [scale: number];
  "drag-start": [];
  "drag-end": [];
  "focus-pet": [];
  "unfocus-pesk": [];
  "focus-codex-input": [];
  "chat-file-dialog": [open: boolean];
  "select-codex-thread": [id: string];
  "set-codex-collaboration-mode": [mode: "default" | "plan"];
  "respond-codex-user-input": [requestId: RequestId, answers: Record<string, string[]>];
  "respond-codex-permission": [requestId: RequestId, decision: string];
  "run-preset": [name: string];
  "show-pet-menu": [];
  "close-menu-window": [];
  "quit-pesk": [];
}

export function registerInvoke<K extends keyof IpcInvokeContract>(
  channel: K,
  handler: (event: IpcMainInvokeEvent, ...args: IpcInvokeContract[K]["args"]) => unknown,
): void {
  ipcMain.handle(channel, handler);
}

export function registerEvent<K extends keyof IpcEventContract>(
  channel: K,
  handler: (event: IpcMainEvent, ...args: IpcEventContract[K]) => void,
): void {
  ipcMain.on(channel, handler);
}
