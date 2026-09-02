import { matchesShortcut } from "../../shared/shortcuts.js";
import { CodexAttachmentRenderer } from "./codex-attachments-renderer.js";
import { CodexHistoryRenderer } from "./codex-history-renderer.js";
import { CodexInputController } from "./codex-input-controller.js";
import { CodexPromptRenderer } from "./codex-prompt-renderer.js";
import { CodexStatusRenderer } from "./codex-status-renderer.js";
import { CodexSuggestionRenderer } from "./codex-suggestions-renderer.js";
import { formatElapsed, formatRateLimitDetails, formatTokens } from "./codex-renderer-helpers.js";

export class CodexRenderer {
  private readonly webChat = document.body.classList.contains("web-chat");
  private state: RendererState;
  private selectedMessageIndex = -1;
  private readonly rateLimit: HTMLElement;
  private readonly goal: HTMLElement;
  private readonly commandNotice: HTMLElement;
  private readonly statusDock?: HTMLElement;
  private readonly fileSuggestions: HTMLElement;
  private readonly suggestionRenderer: CodexSuggestionRenderer;
  private readonly promptRenderer: CodexPromptRenderer;
  private sessionNavigationIds: string[] = [];
  private renderedSessionOptionsKey = "";
  private pendingSessionId: string | undefined;
  private readonly dismissedPlanConfirmations = new Set<string>();
  private activePlanConfirmation: { key: string; planText: string } | undefined;
  private readonly imageAttachments = document.getElementById("codex-image-attachments");
  private readonly imageInput = document.getElementById(
    "codex-image-input",
  ) as HTMLInputElement | null;
  private readonly readOnlyStatus =
    document.getElementById("codex-read-only") ?? document.createElement("div");
  private readonly statusRenderer: CodexStatusRenderer;
  private readonly attachmentRenderer: CodexAttachmentRenderer;
  private readonly inputController: CodexInputController;
  private readonly historyRenderer: CodexHistoryRenderer;

  /** Creates the renderer and wires chat, history, and composer events. */
  constructor(
    private readonly chat: HTMLElement,
    private readonly sessionSelect: HTMLSelectElement,
    private readonly sessionCopy: HTMLButtonElement,
    private readonly error: HTMLElement,
    private readonly history: HTMLElement,
    workingStatus: HTMLElement,
    workingElapsed: HTMLElement,
    private readonly tokenUsage: HTMLElement,
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    state: RendererState,
    rateLimit?: HTMLElement,
    fileSuggestions?: HTMLElement,
    private readonly modeToggle?: HTMLElement,
    private readonly userInput?: HTMLElement,
    private readonly steerButton?: HTMLButtonElement,
    private readonly commandMode?: HTMLElement,
  ) {
    this.state = state;
    this.rateLimit = rateLimit ?? document.createElement("div");
    this.goal = document.getElementById("codex-goal") ?? document.createElement("div");
    this.commandNotice =
      document.getElementById("codex-command-notice") ?? document.createElement("div");
    this.statusDock = document.getElementById("codex-status-dock") ?? undefined;
    this.fileSuggestions = fileSuggestions ?? document.createElement("div");
    this.suggestionRenderer = new CodexSuggestionRenderer(
      input,
      this.fileSuggestions,
      () => this.state.codex.cwd,
      () => this.inputController.resize(),
      () => this.inputController.renderCommandMode(),
    );
    this.historyRenderer = new CodexHistoryRenderer(this.history, () => this.state, {
      scrollHistoryToBottom: () => this.scrollHistoryToBottom(),
      applySelectedMessage: () => this.applySelectedMessage(),
      setActivePlanConfirmation: (value) => {
        this.activePlanConfirmation = value;
      },
      isPlanConfirmationDismissed: (activityKey) =>
        this.dismissedPlanConfirmations.has(activityKey),
    });
    this.attachmentRenderer = new CodexAttachmentRenderer(
      form,
      input,
      this.imageInput,
      this.imageAttachments,
    );
    this.inputController = new CodexInputController(
      form,
      input,
      this.history,
      this.webChat,
      steerButton,
      commandMode,
      this.attachmentRenderer,
      this.suggestionRenderer,
      {
        getState: () => this.state,
        updateState: (next) => this.updateState(next),
        openReviewPrompt: () => this.promptRenderer.openReviewPrompt(),
        renderUserInput: (force) => this.renderUserInput(force),
      },
    );
    this.promptRenderer = new CodexPromptRenderer(
      userInput,
      this.history,
      form,
      this.fileSuggestions,
      input,
      this.webChat,
      () => this.state,
      () => this.activePlanConfirmation,
      this.inputController,
      {
        updateState: (next) => this.updateState(next),
        renderPlanImplementationPrompt: (activityKey, planText) =>
          this.renderPlanImplementationPrompt(activityKey, planText),
      },
    );
    this.statusRenderer = new CodexStatusRenderer(
      workingStatus,
      workingElapsed,
      this.statusDock,
      this.commandNotice,
      () => this.state,
    );
    this.statusRenderer.update();
    this.inputController.setup();
    this.inputController.renderCommandMode();
    this.setupSessionControls();
    this.setupHistoryControls();
    this.setupComposerControls();
    this.inputController.resize();
  }

