export { };

interface MenuSettings {
  animation: string;
  animationMode: "selected" | "shuffle";
  paused: boolean;
  locked: boolean;
  wandering: boolean;
  visible: boolean;
}

interface Preset {
  name: string;
}

interface AnimationFrames {
  name: string;
}

const controls = document.getElementById("controls") as HTMLElement;
const animations = document.getElementById("animations") as HTMLElement;
const presetSearch = document.getElementById("preset-search") as HTMLInputElement;
const presetList = document.getElementById("preset-list") as HTMLElement;
const sectionTitle = document.getElementById("section-title") as HTMLElement;
const focusState = document.getElementById("focus-state") as HTMLElement;
const sectionTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#sections button"));
const sectionIds = ["presets", "animations", "controls"];
let activeSection = 0;
const lastActionIndices = [0, 0, 0];
let menuInitialized = false;
let allPresets: Preset[] = [];

function updateFocusState(focused: boolean): void {
  focusState.classList.toggle("unfocused", !focused);
  focusState.setAttribute("aria-label", focused ? "Focused" : "Not focused");
}

function focusSectionAction(): void {
  if (activeSection === 0) {
    presetSearch.focus();
    return;
  }
  const section = document.getElementById(sectionIds[activeSection]);
  const actions = Array.from(section?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const index = Math.min(lastActionIndices[activeSection], Math.max(0, actions.length - 1));
  (actions[index] ?? sectionTabs[activeSection])?.focus();
}

function rememberCurrentAction(): void {
  const section = document.getElementById(sectionIds[activeSection]);
  const actions = Array.from(section?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const index = actions.indexOf(document.activeElement as HTMLButtonElement);
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
  window.petApi.closeMenuWindow();
}

function addAction(label: string, action: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    rememberCurrentAction();
    action();
    closeMenu();
  });
  controls.append(button);
}

function renderControls(settings: MenuSettings): void {
  controls.replaceChildren();
  addAction(settings.paused ? "Resume animation" : "Pause animation", window.petApi.togglePaused);
  addAction(settings.wandering ? "Stop wandering" : "Start wandering", window.petApi.toggleWandering);
  addAction(settings.locked ? "Unlock position" : "Lock position", window.petApi.toggleLocked);
  addAction(settings.visible ? "Hide Pesk" : "Show Pesk", window.petApi.togglePetVisibility);
  addAction("Open config folder", window.petApi.openConfigFolder);
  addAction("Quit Pesk", window.petApi.quitPesk);
}

function renderAnimations(items: AnimationFrames[], selected: string, animationMode: MenuSettings["animationMode"]): void {
  animations.replaceChildren();
  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.textContent = "Animation mode: " + (animationMode === "shuffle" ? "Shuffle" : "Selected");
  modeButton.addEventListener("click", () => {
    rememberCurrentAction();
    window.petApi.setAnimationMode(animationMode === "shuffle" ? "selected" : "shuffle");
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
      window.petApi.selectAnimation(animation.name);
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
  const filtered = query
    ? items.filter((preset) => fuzzyMatch(preset.name, query))
    : items;
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
      window.petApi.runPreset(preset.name);
      closeMenu();
    });
    presetList.append(button);
  }
  if (focusFirst || keepItemFocus) {
    const buttons = Array.from(presetList.querySelectorAll<HTMLButtonElement>("button"));
    const index = focusFirst
      ? 0
      : Math.min(lastActionIndices[0], Math.max(0, buttons.length - 1));
    buttons[index]?.focus();
  }
}

presetSearch.addEventListener("input", () => renderPresets(allPresets, true));

async function loadMenu(): Promise<void> {
  const [settings, animations, presets] = await Promise.all([
    window.petApi.getSettings(),
    window.petApi.getAnimations(),
    window.petApi.getPresets(),
  ]);
  renderControls(settings);
  renderAnimations(animations, settings.animation, settings.animationMode);
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
window.petApi.onMenuUpdated(() => void loadMenu());
window.petApi.onMenuFocusChanged(updateFocusState);
updateFocusState(document.hasFocus());

for (const [index, tab] of sectionTabs.entries()) {
  tab.addEventListener("click", () => showSection(index));
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    rememberCurrentAction();
    showSection(activeSection + (event.shiftKey ? -1 : 1));
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
    if (event.key === "Backspace" && presetSearch.value) {
      rememberCurrentAction();
      presetSearch.value = presetSearch.value.slice(0, -1);
      renderPresets(allPresets, true);
      event.preventDefault();
      return;
    }
  }

  const section = document.getElementById(sectionIds[activeSection]);
  const buttons = Array.from(section?.querySelectorAll("button") ?? []);
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (activeSection === 0 && document.activeElement === presetSearch) {
      if (event.key === "ArrowDown") buttons[0]?.focus();
      return;
    }
    if (buttons.length === 0) return;
    if (activeSection === 0 && event.key === "ArrowUp" && currentIndex === 0) {
      presetSearch.focus();
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
    lastActionIndices[activeSection] = nextIndex;
    buttons[nextIndex].focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
  }
});
