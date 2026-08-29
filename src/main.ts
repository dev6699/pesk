import { app, globalShortcut, ipcMain, shell } from "electron";
import * as path from "node:path";
import { CodexController } from "./codex";
import type {
  CodexMessage,
  CodexModelInfo,
  CodexPendingApproval,
  CodexPendingUserInput,
  CodexQueuedSubmission,
} from "./codex";
import type { Thread, ThreadTokenUsage } from "./codex-schema/v2";
import { ChatWindowController } from "./chat";
import { PetWindowController } from "./pet";
import { loadConfig, loadSettings, saveSettings } from "./config";
import type { PeskSettings } from "./config";
import { PresetController } from "./preset";
import { MenuController } from "./menu";
import { routePetFocusShortcut } from "./focus-shortcut";
import { ChatWebServer } from "./chat-web-server";

interface RendererSettings extends PeskSettings {
  codexThreadId?: string;
  codexCwd?: string;
  codexError?: string;
  codexStatus: "idle" | "working" | "waiting";
  codexConnected: boolean;
  codexWorkingSince?: number;
  codexWorkedElapsed?: number;
  codexInterrupted?: boolean;
  codexHistory: CodexMessage[];
  codexThreads: Thread[];
  codexTokenUsage?: ThreadTokenUsage;
  codexModelInfo?: CodexModelInfo;
  codexRateLimits?: import("./codex-schema/v2").RateLimitSnapshot;
  codexCollaborationMode: "default" | "plan";
  codexPendingUserInput?: CodexPendingUserInput;
  codexPendingApproval?: CodexPendingApproval;
  codexQueuedSubmissions: CodexQueuedSubmission[];
  codexStatusSoundUrl: string;
}

let settings: PeskSettings;
let codexController: CodexController;
let chat: ChatWindowController;
let pet: PetWindowController;
let presets: PresetController;
let menu: MenuController;
let codexStatusSoundUrl = "";
let webServer: ChatWebServer;

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
    codexCwd: state.cwd,
    codexError: state.error,
    codexStatus: state.status,
    codexConnected: state.connected,
    codexHistory: state.history,
    codexThreads: state.threads,
    codexWorkingSince: state.workingSince,
    codexWorkedElapsed: state.workedElapsed,
    codexInterrupted: state.interrupted,
    codexTokenUsage: state.tokenUsage,
    codexModelInfo: state.modelInfo,
    codexRateLimits: state.rateLimits,
    codexCollaborationMode: state.collaborationMode,
    codexPendingUserInput: state.pendingUserInput,
    codexPendingApproval: state.pendingApproval,
    codexQueuedSubmissions: state.queuedSubmissions,
    codexStatusSoundUrl,
  };
}

function publishRendererState(): void {
  const state = rendererSettings();
  pet.window?.webContents.send("settings-changed", state);
  chat.window?.webContents.send("settings-changed", state);
  webServer?.broadcast(state);
}