  /** Wires session selection and session-copy controls. */
  private setupSessionControls(): void {
    this.sessionSelect.addEventListener("change", () => {
      if (this.sessionSelect.value) window.peskApi.selectCodexThread(this.sessionSelect.value);
    });
    this.sessionCopy.addEventListener("click", () => void this.copySessionId());
  }

  /** Wires history scrolling and older-history pagination. */
  private setupHistoryControls(): void {
    this.history.addEventListener("scroll", () => {
      this.historyRenderer.handleHistoryScroll();
      this.updateVirtualHistoryWindow();
      if (
        this.state.codex.hasOlderHistory &&
        !this.state.codex.historyLoading &&
        this.history.scrollTop <= 48
      ) {
        void this.loadOlderHistory();
      }
    });
    this.history.addEventListener("wheel", () => this.historyRenderer.noteManualScroll());
    this.history.addEventListener("touchstart", () => this.historyRenderer.noteManualScroll());
  }

  /** Wires chat-level pointer handling and attachment input. */
  private setupComposerControls(): void {
    this.chat.addEventListener("mousedown", (event) => event.stopPropagation());
    this.chat.addEventListener("wheel", (event) => event.stopPropagation());
    this.attachmentRenderer.setup();
  }

  /** Applies renderer state and refreshes all visible chat controls. */
  updateState(next: RendererState): void {
    const resolvedUserInput =
      Boolean(this.state.codex.pendingUserInput) && !next.codex.pendingUserInput;
    if (next.codex.threadId !== this.state.codex.threadId) {
      this.historyRenderer.reset();
    }
    this.state = next;
    const displayedThreads = [...next.codex.threads];
    if (
      next.codex.threadId &&
      !displayedThreads.some((thread) => thread.id === next.codex.threadId)
    ) {
      displayedThreads.unshift({ id: next.codex.threadId });
    }
    const threadIds = new Set(displayedThreads.map((thread) => thread.id));
    const existingNavigationIds = new Set(this.sessionNavigationIds);
    const newThreadIds = displayedThreads
      .map((thread) => thread.id)
      .filter((id) => !existingNavigationIds.has(id));
    this.sessionNavigationIds = [
      ...newThreadIds,
      ...this.sessionNavigationIds.filter((id) => threadIds.has(id)),
    ];
    if (next.codex.threadId === this.pendingSessionId) {
      this.pendingSessionId = undefined;
    }
    this.error.hidden = !next.codex.error;
    this.error.textContent = next.codex.error ? "Codex connection error." : "";
    const sessionOptionsKey = displayedThreads
      .map((thread) => `${thread.id}\u0000${thread.preview ?? ""}`)
      .join("\u0001");
    if (sessionOptionsKey !== this.renderedSessionOptionsKey) {
      this.renderedSessionOptionsKey = sessionOptionsKey;
      this.sessionSelect.replaceChildren();
      if (!displayedThreads.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No active session";
        this.sessionSelect.append(option);
      } else {
        for (const thread of displayedThreads) {
          const option = document.createElement("option");
          option.value = thread.id;
          option.textContent = thread.preview ? `${thread.id} — ${thread.preview}` : thread.id;
          option.title = thread.id;
          this.sessionSelect.append(option);
        }
      }
    }
    this.sessionSelect.value = next.codex.threadId ?? "";
    this.sessionSelect.disabled = !displayedThreads.length;
    this.sessionCopy.disabled = !next.codex.threadId;
    this.renderHistory(
      next.codex.history,
      Boolean(next.codex.threadId),
      next.codex.historyLoading,
      next.codex.queuedSubmissions,
    );
    this.statusRenderer.update();
    this.inputController.renderCommandMode();
    this.renderTokenUsage();
    this.renderRateLimit();
    this.renderGoal();
    this.renderUserInput();
    if (resolvedUserInput && !next.codex.pendingApproval) {
      this.inputController.focusChatInput();
    }
    const steerable =
      !next.codex.readOnly && (next.codex.status === "working" || next.codex.status === "waiting");
    if (this.steerButton) {
      this.steerButton.hidden = !steerable;
      this.steerButton.disabled = !steerable;
    }
    this.readOnlyStatus.hidden = !next.codex.readOnly;
    this.readOnlyStatus.textContent = next.codex.readOnly ? "Read-only · active elsewhere" : "";
    this.input.disabled = next.codex.readOnly;
    const sendButton = this.form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (sendButton) sendButton.disabled = next.codex.readOnly;
    this.form.hidden = Boolean(
      next.codex.pendingUserInput ||
      next.codex.pendingApproval ||
      this.activePlanConfirmation ||
      this.promptRenderer.isReviewPromptOpen,
    );
    if (this.modeToggle) {
      const plan = next.codex.collaborationMode === "plan";
      this.modeToggle.hidden = !plan;
      this.modeToggle.textContent = plan ? "Plan" : "Default";
      this.modeToggle.classList.toggle("codex-mode-plan", plan);
      this.modeToggle.title = plan ? "Plan mode enabled for the next turn" : "Default mode";
    }
  }

