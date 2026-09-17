import { matchesShortcut } from "../../shared/shortcuts.js";
import { applyRendererTheme } from "../../shared/theme.js";

type MenuSettings = SavedPeskSettings;

interface Preset {
  name: string;
}

interface AnimationFrames {
  name: string;
}

interface PairingInfo {
  expiresAt: number;
  urls: string[];
  qrDataUrl: string;
  deviceName: string;
}

interface CodexProfile {
  id: string;
  name: string;
  url: string;
}

const controls = document.getElementById("controls") as HTMLElement;
const codex = document.getElementById("codex") as HTMLElement;
const animations = document.getElementById("animations") as HTMLElement;
const presetSearch = document.getElementById("preset-search") as HTMLInputElement;
const presetList = document.getElementById("preset-list") as HTMLElement;
const sectionTitle = document.getElementById("section-title") as HTMLElement;
const focusState = document.getElementById("focus-state") as HTMLElement;
const sectionTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#sections button"));
const sectionIds = ["presets", "animations", "codex", "controls", "pairing"];
let activeSection = 0;
const lastActionIndices = [0, 0, 0, 0, 0];
let menuInitialized = false;
let allPresets: Preset[] = [];
let pairingActive = false;
let pairingRenderInFlight = false;
let lastPairingDevicesSignature = "";

function updateFocusState(focused: boolean): void {
  focusState.classList.toggle("unfocused", !focused);
  focusState.setAttribute("aria-label", focused ? "Focused" : "Not focused");
}

function getFocusableActions(section: Element | null): HTMLElement[] {
  return Array.from(
    section?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
    ) ?? [],
  );
}

function focusSectionAction(): void {
  if (activeSection === 0) {
    presetSearch.focus();
    return;
  }
  if (activeSection === 4) {
    (document.getElementById("pairing-device-name") as HTMLInputElement | null)?.focus();
    return;
  }
  const section = document.getElementById(sectionIds[activeSection]);
  const actions = getFocusableActions(section);
  const index = Math.min(lastActionIndices[activeSection], Math.max(0, actions.length - 1));
  (actions[index] ?? sectionTabs[activeSection])?.focus();
}

function rememberCurrentAction(): void {
  const section = document.getElementById(sectionIds[activeSection]);
  const actions = getFocusableActions(section);
  const index = actions.indexOf(document.activeElement as HTMLElement);
  if (index >= 0) lastActionIndices[activeSection] = index;
}

function showSection(index: number, focus = true): void {
  activeSection = (index + sectionIds.length) % sectionIds.length;
  for (const [sectionIndex, id] of sectionIds.entries()) {
    const section = document.getElementById(id) as HTMLElement;
    const tab = sectionTabs[sectionIndex];
    const active = sectionIndex === activeSection;
    section.hidden = !active;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  sectionTitle.textContent = sectionTabs[activeSection].textContent ?? "";
  if (focus) focusSectionAction();
}

function closeMenu(): void {
  window.peskApi.closeMenuWindow();
}

function addAction(label: string, action: () => void, target: HTMLElement = controls): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    rememberCurrentAction();
    action();
    closeMenu();
  });
  target.append(button);
}

function titleCaseThemeName(themeName: string): string {
  return themeName.charAt(0).toUpperCase() + themeName.slice(1);
}

