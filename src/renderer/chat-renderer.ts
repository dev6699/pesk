import { CodexRenderer } from "./codex-renderer.js";
import { defaultSettings } from "./default-settings.js";

const codex = new CodexRenderer(
  document.getElementById("codex-chat") as HTMLElement,
  document.getElementById("codex-session-select") as HTMLSelectElement,
  document.getElementById("codex-session-copy") as HTMLButtonElement,
  document.getElementById("codex-error") as HTMLElement,
  document.getElementById("codex-history") as HTMLElement,
  document.getElementById("codex-working-status") as HTMLElement,
  document.getElementById("codex-working-elapsed") as HTMLElement,
  document.getElementById("codex-token-usage") as HTMLElement,
  document.getElementById("codex-chat-form") as HTMLFormElement,
  document.getElementById("codex-chat-input") as HTMLTextAreaElement,
  defaultSettings(),
  document.getElementById("codex-rate-limit") as HTMLElement,
  document.getElementById("codex-file-suggestions") as HTMLElement,
  document.getElementById("codex-mode-toggle") as HTMLButtonElement,
  document.getElementById("codex-user-input") as HTMLElement,
);

if (document.body.classList.contains("web-chat")) {
  requestAnimationFrame(() => {
    if (
      document.activeElement === document.body ||
      document.activeElement === document.documentElement
    ) {
      codex.focusInput();
    }
  });
}

const interruptButton = document.getElementById(
  "codex-chat-interrupt",
) as HTMLButtonElement | null;
function updateInterruptButton(settings: PeskSettings): void {
  if (!interruptButton) return;
  interruptButton.disabled =
    settings.codexStatus !== "working" && settings.codexStatus !== "waiting";
}
interruptButton?.addEventListener("click", () => {
  if (!confirm("Interrupt the current Codex turn?")) return;
  void window.peskApi.interruptCodexTurn();
});

document.addEventListener(
  "keydown",
  (event) => codex.handleKeydown(event),
  true,
);
window.peskApi.onSettingsChanged((next) => {
  codex.updateSettings(next);
  updateInterruptButton(next);
  if (next.codexConnected && !next.codexRateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
window.peskApi.onCodexInputFocus(() => codex.focusInput());
window.peskApi.onCodexUserInputFocus(() => codex.focusUserInputOption());

void window.peskApi.getChatSize().then(({ width, height }) => {
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  document.documentElement.style.setProperty("--chat-height", `${height}px`);
});

void window.peskApi.getSettings().then((next) => {
  codex.updateSettings(next);
  updateInterruptButton(next);
  if (next.codexConnected && !next.codexRateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