function handleWebCommand(
  message: unknown,
  reply: (message: unknown) => void,
): void {
  if (!message || typeof message !== "object") return;
  const command = message as Record<string, unknown>;
  const requestId = command.requestId;
  const replyCommand = (ok: boolean): void => {
    if (typeof requestId !== "number") return;
    reply({ type: "commandResult", requestId, ok, state: rendererSettings() });
  };
  switch (command.type) {
    case "submitPrompt":
      if (typeof command.prompt === "string") {
        replyCommand(codexController.submitPrompt(command.prompt));
      } else {
        replyCommand(false);
      }
      break;
    case "startReview":
      if (typeof command.instructions === "string") {
        replyCommand(codexController.startReview(command.instructions));
      } else {
        replyCommand(false);
      }
      break;
    case "implementPlan":
      if (
        typeof command.planText === "string" &&
        typeof command.clearContext === "boolean"
      ) {
        replyCommand(
          codexController.implementPlan(command.planText, command.clearContext),
        );
      } else {
        replyCommand(false);
      }
      break;
    case "selectThread":
      if (typeof command.threadId === "string")
        codexController.selectThread(command.threadId);
      break;
    case "setCollaborationMode":
      if (command.mode === "default" || command.mode === "plan") {
        codexController.setCollaborationMode(command.mode);
      }
      break;
    case "interruptTurn":
      replyCommand(codexController.interruptTurn());
      break;
    case "steerTurn":
      if (typeof command.prompt === "string") {
        replyCommand(codexController.steerPrompt(command.prompt));
      } else replyCommand(false);
      break;
    case "respondPermission":
      if (
        (typeof command.requestId === "string" ||
          typeof command.requestId === "number") &&
        typeof command.optionId === "string"
      ) {
        codexController.respondPermission(command.requestId, command.optionId);
      }
      break;
    case "respondUserInput":
      if (
        (typeof command.requestId === "string" ||
          typeof command.requestId === "number") &&
        command.answers &&
        typeof command.answers === "object"
      ) {
        const answers = Object.fromEntries(
          Object.entries(command.answers).flatMap(([id, value]) =>
            Array.isArray(value)
              ? [
                [
                  id,
                  value.filter(
                    (item): item is string => typeof item === "string",
                  ),
                ],
              ]
              : [],
          ),
        );
        codexController.respondUserInput(answers);
      }
      break;
    case "refreshRateLimits":
      codexController.refreshRateLimits();
      break;
    case "fuzzyFileSearch":
      if (
        (typeof command.requestId === "string" ||
          typeof command.requestId === "number") &&
        typeof command.query === "string" &&
        Array.isArray(command.roots)
      ) {
        const roots = command.roots.filter(
          (root): root is string => typeof root === "string",
        );
        void codexController
          .fuzzyFileSearch(command.query, roots)
          .then((files) =>
            reply({
              type: "fuzzyFileSearchResult",
              requestId: command.requestId,
              files,
            }),
          );
      }
      break;
  }
}