function renderCodexProfiles(
  settings: MenuSettings,
  profileState: { profiles: CodexProfile[]; activeProfileId: string },
  busy: boolean,
): void {
  const addHeading = document.createElement("h3");
  addHeading.textContent = "Add app-server";
  codex.append(addHeading);
  const addForm = document.createElement("div");
  addForm.className = "codex-profile-form";
  const addName = document.createElement("input");
  addName.className = "codex-profile-input";
  addName.placeholder = "New profile name";
  addName.setAttribute("aria-label", "New profile name");
  const addUrl = document.createElement("input");
  addUrl.className = "codex-profile-input";
  addUrl.placeholder = "WebSocket URL (ws:// or wss://)";
  addUrl.setAttribute("aria-label", "New profile URL");
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add app-server";
  add.addEventListener("click", () => {
    void window.peskApi
      .addCodexAppServerProfile(addName.value, addUrl.value)
      .then(() => void loadMenu())
      .catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
  });
  addForm.append(addName, addUrl, add);
  codex.append(addForm);

  const listHeading = document.createElement("h3");
  listHeading.textContent = "App-server profiles";
  codex.append(listHeading);
  const profileList = document.createElement("div");
  profileList.className = "codex-profile-list";
  for (const profile of profileState.profiles) {
    const row = document.createElement("div");
    row.className = "pairing-device codex-profile";
    const isActive = profile.id === profileState.activeProfileId;
    row.setAttribute("aria-current", isActive ? "true" : "false");
    const details = document.createElement("div");
    details.className = "codex-profile-details";
    const name = document.createElement("span");
    name.textContent = profile.name;
    const url = document.createElement("small");
    url.textContent = profile.url;
    details.append(name, url);
    const actions = document.createElement("div");
    actions.className = "codex-profile-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.className = isActive ? "active" : "";
    select.textContent = profile.id === profileState.activeProfileId ? "Active" : "Select";
    select.disabled = profile.id === profileState.activeProfileId;
    select.addEventListener("click", () => {
      if (busy && select.dataset.confirming !== "true") {
        select.dataset.confirming = "true";
        select.textContent = "Confirm switch";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => void loadMenu());
        actions.append(cancel);
        select.focus();
        return;
      }
      void window.peskApi.selectCodexAppServerProfile(profile.id).then(() => void loadMenu());
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      const editName = document.createElement("input");
      editName.className = "codex-profile-input";
      editName.value = profile.name;
      editName.setAttribute("aria-label", `${profile.name} profile name`);
      const editUrl = document.createElement("input");
      editUrl.className = "codex-profile-input";
      editUrl.value = profile.url;
      editUrl.setAttribute("aria-label", `${profile.name} profile URL`);
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Save";
      save.addEventListener("click", () => {
        void window.peskApi
          .updateCodexAppServerProfile(profile.id, editName.value, editUrl.value)
          .then(() => void loadMenu())
          .catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => void loadMenu());
      row.replaceChildren(editName, editUrl, save, cancel);
      editName.focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.disabled =
      profileState.profiles.length === 1 || profile.id === profileState.activeProfileId;
    remove.title =
      profile.id === profileState.activeProfileId
        ? "Select another profile before deleting this one"
        : "Delete profile";
    remove.addEventListener("click", () => {
      if (remove.dataset.confirming !== "true") {
        remove.dataset.confirming = "true";
        remove.textContent = "Confirm delete";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => void loadMenu());
        actions.append(cancel);
        remove.focus();
        return;
      }
      void window.peskApi
        .deleteCodexAppServerProfile(profile.id)
        .then(() => void loadMenu())
        .catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
    });
    actions.append(select, edit, remove);
    row.append(details, actions);
    profileList.append(row);
  }
  codex.append(profileList);
  addAction(
    settings.codexStatusSound ? "Disable Codex status sound" : "Enable Codex status sound",
    window.peskApi.toggleCodexStatusSound,
    codex,
  );
}

function renderControls(
  settings: MenuSettings,
  themeName?: RendererState["assets"]["themeName"],
  themeNames: RendererState["assets"]["themeNames"] = [],
): void {
  controls.replaceChildren();
  const themeLabel = document.createElement("label");
  themeLabel.className = "theme-selector";
  themeLabel.textContent = "Theme";
  const themeSelect = document.createElement("select");
  themeSelect.setAttribute("aria-label", "Theme");
  for (const value of themeNames) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = titleCaseThemeName(value);
    themeSelect.append(option);
  }
  themeSelect.value = themeName ?? themeNames[0] ?? "";
  themeSelect.addEventListener("change", () => {
    void window.peskApi.setTheme(themeSelect.value).then((next) => {
      applyRendererTheme(next.assets.theme);
      renderControls(next.settings, next.assets.themeName, next.assets.themeNames);
    });
  });
  themeLabel.append(themeSelect);
  controls.append(themeLabel);
  addAction(settings.paused ? "Resume animation" : "Pause animation", window.peskApi.togglePaused);
  addAction(settings.locked ? "Unlock position" : "Lock position", window.peskApi.toggleLocked);
  addAction(settings.visible ? "Hide Pesk" : "Show Pesk", window.peskApi.togglePetVisibility);
  addAction("Open config folder", window.peskApi.openConfigFolder);
  addAction("Quit Pesk", window.peskApi.quitPesk);
}