  /** Applies an incremental Codex stream update to the active history. */
  applyStreamDelta(delta: CodexStreamDelta): void {
    this.historyRenderer.applyStreamDelta(delta);
  }

  /** Focuses the main prompt input on the next animation frame. */
  focusInput(): void {
    this.inputController.focusInput();
  }

  /** Focuses the currently available user-input choice. */
  focusUserInputOption(): void {
    this.promptRenderer.focusUserInputOption();
  }

  /** Handles global chat shortcuts and keyboard navigation. */
  handleKeydown(event: KeyboardEvent): void {
    if (
      !this.chat.hidden &&
      (matchesShortcut(event, "sessionPrevious") || matchesShortcut(event, "sessionNext"))
    ) {
      const direction = matchesShortcut(event, "sessionPrevious") ? -1 : 1;
      if (this.switchSession(direction)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!this.userInput?.hidden && matchesShortcut(event, "focusUserInput")) {
      event.preventDefault();
      this.focusUserInputOption();
      return;
    }
    if (
      !this.chat.hidden &&
      matchesShortcut(event, "copyMessage") &&
      !(
        event.target === this.input &&
        (this.state.codex.status === "working" || this.state.codex.status === "waiting")
      ) &&
      this.selectedMessageIndex >= 0 &&
      !this.hasHighlightedText()
    ) {
      event.preventDefault();
      void this.copySelectedMessageToClipboard();
      return;
    }
    if (
      !this.chat.hidden &&
      (matchesShortcut(event, "historyTop") || matchesShortcut(event, "historyBottom"))
    ) {
      event.preventDefault();
      this.historyRenderer.noteManualScroll();
      this.history.scrollTo({
        top: matchesShortcut(event, "historyTop") ? 0 : this.history.scrollHeight,
        behavior: "smooth",
      });
      return;
    }
    if (
      !this.chat.hidden &&
      matchesShortcut(event, "copyMessageToInput") &&
      this.copySelectedMessageToInput()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !this.chat.hidden &&
      matchesShortcut(event, "toggleMessage") &&
      this.toggleSelectedMessage()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!this.chat.hidden && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const direction =
        matchesShortcut(event, "selectPreviousUserMessage") ||
        matchesShortcut(event, "scrollHistoryUp") ||
        matchesShortcut(event, "selectPreviousMessage")
          ? -1
          : 1;
      if (
        matchesShortcut(event, "selectPreviousUserMessage") ||
        matchesShortcut(event, "selectNextUserMessage")
      ) {
        event.preventDefault();
        this.selectMessage(direction, "user");
        return;
      }
      if (
        matchesShortcut(event, "scrollHistoryUp") ||
        matchesShortcut(event, "scrollHistoryDown")
      ) {
        event.preventDefault();
        this.historyRenderer.noteManualScroll();
        this.history.scrollBy({
          top: direction * 64,
          behavior: "smooth",
        });
        return;
      }
      if (
        matchesShortcut(event, "selectPreviousMessage") ||
        matchesShortcut(event, "selectNextMessage")
      ) {
        event.preventDefault();
        this.selectMessage(direction);
        return;
      }
    }
    if (this.userInput?.contains(event.target as Node)) return;
  }

  /** Selects the adjacent session in the current navigation order. */
  private switchSession(direction: -1 | 1): boolean {
    const currentId = this.pendingSessionId ?? this.state.codex.threadId;
    const currentIndex = this.sessionNavigationIds.indexOf(currentId ?? "");
    if (currentIndex < 0) return false;
    const nextId = this.sessionNavigationIds[currentIndex + direction];
    if (!nextId) return false;
    this.pendingSessionId = nextId;
    window.peskApi.selectCodexThread(nextId);
    return true;
  }

  /** Loads and anchors the next page of older history messages. */
  private async loadOlderHistory(): Promise<void> {
    if (!this.state.codex.hasOlderHistory || this.state.codex.historyLoading) return;
    const previousHeight = this.history.scrollHeight;
    const previousTop = this.history.scrollTop;
    await window.peskApi.loadOlderCodexHistory();
    requestAnimationFrame(() => {
      const heightDelta = this.history.scrollHeight - previousHeight;
      this.history.scrollTop = previousTop + heightDelta;
    });
  }

  private renderHistory(
    history: RendererState["codex"]["history"],
    sessionConnected = false,
    historyLoading = false,
    queuedSubmissions: RendererState["codex"]["queuedSubmissions"] = [],
  ): void {
    this.historyRenderer.renderHistory(
      history,
      sessionConnected,
      historyLoading,
      queuedSubmissions,
    );
  }

  private updateVirtualHistoryWindow(): void {
    this.historyRenderer.updateVirtualHistoryWindow();
  }

  /** Scrolls history to the bottom after the next layout pass. */
  private scrollHistoryToBottom(): void {
    const scroll = (): void => {
      if (!this.historyRenderer.isAutoScrollAllowed()) return;
      this.history.scrollTop = this.history.scrollHeight;
      requestAnimationFrame(() => {
        if (!this.historyRenderer.isAutoScrollAllowed()) return;
        this.history.scrollTop = this.history.scrollHeight;
      });
    };
    requestAnimationFrame(scroll);
  }

  /** Moves message selection in the requested direction and scope. */
  private selectMessage(
    direction: -1 | 1,
    role?: RendererState["codex"]["history"][number]["role"],
  ): void {
    const messages = Array.from(this.history.querySelectorAll<HTMLElement>(".codex-message"));
    if (!messages.length) return;

    const candidateIndices = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => !role || message.classList.contains(`codex-message-${role}`))
      .map(({ index }) => index);
    if (!candidateIndices.length) return;
    this.input.blur();
    const visibleIndices = this.visibleMessageIndices(messages, candidateIndices);
    const selectionIsVisible = visibleIndices.includes(this.selectedMessageIndex);
    const currentCandidateIndex = candidateIndices.indexOf(this.selectedMessageIndex);
    const nextIndex = selectionIsVisible
      ? candidateIndices[
          Math.max(0, Math.min(candidateIndices.length - 1, currentCandidateIndex + direction))
        ]
      : ((direction < 0 ? visibleIndices[visibleIndices.length - 1] : visibleIndices[0]) ??
        (direction < 0 ? candidateIndices[candidateIndices.length - 1] : candidateIndices[0]));
    this.selectedMessageIndex = nextIndex;
    this.applySelectedMessage();
    messages[nextIndex]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }

