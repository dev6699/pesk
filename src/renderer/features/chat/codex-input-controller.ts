import { matchesShortcut } from "../../shared/shortcuts.js";
import { CodexAttachmentRenderer } from "./codex-attachments-renderer.js";
import { CodexSuggestionRenderer } from "./codex-suggestions-renderer.js";

interface CodexInputControllerCallbacks {
  getState(): RendererState;
  updateState(next: RendererState): void;
  openReviewPrompt(): void;
  openProjectManager(): void;
  openNewThreadPrompt(): void;
  renderUserInput(force: boolean): void;
  scrollHistoryToLatest(force?: boolean): void;
  isHistoryNearBottom(): boolean;
}

/**
 * Owns the main Codex prompt input and its composer behavior.
 *
 * This controller is shared by the Electron and browser chat entry points.
 * It keeps transient prompt-history state local to the running composer and
 * delegates application state changes back to CodexRenderer.
 */
export class CodexInputController {
  private static readonly promptHistoryLimit = 100;
  private readonly promptHistory: string[] = [];
  private promptHistoryIndex = -1;
  private promptHistoryDraft: string | undefined;

  constructor(
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    private readonly history: HTMLElement,
    private readonly webChat: boolean,
    private readonly steerButton: HTMLButtonElement | undefined,
    private readonly commandMode: HTMLElement | undefined,
    private readonly attachmentRenderer: CodexAttachmentRenderer,
    private readonly suggestionRenderer: CodexSuggestionRenderer,
    private readonly callbacks: CodexInputControllerCallbacks,
  ) {}

  /** Installs form, textarea, steering, and browser viewport listeners. */
  setup(): void {
    this.steerButton?.addEventListener("click", () => {
      const prompt = this.input.value.trim();
      if (!prompt) return;
      void window.peskApi
        .steerCodexTurn(prompt)
        .then((next) => {
          this.input.value = "";
          this.resize();
          this.callbacks.updateState(next);
          this.input.focus();
        })
        .catch((error: unknown) => console.error("Failed to steer Codex turn", error));
    });
    this.form.addEventListener("submit", (event) => {
      void this.submit(event).catch((error: unknown) =>
        console.error("Failed to submit Codex prompt", error),
      );
    });
    this.input.addEventListener("input", () => {
      this.resetPromptHistoryNavigation();
      this.resize();
      this.renderCommandMode();
      void this.updateSuggestions(this.input);
    });
    this.input.addEventListener("keydown", (event) => this.handleInputKeydown(event));
    this.setupWebChatViewport();
  }

  /** Focuses the textarea after the current layout pass. */
  focusInput(): void {
    requestAnimationFrame(() => this.input.focus());
  }

  /** Requests native focus before focusing the textarea. */
  focusChatInput(): void {
    window.peskApi.focusCodexInput();
    this.focusInput();
  }

  /** Replaces the composer text from a message-history action. */
  setInputValue(value: string): void {
    this.input.value = value;
    this.resetPromptHistoryNavigation();
    this.resize();
  }

  /** Resizes the textarea while preserving history bottom anchoring. */
  resize(): void {
    const maxHeight = 220;
    const previousHistoryClientHeight = this.history.clientHeight;
    const wasNearBottom = this.callbacks.isHistoryNearBottom();
    this.input.style.height = "auto";
    const height = Math.min(this.input.scrollHeight, maxHeight);
    this.input.style.height = `${height}px`;
    this.input.style.overflowY = this.input.scrollHeight > maxHeight ? "auto" : "hidden";
    if (wasNearBottom && this.history.clientHeight !== previousHistoryClientHeight) {
      this.callbacks.scrollHistoryToLatest(false);
    }
  }

  /** Renders the shell or sandbox execution indicator for the current text. */
  renderCommandMode(): void {
    if (!this.commandMode) return;
    const value = this.input.value.trimStart();
    if (value.startsWith("!")) {
      this.commandMode.hidden = false;
      this.commandMode.textContent = "Shell · full access";
      this.commandMode.dataset.mode = "shell";
    } else if (/^\/exec(?:\s|$)/i.test(value)) {
      this.commandMode.hidden = false;
      this.commandMode.textContent = "Exec · sandboxed";
      this.commandMode.dataset.mode = "exec";
    } else {
      this.commandMode.hidden = true;
      this.commandMode.textContent = "";
      delete this.commandMode.dataset.mode;
    }
  }