async function renderPairing(
  focusDeviceId?: string,
  focusAction?: "push" | "revoke",
): Promise<void> {
  while (pairingRenderInFlight) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  pairingRenderInFlight = true;
  try {
    const devices = document.getElementById("pairing-devices") as HTMLElement;
    const focused = document.activeElement as HTMLElement | null;
    const focusedControl = focused?.closest<HTMLElement>("[data-device-id]");
    const restoreDeviceId = focusDeviceId ?? focusedControl?.dataset.deviceId;
    const restoreAction =
      focusAction ?? (focusedControl?.dataset.action as "push" | "revoke" | undefined);
    const values = await window.peskApi.getPairingDevices();
    const signature = JSON.stringify(values);
    if (!focusDeviceId && !focusAction && signature === lastPairingDevicesSignature) return;
    lastPairingDevicesSignature = signature;
    devices.replaceChildren();
    if (!values.length) {
      devices.textContent = "No paired devices.";
      return;
    }
    for (const device of values) {
      const row = document.createElement("div");
      row.className = "pairing-device";
      const label = document.createElement("span");
      label.textContent = device.name;
      const status = document.createElement("small");
      status.className = device.pushRegistered ? "push-configured" : "push-not-configured";
      status.textContent = device.pushRegistered
        ? "Web Push configured"
        : "Web Push not configured";
      const push = document.createElement("button");
      push.type = "button";
      push.dataset.deviceId = device.id;
      push.dataset.action = "push";
      push.textContent = device.pushEnabled ? "Disable push" : "Enable push";
      push.addEventListener("click", async () => {
        await window.peskApi.setPairingDevicePush(device.id, !device.pushEnabled);
        await renderPairing(device.id, "push");
      });
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.dataset.deviceId = device.id;
      revoke.dataset.action = "revoke";
      revoke.addEventListener("click", async () => {
        if (revoke.dataset.confirming !== "true") {
          revoke.dataset.confirming = "true";
          revoke.textContent = "Confirm revoke";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.textContent = "Cancel";
          cancel.dataset.deviceId = device.id;
          cancel.dataset.action = "cancel-revoke";
          cancel.addEventListener("click", () => void renderPairing(device.id, "revoke"));
          row.append(cancel);
          revoke.focus();
          return;
        }
        await window.peskApi.revokePairingDevice(device.id);
        await renderPairing();
        window.requestAnimationFrame(() => {
          const input = document.getElementById("pairing-device-name") as HTMLInputElement;
          input.focus();
          window.setTimeout(() => input.focus(), 50);
        });
      });
      row.append(label, status, push, revoke);
      devices.append(row);
    }
    if (restoreDeviceId && restoreAction) {
      (
        devices.querySelector(
          `[data-device-id="${CSS.escape(restoreDeviceId)}"][data-action="${restoreAction}"]`,
        ) as HTMLElement | null
      )?.focus();
    }
  } finally {
    pairingRenderInFlight = false;
  }
}