  /** Returns selectable history indices matching the requested scope. */
  private visibleMessageIndices(
    messages: HTMLElement[],
    candidateIndices = messages.map((_message, index) => index),
  ): number[] {
    const historyBounds = this.history.getBoundingClientRect();
    return candidateIndices
      .map((index) => ({
        index,
        bounds: messages[index].getBoundingClientRect(),
      }))
      .filter(
        ({ bounds }) => bounds.bottom > historyBounds.top && bounds.top < historyBounds.bottom,
      )
      .map(({ index }) => index);
  }

  /** Applies the selected-message styling and accessibility state. */
  private applySelectedMessage(): void {
    const messages = Array.from(this.history.querySelectorAll<HTMLElement>(".codex-message"));
    messages.forEach((message, index) => {
      const selected = index === this.selectedMessageIndex;
      message.classList.toggle("codex-message-selected", selected);
      message.setAttribute("aria-selected", String(selected));
    });
  }

  /** Toggles the selected activity or message details. */
  private toggleSelectedMessage(): boolean {
    if (this.selectedMessageIndex < 0) return false;
    const message =
      this.history.querySelectorAll<HTMLElement>(".codex-message")[this.selectedMessageIndex];
    const details = message?.querySelector<HTMLDetailsElement>("details");
    if (!details) return false;
    details.open = !details.open;
    return true;
  }

