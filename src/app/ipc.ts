import { dialog, shell } from "electron";
import type { ApplicationContext } from "./application";
import type { PeskSettings } from "../config/config";
import { isRequestId, validAnswers, validImageInputs, validRoots } from "./validation";
import { registerEvent, registerInvoke } from "./ipc-contract";

/** Registers the main-process IPC surface, grouped by the feature it controls. */
export function registerIpcHandlers(context: ApplicationContext): void {
  const { codex, pet, chat, presets, menu, webServer, state, focus } = context;

  // General application and renderer state
  registerInvoke("get-settings", () => state.getState());
  registerInvoke("get-animations", () => pet.getAnimations());
  registerInvoke("get-chat-size", () => chat.getSize());
  registerInvoke("get-presets", () => presets.getPresets());
  registerInvoke("set-theme", (_event, themeName) => {
    if (typeof themeName === "string") context.setTheme(themeName);
    return state.getState();
  });
  registerEvent("refresh-codex-rate-limits", () => codex.refreshRateLimits());
  registerEvent("open-config-folder", () => void shell.openPath(context.userDataPath));

  // Pet and window controls
  registerEvent("toggle-paused", () => pet.togglePaused());
  registerEvent("toggle-locked", () => pet.toggleLocked());
  registerEvent("toggle-pet-visibility", () => pet.toggleVisibility());
  registerEvent("toggle-codex-status-sound", () => pet.toggleCodexStatusSound());
  registerEvent("select-animation", (_event, name) => {
    if (typeof name === "string") pet.selectAnimation(name);
  });
  registerEvent("set-animation-mode", (_event, mode) => {
    if (mode === "selected" || mode === "shuffle")
      pet.setAnimationMode(mode as PeskSettings["animationMode"]);
  });
  registerEvent("move-pet", (_event, dx, dy) => {
    if (typeof dx === "number" && typeof dy === "number") pet.move(dx, dy);
  });
  registerEvent("zoom-pet", (_event, scale) => {
    if (typeof scale === "number") pet.resize(scale);
  });
  registerEvent("drag-start", () => pet.startDragging());
  registerEvent("drag-end", () => pet.stopDragging());
  registerEvent("focus-pet", () => pet.focus());
  registerEvent("unfocus-pesk", () => {
    chat.hide();
    pet.window?.blur();
  });
  registerEvent("focus-codex-input", () => {
    focus.wireChatWindow();
    chat.focusInput(pet.window?.getBounds());
  });
  registerEvent("chat-file-dialog", (_event, open) => focus.setFileDialogOpen(open === true));

  // Codex threads, turns, prompts, and responses
  registerInvoke("submit-codex-prompt", (_event, prompt, images) => {
    if (typeof prompt === "string") codex.submitPromptWithImages(prompt, validImageInputs(images));
    return state.getState();
  });
  registerInvoke("start-codex-project-thread", (_event, projectId, cwd) => {
    if (typeof projectId === "string" && typeof cwd === "string")
      codex.startProjectThread(projectId, cwd);
    return state.getState();
  });
  registerInvoke("start-codex-review", (_event, instructions) => {
    if (typeof instructions === "string") codex.startReview(instructions);
    return state.getState();
  });
  registerInvoke("implement-codex-plan", (_event, text, clear) => {
    if (typeof text === "string" && typeof clear === "boolean") codex.implementPlan(text, clear);
    return state.getState();
  });
  registerInvoke("interrupt-codex-turn", () => codex.interruptTurn());
  registerInvoke("steer-codex-turn", (_event, prompt) => {
    if (typeof prompt === "string") codex.steerPrompt(prompt);
    return state.getState();
  });
  registerInvoke("load-older-codex-history", () => codex.loadOlderHistory());
  registerInvoke("fuzzy-file-search", (_event, query, roots) => {
    const valid = validRoots(roots);
    return typeof query === "string" && valid ? codex.fuzzyFileSearch(query, valid) : [];
  });
  registerInvoke("list-codex-projects", async () => {
    await codex.listProjects();
    return state.getState();
  });
  registerInvoke("read-codex-project", async (_event, id) => {
    await codex.readProject(id);
    return state.getState();
  });
  registerInvoke("create-codex-project", async (_event, name, root, key) => {
    await codex.createProject(name, [root], {}, key);
    return state.getState();
  });
  registerInvoke("import-codex-project", async (_event, name, roots, threadIds, key) => {
    await codex.importProject(name, roots, threadIds, {}, key);
    return state.getState();
  });
  registerInvoke("update-codex-project", async (_event, id, changes) => {
    await codex.updateProject(id, changes);
    return state.getState();
  });
  registerInvoke("move-codex-project", async (_event, id, beforeId) => {
    await codex.moveProject(id, beforeId);
    return state.getState();
  });
  registerInvoke("delete-codex-project", async (_event, id) => {
    await codex.deleteProject(id);
    return state.getState();
  });
  registerInvoke("choose-codex-project-root", async (event) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  registerEvent("select-codex-thread", (_event, id) => {
    if (typeof id === "string") codex.selectThread(id);
  });
  registerEvent("set-codex-collaboration-mode", (_event, mode) => {
    if (mode === "default" || mode === "plan") codex.setCollaborationMode(mode);
  });
  registerEvent("respond-codex-user-input", (_event, requestId, answers) => {
    const normalized = validAnswers(answers);
    if (isRequestId(requestId) && normalized) codex.respondUserInput(normalized);
  });
  registerEvent("respond-codex-permission", (_event, requestId, decision) => {
    if (isRequestId(requestId) && typeof decision === "string")
      codex.respondPermission(requestId, decision);
  });

  // Browser pairing and web access
  registerInvoke("create-pairing", (_event, name) =>
    webServer.createPairing(typeof name === "string" ? name : "Browser device"),
  );
  registerInvoke("get-pairing-status", () => webServer.getPairingStatus());
  registerInvoke("get-pairing-devices", () => webServer.listDevices());
  registerInvoke("revoke-pairing-device", (_event, id) => {
    if (typeof id === "string") webServer.revokeDevice(id);
  });
  registerInvoke("set-pairing-device-push", (_event, id, enabled) => {
    if (typeof id === "string" && typeof enabled === "boolean")
      webServer.setDevicePushEnabled(id, enabled);
  });

  // Presets and application lifecycle
  registerEvent("run-preset", (_event, name) => {
    if (typeof name === "string") presets.run(name);
  });
  registerEvent("show-pet-menu", () => menu.showPetMenu());
  registerEvent("close-menu-window", () => menu.hide());
  registerEvent("quit-pesk", () => context.quit());
}
