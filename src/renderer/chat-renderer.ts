import { CodexRenderer } from "./codex-renderer.js";
import { defaultSettings } from "./default-settings.js";

const codex = new CodexRenderer(
  document.getElementById("codex-chat") as HTMLElement,
  document.getElementById("codex-session-select") as HTMLSelectElement,
  document.getElementById("codex-error") as HTMLElement,
  document.getElementById("codex-history") as HTMLElement,
  document.getElementById("codex-working-status") as HTMLElement,
  document.getElementById("codex-working-elapsed") as HTMLElement,
  document.getElementById("codex-chat-form") as HTMLFormElement,
  document.getElementById("codex-chat-input") as HTMLTextAreaElement,
  defaultSettings(),
);

document.addEventListener("keydown", (event) => codex.handleKeydown(event));
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    window.peskApi.toggleCodexChat();
  }
});
window.peskApi.onSettingsChanged((next) => codex.updateSettings(next));
window.peskApi.onPetFocusChanged((focused) => codex.updateFocus(focused));
window.peskApi.onCodexChatVisibility((visible) => codex.setVisibility(visible));
window.peskApi.onCodexInputFocus(() => codex.focusInput());
window.addEventListener("focus", () => codex.updateFocus(true));
window.addEventListener("blur", () => codex.updateFocus(false));

void window.peskApi.getChatSize().then(({ width, height }) => {
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  document.documentElement.style.setProperty("--chat-height", `${height}px`);
});

void window.peskApi.getSettings().then((next) => codex.updateSettings(next));