  /** Returns the text represented by the current message selection. */
  private selectedMessageText(): string | undefined {
    if (this.selectedMessageIndex < 0) return undefined;
    const message =
      this.history.querySelectorAll<HTMLElement>(".codex-message")[this.selectedMessageIndex];
    if (!message) return undefined;
    const content = message.cloneNode(true) as HTMLElement;
    content
      .querySelectorAll(".codex-message-time, .codex-approval-actions")
      .forEach((element) => element.remove());
    return content.textContent?.trim() || undefined;
  }

  /** Copies the selected user message into the composer. */
  private copySelectedMessageToInput(): boolean {
    const text = this.selectedMessageText();
    if (!text) return false;
    this.inputController.setInputValue(text);
    this.inputController.focusInput();
    return true;
  }

  /** Copies the selected message text to the clipboard. */
  private async copySelectedMessageToClipboard(): Promise<void> {
    const text = this.selectedMessageText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const copyTarget = document.createElement("textarea");
      copyTarget.value = text;
      copyTarget.style.position = "fixed";
      copyTarget.style.opacity = "0";
      document.body.append(copyTarget);
      copyTarget.select();
      document.execCommand("copy");
      copyTarget.remove();
    }
  }

  /** Reports whether the document currently contains selected text. */
  private hasHighlightedText(): boolean {
    if (
      (document.activeElement === this.input ||
        document.activeElement instanceof HTMLInputElement) &&
      this.input.selectionStart !== null &&
      this.input.selectionEnd !== null &&
      this.input.selectionStart !== this.input.selectionEnd
    ) {
      return true;
    }
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString());
  }

  /** Copies the active session identifier to the clipboard. */
  private async copySessionId(): Promise<void> {
    const sessionId = this.sessionSelect.value;
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch {
      const copyTarget = document.createElement("textarea");
      copyTarget.value = sessionId;
      copyTarget.style.position = "fixed";
      copyTarget.style.opacity = "0";
      document.body.append(copyTarget);
      copyTarget.select();
      document.execCommand("copy");
      copyTarget.remove();
    }
    const originalLabel = this.sessionCopy.textContent;
    this.sessionCopy.textContent = "Copied";
    window.setTimeout(() => {
      this.sessionCopy.textContent = originalLabel ?? "Copy";
    }, 1200);
  }

  private renderUserInput(force = false): void {
    this.promptRenderer.render(force);
  }

  /** Creates the implementation prompt for a completed plan activity. */
  private renderPlanImplementationPrompt(activityKey: string, planText: string): HTMLElement {
    const prompt = document.createElement("section");
    prompt.className = "codex-plan-implementation-prompt";
    prompt.dataset.planConfirmationKey = activityKey;

    const title = document.createElement("strong");
    title.textContent = "Implement this plan?";
    prompt.append(title);

    const form = document.createElement("form");
    const choices = [
      ["implement", "Yes, implement this plan", "Switch to Default and start coding."],
      [
        "clear-context",
        "Yes, clear context and implement",
        "Fresh thread. The completed plan will be included.",
      ],
      ["stay-plan", "No, stay in Plan mode", "Continue planning with the model."],
    ] as const;
    for (const [value, labelText, descriptionText] of choices) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `plan-confirmation-${activityKey}`;
      input.value = value;
      input.checked = value === "implement";
      label.append(input, document.createTextNode(` ${labelText}`));
      const description = document.createElement("small");
      description.textContent = descriptionText;
      label.append(description);
      form.append(label);
    }
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>("input[type='radio']:checked")?.value;
      if (!selected) return;
      this.dismissedPlanConfirmations.add(activityKey);
      if (selected === "stay-plan") {
        this.renderHistory(this.state.codex.history, Boolean(this.state.codex.threadId));
        this.renderUserInput();
        this.form.hidden = false;
        this.inputController.focusChatInput();
        return;
      }
      submit.disabled = true;
      const implementation = window.peskApi.implementCodexPlan(
        planText,
        selected === "clear-context",
      );
      void implementation.then((next) => {
        this.updateState(next);
        this.inputController.focusChatInput();
        this.renderHistory(this.state.codex.history, Boolean(this.state.codex.threadId));
      });
    });
    prompt.append(form);
    requestAnimationFrame(() => {
      form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
    });
    return prompt;
  }

  /** Renders the current goal summary and controls. */
  private renderGoal(): void {
    const goal = this.state.codex.goal;
    if (!goal) {
      this.goal.hidden = true;
      this.goal.textContent = "";
      this.goal.removeAttribute("data-goal-status");
      return;
    }
    const budget =
      goal.tokenBudget === null ? "no budget" : `${formatTokens(goal.tokenBudget)} budget`;
    this.goal.textContent = `Goal · ${goal.status} · ${goal.objective} · ${formatTokens(goal.tokensUsed)} used · ${budget} · ${formatElapsed(goal.timeUsedSeconds * 1000)}`;
    this.goal.dataset.goalStatus = goal.status;
    this.goal.hidden = false;
  }

  /** Renders the current token usage summary. */
  private renderTokenUsage(): void {
    if (!this.state.codex.threadId) {
      this.tokenUsage.hidden = true;
      this.tokenUsage.textContent = "";
      this.tokenUsage.removeAttribute("title");
      return;
    }
    const usage = this.state.codex.tokenUsage;
    const modelInfo = this.state.codex.modelInfo;
    if (!usage && !modelInfo) {
      this.tokenUsage.hidden = true;
      this.tokenUsage.textContent = "";
      return;
    }
    const total = usage?.total.totalTokens;
    const currentContext = usage?.last?.inputTokens;
    const context = usage?.modelContextWindow ?? undefined;
    const contextPercent =
      currentContext !== undefined && context
        ? Math.min(100, (currentContext / context) * 100)
        : undefined;
    const contextLabel =
      contextPercent !== undefined && currentContext !== undefined
        ? `Context ${contextPercent.toFixed(1)}% (${formatTokens(currentContext)} / ${formatTokens(context!)})`
        : context !== undefined
          ? `Context window ${formatTokens(context)}`
          : "";
    const modelParts = [
      modelInfo?.model ?? "",
      modelInfo?.provider ? `(${modelInfo.provider})` : "",
      modelInfo?.reasoningEffort ? `Reasoning ${modelInfo.reasoningEffort}` : "",
      modelInfo?.serviceTier ? `Tier ${modelInfo.serviceTier}` : "",
    ].filter(Boolean);
    const usageParts = [
      total !== undefined ? `Total ${formatTokens(total)}` : "",
      usage?.total.inputTokens !== undefined ? `In ${formatTokens(usage.total.inputTokens)}` : "",
      usage?.total.outputTokens !== undefined
        ? `Out ${formatTokens(usage.total.outputTokens)}`
        : "",
      usage?.total.cachedInputTokens !== undefined
        ? `Cached ${formatTokens(usage.total.cachedInputTokens)}`
        : "",
      usage?.total.reasoningOutputTokens !== undefined
        ? `Reasoning ${formatTokens(usage.total.reasoningOutputTokens)}`
        : "",
    ].filter(Boolean);
    const modelLine = modelParts.join(" · ");
    const cwd = this.state.codex.cwd;
    const lines = [modelLine, contextLabel, cwd, usageParts.join(" · ")].filter(Boolean);
    this.tokenUsage.replaceChildren();
    if (modelLine || contextLabel || cwd) {
      const modelRow = document.createElement("div");
      modelRow.className = "codex-model-line";
      const modelLabel = document.createElement("span");
      modelLabel.textContent = modelLine;
      modelRow.append(modelLabel);
      if (contextLabel) {
        const contextLabelElement = document.createElement("span");
        contextLabelElement.className = "codex-context";
        contextLabelElement.textContent = contextLabel;
        contextLabelElement.title = contextLabel;
        modelRow.append(contextLabelElement);
      }
      if (cwd) {
        const cwdLabel = document.createElement("span");
        cwdLabel.className = "codex-cwd";
        cwdLabel.textContent = cwd;
        cwdLabel.title = cwd;
        modelRow.append(cwdLabel);
      }
      this.tokenUsage.append(modelRow);
    }
    if (usageParts.length > 0 || this.modeToggle) {
      const usageLine = document.createElement("div");
      usageLine.className = "codex-usage-line";
      if (usageParts.length > 0) {
        const usageLabel = document.createElement("span");
        usageLabel.textContent = usageParts.join(" · ");
        usageLine.append(usageLabel);
      }
      if (this.modeToggle) usageLine.append(this.modeToggle);
      this.tokenUsage.append(usageLine);
    }
    this.tokenUsage.title = [...modelParts, contextLabel, cwd ?? "", ...usageParts]
      .filter(Boolean)
      .join(" · ");
    this.tokenUsage.hidden = lines.length === 0 && !cwd;
  }

  /** Renders the current rate-limit information. */
  private renderRateLimit(): void {
    const limits = this.state.codex.rateLimits;
    const primary = limits?.primary;
    if (!primary) {
      this.rateLimit.hidden = true;
      this.rateLimit.textContent = "";
      return;
    }
    const used = Math.round(primary.usedPercent);
    const reached = Boolean(limits?.rateLimitReachedType || limits?.spendControlReached);
    const details = formatRateLimitDetails(limits);
    this.rateLimit.textContent = details.join(" · ");
    this.rateLimit.className = reached
      ? "codex-rate-limit-reached"
      : used >= 80
        ? "codex-rate-limit-warning"
        : "codex-rate-limit-ok";
    this.rateLimit.setAttribute("aria-label", details.join("; "));
    this.rateLimit.hidden = false;
  }
}
