import { CodexRenderer } from "./codex-renderer.js";
import { defaultRendererState } from "../../shared/default-settings.js";
import { matchesShortcut } from "../../shared/shortcuts.js";
import { applyRendererTheme } from "../../shared/theme.js";

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
  defaultRendererState(),
  document.getElementById("codex-rate-limit") as HTMLElement,
  document.getElementById("codex-file-suggestions") as HTMLElement,
  document.getElementById("codex-mode-toggle") as HTMLElement,
  document.getElementById("codex-user-input") as HTMLElement,
  document.getElementById("codex-chat-steer") as HTMLButtonElement,
  document.getElementById("codex-command-mode") as HTMLElement,
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

const interruptButton = document.getElementById("codex-chat-interrupt") as HTMLButtonElement | null;
function updateInterruptButton(state: RendererState): void {
  if (!interruptButton) return;
  const active = state.codex.status === "working" || state.codex.status === "waiting";
  interruptButton.hidden = !active;
  interruptButton.disabled = !active;
}
interruptButton?.addEventListener("click", () => {
  if (!confirm("Interrupt the current Codex turn?")) return;
  void window.peskApi.interruptCodexTurn();
});

document.addEventListener("keydown", (event) => codex.handleKeydown(event), true);
document.addEventListener("keydown", (event) => {
  if (matchesShortcut(event, "unfocusChat") && !event.defaultPrevented) {
    event.preventDefault();
    window.peskApi.unfocusPesk();
  }
});
window.peskApi.onSettingsChanged((next) => {
  applyRendererTheme(next.assets.theme);
  codex.updateState(next);
  updateInterruptButton(next);
  if (next.codex.connected && !next.codex.rateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
window.peskApi.onCodexStreamDelta((delta) => codex.applyStreamDelta(delta));
window.peskApi.onCodexInputFocus(() => codex.focusInput());
window.peskApi.onCodexUserInputFocus(() => codex.focusUserInputOption());

void window.peskApi.getChatSize().then(({ width, height }) => {
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  document.documentElement.style.setProperty("--chat-height", `${height}px`);
});

void window.peskApi.getSettings().then((next) => {
  applyRendererTheme(next.assets.theme);
  codex.updateState(next);
  updateInterruptButton(next);
  if (next.codex.connected && !next.codex.rateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