async function generatePairing(): Promise<void> {
  const details = document.getElementById("pairing-details") as HTMLElement;
  const status = document.getElementById("pairing-status") as HTMLElement;
  const name = (document.getElementById("pairing-device-name") as HTMLInputElement).value;
  if (!name.trim()) return;
  let info: PairingInfo | undefined;
  try {
    info = (await window.peskApi.createPairing(name)) as PairingInfo | undefined;
  } catch (error) {
    status.hidden = false;
    status.textContent = error instanceof Error ? error.message : "Unable to create pairing code.";
    return;
  }
  if (!info) return;
  status.hidden = true;
  details.hidden = false;
  pairingActive = true;
  (document.getElementById("pairing-device-name") as HTMLInputElement).value = info.deviceName;
  (document.getElementById("pairing-qr") as HTMLImageElement).src = info.qrDataUrl;
  (document.getElementById("pairing-url") as HTMLElement).textContent = info.urls[0] ?? "";
}

document.getElementById("pairing-device-name")?.addEventListener("keydown", (event) => {
  if (!matchesShortcut(event, "pairingSubmit")) return;
  event.preventDefault();
  void generatePairing();
});

document.getElementById("pairing-device-name")?.addEventListener("input", () => {
  if (!pairingActive) return;
  pairingActive = false;
  (document.getElementById("pairing-details") as HTMLElement).hidden = true;
});

window.setInterval(async () => {
  if (document.querySelector("[data-confirming='true']")) return;
  await renderPairing();
  if (!pairingActive) return;
  const pairingStatus = await window.peskApi.getPairingStatus();
  if (pairingStatus.active) return;
  pairingActive = false;
  (document.getElementById("pairing-details") as HTMLElement).hidden = true;
  const status = document.getElementById("pairing-status") as HTMLElement;
  if (pairingStatus.pairedDeviceName) {
    status.hidden = false;
    status.replaceChildren();
    const tick = document.createElement("span");
    tick.className = "pairing-success-tick";
    tick.textContent = "✓";
    status.append(tick, ` Paired: ${pairingStatus.pairedDeviceName}`);
    const nameInput = document.getElementById("pairing-device-name") as HTMLInputElement;
    nameInput.value = "";
    nameInput.focus();
  }
}, 1000);

function renderAnimations(
  items: AnimationFrames[],
  selected: string,
  animationMode: MenuSettings["animationMode"],
): void {
  animations.replaceChildren();
  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.textContent =
    "Animation mode: " + (animationMode === "shuffle" ? "Shuffle" : "Selected");
  modeButton.addEventListener("click", () => {
    rememberCurrentAction();
    window.peskApi.setAnimationMode(animationMode === "shuffle" ? "selected" : "shuffle");
    closeMenu();
  });
  animations.append(modeButton);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No animations available.";
    animations.append(empty);
    return;
  }

  for (const animation of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = animation.name;
    button.className = animation.name === selected ? "selected" : "";
    button.addEventListener("click", () => {
      rememberCurrentAction();
      window.peskApi.selectAnimation(animation.name);
      closeMenu();
    });
    animations.append(button);
  }
}

function fuzzyMatch(value: string, query: string): boolean {
  let queryIndex = 0;
  for (const character of value.toLowerCase()) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
}

function renderPresets(items: Preset[] = allPresets, focusFirst = false): void {
  const keepItemFocus = !focusFirst && presetList.contains(document.activeElement);
  const query = presetSearch.value.trim().toLowerCase();
  const filtered = query ? items.filter((preset) => fuzzyMatch(preset.name, query)) : items;
  presetList.replaceChildren();
  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "No matching presets." : "No presets configured.";
    presetList.append(empty);
    return;
  }

  for (const preset of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.name;
    button.addEventListener("click", () => {
      rememberCurrentAction();
      window.peskApi.runPreset(preset.name);
      closeMenu();
    });
    presetList.append(button);
  }
  if (focusFirst || keepItemFocus) {
    const buttons = Array.from(presetList.querySelectorAll<HTMLButtonElement>("button"));
    const index = focusFirst ? 0 : Math.min(lastActionIndices[0], Math.max(0, buttons.length - 1));
    buttons[index]?.focus();
  }
}

presetSearch.addEventListener("input", () => renderPresets(allPresets, true));