app.whenReady().then(() => {
  configureAutoStart();
  settings = loadSettings();
  const config = loadConfig();
  codexStatusSoundUrl = config.codexStatusSound;
  webServer = new ChatWebServer({
    enabled: config.webAccessEnabled,
    port: config.webPort,
    tlsKey: config.webTlsKey,
    tlsCert: config.webTlsCert,
    rendererDirectory: path.join(__dirname, "renderer"),
    webPushVapidPath: path.join(app.getPath("userData"), "web-push-vapid.json"),
    webPushSubscriptionsPath: path.join(
      app.getPath("userData"),
      "web-push-subscriptions.json",
    ),
    deviceCredentialsPath: path.join(
      app.getPath("userData"),
      "web-devices.json",
    ),
    getState: rendererSettings,
    handleCommand: (message, reply) => handleWebCommand(message, reply),
    debug,
  });
  presets = new PresetController(debug);
  pet = new PetWindowController({
    getSettings: () => settings,
    saveSettings: persistSettings,
    publishRendererState: publishRendererState,
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
    hideChatImmediately: () => chat.hide(),
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
    toggleCodexStatusSound: () => pet.toggleCodexStatusSound(),
    showPet: () => pet.show(),
  });
  codexController = new CodexController({
    publishRendererState,
    showPetForUpdate: () => {
      settings.visible = true;
      chat.showForCodexUpdate();
    },
    focusUserInput: () => chat.focusForUserInput(),
    showApproval: () => chat.showForApproval(),
    clearApproval: () => pet.setCodexUpdateIndicator(false),
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
  ipcMain.handle("get-settings", () => {
    codexController.refreshRateLimits();
    return rendererSettings();
  });
  ipcMain.handle("refresh-codex-rate-limits", () => {
    codexController.refreshRateLimits();
  });
  ipcMain.handle("get-animations", () => pet.getAnimations());
  ipcMain.handle("get-chat-size", () => chat.getSize());
  ipcMain.handle("get-presets", () => presets.getPresets());
  ipcMain.on("toggle-paused", () => pet.togglePaused());
  ipcMain.on("toggle-locked", () => pet.toggleLocked());
  ipcMain.on("toggle-pet-visibility", () => pet.toggleVisibility());
  ipcMain.on("toggle-codex-status-sound", () => pet.toggleCodexStatusSound());
  ipcMain.on("open-config-folder", () => {
    void shell.openPath(app.getPath("userData"));
  });
  ipcMain.handle("create-pairing", (_event, name: unknown) =>
    webServer.createPairing(typeof name === "string" ? name : "Browser device"),
  );
  ipcMain.handle("get-pairing-status", () => webServer.getPairingStatus());
  ipcMain.handle("get-pairing-devices", () => webServer.listDevices());
  ipcMain.handle("revoke-pairing-device", (_event, id: unknown) => {
    if (typeof id === "string") webServer.revokeDevice(id);
  });
  ipcMain.handle(
    "set-pairing-device-push",
    (_event, id: unknown, enabled: unknown) => {
      if (typeof id === "string" && typeof enabled === "boolean") {
        webServer.setDevicePushEnabled(id, enabled);
      }
    },
  );
  ipcMain.on("select-codex-thread", (_event, threadId: unknown) => {
    if (typeof threadId === "string") codexController.selectThread(threadId);
  });
  ipcMain.on("set-codex-collaboration-mode", (_event, mode: unknown) => {
    if (mode === "default" || mode === "plan") {
      codexController.setCollaborationMode(mode);
    }
  });
  ipcMain.on("focus-codex-input", () => chat.focusInput());
  ipcMain.handle(
    "implement-codex-plan",
    (_event, planText: unknown, clearContext: unknown) => {
      if (typeof planText !== "string" || typeof clearContext !== "boolean") {
        return rendererSettings();
      }
      codexController.implementPlan(planText, clearContext);
      return rendererSettings();
    },
  );
  ipcMain.on(
    "respond-codex-user-input",
    (_event, requestId: unknown, answers: unknown) => {
      if (
        (typeof requestId !== "string" && typeof requestId !== "number") ||
        !answers ||
        typeof answers !== "object"
      ) {
        return;
      }
      const normalized = Object.fromEntries(
        Object.entries(answers).flatMap(([questionId, value]) => {
          if (!Array.isArray(value)) return [];
          const selected = value.filter(
            (answer): answer is string => typeof answer === "string",
          );
          return [[questionId, selected]];
        }),
      );
      codexController.respondUserInput(normalized);
    },
  );
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
      if (typeof requestId !== "string" && typeof requestId !== "number") {
        return;
      }
      if (typeof decision === "string") {
        codexController.respondPermission(requestId, decision);
      }
    },
  );
  ipcMain.handle("submit-codex-prompt", (_event, prompt: unknown) => {
    if (typeof prompt === "string") {
      codexController.submitPrompt(prompt);
    }
    return rendererSettings();
  });
  ipcMain.handle(
    "fuzzy-file-search",
    (_event, query: unknown, roots: unknown) => {
      if (typeof query !== "string" || !Array.isArray(roots)) return [];
      const validRoots = roots.filter(
        (root): root is string => typeof root === "string",
      );
      return codexController.fuzzyFileSearch(query, validRoots);
    },
  );
  ipcMain.handle("interrupt-codex-turn", () => codexController.interruptTurn());
  ipcMain.handle("steer-codex-turn", (_event, prompt: unknown) => {
    if (typeof prompt === "string") codexController.steerPrompt(prompt);
    return rendererSettings();
  });
  ipcMain.handle("start-codex-review", (_event, instructions: unknown) => {
    if (typeof instructions === "string") {
      codexController.startReview(instructions);
    }
    return rendererSettings();
  });
  ipcMain.on("move-pet", (_event, dx: number, dy: number) => pet.move(dx, dy));
  ipcMain.on("drag-start", () => pet.startDragging());
  ipcMain.on("drag-end", () => pet.stopDragging());
  ipcMain.on("focus-pet", () => pet.focus());
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
    () =>
      routePetFocusShortcut(
        chat,
        pet,
        Boolean(codexController.getState().pendingUserInput),
      ),
  );
  debug("pet focus shortcut", {
    shortcut: config.petFocusShortcut,
    registered: petFocusShortcutRegistered,
  });
  pet.create();
  chat.create();
  menu.create();
  codexController.start();
  webServer.start();
});

app.on("window-all-closed", () => {
  // Keep the tray application alive until the user chooses Quit.
});
app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  codexController.stop();
  webServer?.stop();
  chat.close();
  pet.close();
  persistSettings();
});