  /** Reports whether the suggestion renderer currently has choices to show. */
  hasSuggestions(): boolean {
    return this.suggestionRenderer.hasSuggestions();
  }

  /** Refreshes file or slash-command suggestions for a textarea. */
  updateSuggestions(input: HTMLTextAreaElement, allowCommands = true): Promise<void> {
    return this.suggestionRenderer.updateSuggestions(input, allowCommands);
  }

  /** Handles keyboard navigation and selection within the suggestion list. */
  handleSuggestionKeydown(event: KeyboardEvent): boolean {
    return this.suggestionRenderer.handleSuggestionKeydown(event);
  }

  /** Hides any active file or slash-command suggestions. */
  hideSuggestions(): void {
    this.suggestionRenderer.hide();
  }

  /** Submits a prompt, local command, review request, or image attachment. */
  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const prompt = this.input.value.trim();
    if (/^\/project$/i.test(prompt)) {
      this.rememberPrompt(prompt);
      this.input.value = "";
      this.hideSuggestions();
      this.resize();
      this.callbacks.openProjectManager();
      this.input.focus();
      return;
    }
    if (/^\/new(?:\s+.*)?$/i.test(prompt)) {
      this.rememberPrompt(prompt);
      this.input.value = "";
      this.hideSuggestions();
      this.resize();
      this.callbacks.openNewThreadPrompt();
      this.input.focus();
      return;
    }
    if (this.hasSuggestions()) {
      this.suggestionRenderer.selectCurrent();
      return;
    }
    if (!prompt && !this.attachmentRenderer.images.length) return;
    const state = this.callbacks.getState();
    if (state.codex.readOnly) return;
    if (/^\/review$/i.test(prompt)) {
      if (state.codex.status !== "idle" || !state.codex.threadId) return;
      this.rememberPrompt(prompt);
      this.input.value = "";
      this.hideSuggestions();
      this.resize();
      this.callbacks.openReviewPrompt();
      this.form.hidden = true;
      this.callbacks.renderUserInput(true);
      return;
    }
    this.rememberPrompt(prompt);
    if (this.webChat) this.input.focus();
    const images = this.attachmentRenderer.images;
    const next = images.length
      ? await window.peskApi.submitCodexPrompt(prompt, images)
      : await window.peskApi.submitCodexPrompt(prompt);
    this.input.value = "";
    this.resetPromptHistoryNavigation();
    this.attachmentRenderer.clear();
    this.resize();
    this.renderCommandMode();
    this.callbacks.updateState(next);
    this.input.focus();
  }

  /** Handles textarea editing, submission, steering, and history shortcuts. */
  private handleInputKeydown(event: KeyboardEvent): void {
    if (this.handleSuggestionKeydown(event)) return;
    if (this.handlePromptHistoryKeydown(event)) return;
    const state = this.callbacks.getState();
    if (
      matchesShortcut(event, "interrupt") &&
      (state.codex.status === "working" || state.codex.status === "waiting")
    ) {
      event.preventDefault();
      void window.peskApi.interruptCodexTurn();
      return;
    }
    if (event.key !== "Enter") return;
    if (this.webChat && matchesShortcut(event, "submit")) {
      event.preventDefault();
      this.insertNewline();
      return;
    }
    if (matchesShortcut(event, "newline")) {
      event.preventDefault();
      this.insertNewline();
    } else if (event.shiftKey) {
      event.preventDefault();
    } else if (matchesShortcut(event, "submit")) {
      event.preventDefault();
      this.form.requestSubmit();
    } else if (matchesShortcut(event, "steer")) {
      event.preventDefault();
      const prompt = this.input.value.trim();
      if (
        prompt &&
        (state.codex.status === "working" || state.codex.status === "waiting") &&
        state.codex.threadId
      ) {
        void window.peskApi.steerCodexTurn(prompt).then((next) => {
          this.input.value = "";
          this.resize();
          this.callbacks.updateState(next);
        });
      } else {
        this.form.requestSubmit();
      }
    }
  }

  /** Inserts a newline at the current selection. */
  private insertNewline(): void {
    const start = this.input.selectionStart;
    const end = this.input.selectionEnd;
    this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
    this.input.selectionStart = start + 1;
    this.input.selectionEnd = start + 1;
    this.resize();
  }

  /** Gives prompt history control of unmodified arrows at text boundaries. */
  private handlePromptHistoryKeydown(event: KeyboardEvent): boolean {
    if (
      matchesShortcut(event, "promptHistoryPrevious") &&
      this.isAtPromptHistoryBoundary("previous")
    ) {
      event.preventDefault();
      this.navigatePromptHistory(-1);
      return true;
    }
    if (matchesShortcut(event, "promptHistoryNext") && this.isAtPromptHistoryBoundary("next")) {
      event.preventDefault();
      this.navigatePromptHistory(1);
      return true;
    }
    return false;
  }

  /** Checks whether the caret is on the first or last logical text line. */
  private isAtPromptHistoryBoundary(direction: "previous" | "next"): boolean {
    if (this.input.selectionStart !== this.input.selectionEnd) return false;
    const caret = this.input.selectionStart ?? 0;
    return direction === "previous"
      ? caret === 0 || !this.input.value.slice(0, caret).includes("\n")
      : caret === this.input.value.length || !this.input.value.slice(caret).includes("\n");
  }

  /** Moves through history, preserving and restoring the unsent draft. */
  private navigatePromptHistory(direction: -1 | 1): void {
    if (!this.promptHistory.length) return;
    if (this.promptHistoryIndex < 0) {
      if (direction > 0) return;
      this.promptHistoryDraft = this.input.value;
      this.promptHistoryIndex = this.promptHistory.length - 1;
    } else {
      const nextIndex = this.promptHistoryIndex + direction;
      if (nextIndex < 0) {
        this.promptHistoryIndex = 0;
      } else if (nextIndex >= this.promptHistory.length) {
        this.setPromptInput(this.promptHistoryDraft ?? "");
        this.resetPromptHistoryNavigation();
        return;
      } else {
        this.promptHistoryIndex = nextIndex;
      }
    }
    this.setPromptInput(this.promptHistory[this.promptHistoryIndex] ?? "");
  }

  /** Applies recalled text without reopening the suggestion picker. */
  private setPromptInput(value: string): void {
    this.input.value = value;
    this.input.setSelectionRange(value.length, value.length);
    this.resize();
    this.renderCommandMode();
    this.hideSuggestions();
  }

  /** Leaves history navigation mode after editing or submitting text. */
  private resetPromptHistoryNavigation(): void {
    this.promptHistoryIndex = -1;
    this.promptHistoryDraft = undefined;
  }

  /** Records an accepted prompt, suppressing consecutive duplicates. */
  private rememberPrompt(prompt: string): void {
    if (!prompt || this.promptHistory.at(-1) === prompt) {
      this.resetPromptHistoryNavigation();
      return;
    }
    this.promptHistory.push(prompt);
    if (this.promptHistory.length > CodexInputController.promptHistoryLimit) {
      this.promptHistory.shift();
    }
    this.resetPromptHistoryNavigation();
  }

  /** Keeps the mobile browser composer visible when the viewport changes. */
  private setupWebChatViewport(): void {
    if (!this.webChat) return;
    const visualViewport = window.visualViewport;
    const keepFormVisible = (): void => {
      if (visualViewport && Number.isFinite(visualViewport.height)) {
        document.documentElement.style.setProperty(
          "--web-chat-viewport-height",
          `${visualViewport.height}px`,
        );
      }
    };
    this.input.addEventListener("focus", keepFormVisible);
    visualViewport?.addEventListener("resize", keepFormVisible);
    const removeListeners = (): void => {
      this.input.removeEventListener("focus", keepFormVisible);
      visualViewport?.removeEventListener("resize", keepFormVisible);
      window.removeEventListener("pagehide", removeListeners);
      document.documentElement.style.removeProperty("--web-chat-viewport-height");
    };
    window.addEventListener("pagehide", removeListeners, { once: true });
  }
}
