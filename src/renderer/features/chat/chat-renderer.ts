import { CodexRenderer } from "./codex-renderer.js";
import { defaultRendererState } from "../../shared/default-settings.js";
import { matchesShortcut } from "../../shared/shortcuts.js";
import { setupRtermRenderer } from "./rterm-renderer.js";
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

const chatLockButton = document.getElementById("codex-chat-lock") as HTMLButtonElement | null;
if (chatLockButton) {
  const button = chatLockButton;
  function updateChatLockIndicator(locked: boolean): void {
    button.textContent = locked ? "🔒" : "🔓";
    button.setAttribute("aria-label", locked ? "Unlock chat window" : "Lock chat window");
    button.title = locked
      ? "Allow chat to hide when it loses focus (Ctrl+Shift+L)"
      : "Keep chat visible when it loses focus (Ctrl+Shift+L)";
    button.classList.toggle("chat-lock-active", locked);
  }
  button.addEventListener("click", () => window.peskApi.toggleChatLock());
  window.peskApi.onChatLockChanged(updateChatLockIndicator);
  void window.peskApi.getChatLock().then(updateChatLockIndicator);
}

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
  const active =
    state.codex.threads.current.thread.status === "working" ||
    state.codex.threads.current.thread.status === "waiting";
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
  rtermRenderer?.setThread(next.codex.threads.selectedId);
  updateInterruptButton(next);
  if (next.codex.threads.current.thread.connected && !next.codex.account.rateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
window.peskApi.onCodexStreamDelta((delta) => codex.applyStreamDelta(delta));
const rtermRenderer = setupRtermRenderer();
window.peskApi.onCodexInputFocus(() => codex.focusInput());
window.peskApi.onCodexUserInputFocus(() => codex.focusUserInputOption());

void window.peskApi.getChatSize().then(({ width, height }) => {
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  document.documentElement.style.setProperty("--chat-height", `${height}px`);
});

void window.peskApi.getSettings().then((next) => {
  applyRendererTheme(next.assets.theme);
  codex.updateState(next);
  rtermRenderer?.setThread(next.codex.threads.selectedId);
  updateInterruptButton(next);
  if (next.codex.threads.current.thread.connected && !next.codex.account.rateLimits) {
    void window.peskApi.refreshCodexRateLimits();
  }
});