async function loadMenu(): Promise<void> {
  const [state, animations, presets] = await Promise.all([
    window.peskApi.getSettings(),
    window.peskApi.getAnimations(),
    window.peskApi.getPresets(),
  ]);
  const profileState =
    typeof window.peskApi.getCodexAppServerProfiles === "function"
      ? await window.peskApi.getCodexAppServerProfiles()
      : undefined;
  applyRendererTheme(state.assets.theme);
  renderControls(state.settings, state.assets.themeName, state.assets.themeNames);
  codex.replaceChildren();
  if (profileState)
    renderCodexProfiles(
      state.settings,
      profileState,
      state.codex.threads.current.thread.status !== "idle",
    );
  renderAnimations(animations, state.settings.animation, state.settings.animationMode);
  await renderPairing();
  allPresets = presets;
  renderPresets();
  if (!menuInitialized) {
    menuInitialized = true;
    showSection(0);
  } else {
    showSection(activeSection);
  }
}

void loadMenu();
window.peskApi.onMenuUpdated(() => void loadMenu());
window.peskApi.onMenuFocusChanged(updateFocusState);
updateFocusState(document.hasFocus());

for (const [index, tab] of sectionTabs.entries()) {
  tab.addEventListener("click", () => showSection(index));
}

window.addEventListener("keydown", (event) => {
  if (matchesShortcut(event, "menuNextSection") || matchesShortcut(event, "menuPreviousSection")) {
    event.preventDefault();
    rememberCurrentAction();
    showSection(activeSection + (matchesShortcut(event, "menuPreviousSection") ? -1 : 1));
    return;
  }

  if (
    activeSection === 0 &&
    document.activeElement !== presetSearch &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    if (event.key.length === 1) {
      rememberCurrentAction();
      presetSearch.value += event.key;
      renderPresets(allPresets, true);
      event.preventDefault();
      return;
    }
    if (matchesShortcut(event, "menuSearchBackspace") && presetSearch.value) {
      rememberCurrentAction();
      presetSearch.value = presetSearch.value.slice(0, -1);
      renderPresets(allPresets, true);
      event.preventDefault();
      return;
    }
  }

  const section = document.getElementById(sectionIds[activeSection]);
  const buttons = getFocusableActions(section);
  const actions =
    activeSection === 0 ? buttons.filter((button) => button !== presetSearch) : buttons;
  const currentIndex = actions.indexOf(document.activeElement as HTMLElement);
  if (
    matchesShortcut(event, "menuPreviousRowAction") ||
    matchesShortcut(event, "menuNextRowAction")
  ) {
    const row = (document.activeElement as HTMLElement).closest(".pairing-device");
    if (row) {
      const rowActions = getFocusableActions(row);
      const rowIndex = rowActions.indexOf(document.activeElement as HTMLElement);
      if (rowIndex >= 0 && rowActions.length > 1) {
        event.preventDefault();
        const direction = matchesShortcut(event, "menuNextRowAction") ? 1 : -1;
        rowActions[(rowIndex + direction + rowActions.length) % rowActions.length].focus();
      }
    }
    return;
  }
  if (matchesShortcut(event, "menuNextAction") || matchesShortcut(event, "menuPreviousAction")) {
    event.preventDefault();
    if (activeSection === 0 && document.activeElement === presetSearch) {
      if (matchesShortcut(event, "menuNextAction")) actions[0]?.focus();
      return;
    }
    if (actions.length === 0) return;
    if (activeSection === 0 && matchesShortcut(event, "menuPreviousAction") && currentIndex === 0) {
      presetSearch.focus();
      return;
    }
    const direction = matchesShortcut(event, "menuNextAction") ? 1 : -1;
    const nextIndex = (currentIndex + direction + actions.length) % actions.length;
    lastActionIndices[activeSection] = nextIndex;
    actions[nextIndex].focus();
    return;
  }
  if (matchesShortcut(event, "closeMenu")) {
    event.preventDefault();
    closeMenu();
  }
});
