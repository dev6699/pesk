import { app, globalShortcut, ipcMain, shell } from "electron";
import { CodexController } from "./codex";
import type { CodexMessage, CodexThreadSummary } from "./codex";
import { ChatWindowController } from "./chat";
import { PetWindowController } from "./pet";
import { loadConfig, loadSettings, saveSettings } from "./config";
import type { PeskSettings } from "./config";
import { PresetController } from "./preset";
import { MenuController } from "./menu";

interface RendererSettings extends PeskSettings {
  codexThreadId?: string;
  codexError?: string;
  codexStatus: "idle" | "working" | "waiting";
  codexConnected: boolean;
  codexActivity: Record<string, unknown> | null;
  codexWorkingSince?: number;
  codexWorkedElapsed?: number;
  codexHistory: CodexMessage[];
  codexThreads: CodexThreadSummary[];
}

let settings: PeskSettings;
let codexController: CodexController;
let chat: ChatWindowController;
let pet: PetWindowController;
let presets: PresetController;
let menu: MenuController;

const debug = (...values: unknown[]): void => {
  if (!app.isPackaged) console.log("[pesk]", ...values);
};

function persistSettings(): void {
  saveSettings(settings);
}

function configureAutoStart(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
  });
}

function rendererSettings(): RendererSettings {
  const state = codexController.getState();
  return {
    ...settings,
    codexThreadId: state.threadId,
    codexError: state.error,
    codexStatus: state.status,
    codexConnected: state.connected,
    codexActivity: state.activity,
    codexHistory: state.history,
    codexThreads: state.threads,
    codexWorkingSince: state.workingSince,
    codexWorkedElapsed: state.workedElapsed,
  };
}

function sendSettings(): void {
  pet.window?.webContents.send("settings-changed", rendererSettings());
  chat.window?.webContents.send("settings-changed", rendererSettings());
}

app.whenReady().then(() => {
  configureAutoStart();
  settings = loadSettings();
  const config = loadConfig();
  presets = new PresetController(debug);
  pet = new PetWindowController({
    getSettings: () => settings,
    saveSettings: persistSettings,
    sendSettings,
    refreshTrayMenu: () => menu.refreshTrayMenu(),
    positionChat: () => chat.position(),
    showChat: () => chat.showForPetFocus(),
    hideChat: () => {
      chat.hideIfNotFocused();
      pet.setFocusIndicator(
        (pet.window?.isFocused() ?? false) ||
          (chat.window?.isFocused() ?? false),
      );
    },
    hideMenu: () => menu.hide(),
    focusChat: () => {
      chat.create();
      chat.position();
      chat.window?.show();
      chat.window?.focus();
      chat.window?.webContents.focus();
      chat.window?.webContents.send("codex-input-focus");
    },
    isChatFocused: () => chat.window?.isFocused() ?? false,
  });
  chat = new ChatWindowController({
    getPetWindow: () => pet.window,
    keepPetAbove: () => pet.window?.moveTop(),
    setPetFocus: (focused) => pet.setFocusIndicator(focused),
    setCodexUpdateIndicator: (active) => pet.setCodexUpdateIndicator(active),
  });
  menu = new MenuController({
    getSettings: () => settings,
    getPetWindow: () => pet.window,
    togglePaused: () => pet.togglePaused(),
    toggleLocked: () => pet.toggleLocked(),
    togglePetVisibility: () => pet.toggleVisibility(),
    showPet: () => pet.show(),
  });
  codexController = new CodexController({
    sendSettings,
    showPetForUpdate: () => {
      settings.visible = true;
      chat.showForCodexUpdate();
    },
    showApproval: () => chat.showForApproval(),
    debug,
  });
  codexController.setSocketUrl(config.codexAppServerUrl);
  const configuredAnimations = pet.getAnimations();
  if (
    !configuredAnimations.some(
      (animation) => animation.name === settings.animation,
    )
  ) {
    settings.animation =
      configuredAnimations.find(
        (animation) => animation.name.toLowerCase() === "idle",
      )?.name ??
      configuredAnimations[0]?.name ??
      "idle";
    persistSettings();
  }
  ipcMain.handle("get-settings", () => rendererSettings());
  ipcMain.handle("get-animations", () => pet.getAnimations());
  ipcMain.handle("get-chat-size", () => chat.getSize());
  ipcMain.handle("get-presets", () => presets.getPresets());
  ipcMain.on("toggle-paused", () => pet.togglePaused());
  ipcMain.on("toggle-locked", () => pet.toggleLocked());
  ipcMain.on("toggle-pet-visibility", () => pet.toggleVisibility());
  ipcMain.on("open-config-folder", () => {
    void shell.openPath(app.getPath("userData"));
  });
  ipcMain.on("select-codex-thread", (_event, threadId: unknown) => {
    if (typeof threadId === "string") codexController.selectThread(threadId);
  });
  ipcMain.on("select-animation", (_event, name: string) =>
    pet.selectAnimation(name),
  );
  ipcMain.on(
    "set-animation-mode",
    (_event, mode: PeskSettings["animationMode"]) => {
      if (mode === "selected" || mode === "shuffle") pet.setAnimationMode(mode);
    },
  );
  ipcMain.on("quit-pesk", () => app.quit());
  ipcMain.on(
    "respond-codex-permission",
    (_event, requestId: unknown, decision: unknown) => {
      codexController.respondPermission(
        requestId,
        decision === "allow"
          ? "accept"
          : decision === "deny"
            ? "decline"
            : decision,
      );
    },
  );
  ipcMain.handle("submit-codex-prompt", (_event, prompt: unknown) => {
    codexController.submitPrompt(prompt);
    return rendererSettings();
  });
  ipcMain.on("move-pet", (_event, dx: number, dy: number) => pet.move(dx, dy));
  ipcMain.on("drag-start", () => pet.startDragging());
  ipcMain.on("drag-end", () => pet.stopDragging());
  ipcMain.on("zoom-pet", (_event, scale: number) => pet.resize(scale));
  ipcMain.on("show-pet-menu", () => menu.showPetMenu());
  ipcMain.on("run-preset", (_event, name: string) => {
    presets.run(name);
  });
  ipcMain.on("close-menu-window", () => menu.hide());
  const shortcutRegistered = globalShortcut.register(config.menuShortcut, () =>
    menu.showWindow(),
  );
  debug("menu shortcut", {
    shortcut: config.menuShortcut,
    registered: shortcutRegistered,
  });
  const petFocusShortcutRegistered = globalShortcut.register(
    config.petFocusShortcut,
    () => pet.focus(),
  );
  debug("pet focus shortcut", {
    shortcut: config.petFocusShortcut,
    registered: petFocusShortcutRegistered,
  });
  pet.create();
  chat.create();
  menu.create();
  codexController.start();
});

app.on("window-all-closed", () => {
  // Keep the tray application alive until the user chooses Quit.
});
app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  codexController.stop();
  chat.close();
  pet.close();
  persistSettings();
});
