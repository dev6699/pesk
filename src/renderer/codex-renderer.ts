import { marked } from "./vendor/marked.js";

const slashCommands = [
  { command: "/plan", description: "Switch to Plan mode" },
  { command: "/default", description: "Switch to Default mode" },
  { command: "/new", description: "Start a new Codex session" },
];

export class CodexRenderer {
  private readonly webChat = document.body.classList.contains("web-chat");
  private settings: PeskSettings;
  private historyInitialized = false;
  private workingTimer: number | undefined;
  private workingLabelTimer: number | undefined;
  private workingLabelSince: number | undefined;
  private selectedMessageIndex = -1;
  private readonly rateLimit: HTMLElement;
  private readonly fileSuggestions: HTMLElement;
  private fileSearchSerial = 0;
  private fileSuggestionResults: FuzzyFileSearchResult[] = [];
  private slashCommandResults: typeof slashCommands = [];
  private suggestionKind: "file" | "command" | undefined;
  private fileSuggestionIndex = -1;
  private renderedUserInputRequestId: string | number | undefined;
  private activeUserInputQuestionId: string | undefined;
  private userInputQuestionIndex = 0;
  private userInputAnswers: Record<string, string[]> = {};
  private readonly dismissedPlanConfirmations = new Set<string>();
  private activePlanConfirmation: { key: string; planText: string } | undefined;
  private renderedHistoryStructureKey = "";
  private renderedPlanDetails = new Map<string, string>();
  private planRenderTimer: number | undefined;
  private pendingPlanHistory: PeskSettings["codexHistory"] | undefined;

  private suggestionCount(): number {
    return this.suggestionKind === "command"
      ? this.slashCommandResults.length
      : this.fileSuggestionResults.length;
  }

  constructor(
    private readonly chat: HTMLElement,
    private readonly sessionSelect: HTMLSelectElement,
    private readonly sessionCopy: HTMLButtonElement,
    private readonly error: HTMLElement,
    private readonly history: HTMLElement,
    private readonly workingStatus: HTMLElement,
    private readonly workingElapsed: HTMLElement,
    private readonly tokenUsage: HTMLElement,
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    settings: PeskSettings,
    rateLimit?: HTMLElement,
    fileSuggestions?: HTMLElement,
    private readonly modeToggle?: HTMLButtonElement,
    private readonly userInput?: HTMLElement,
    private readonly steerButton?: HTMLButtonElement,
  ) {
    this.settings = settings;
    this.rateLimit = rateLimit ?? document.createElement("div");
    this.fileSuggestions = fileSuggestions ?? document.createElement("div");
    this.renderWorkingStatus();
    sessionSelect.addEventListener("change", () => {
      if (sessionSelect.value)
        window.peskApi.selectCodexThread(sessionSelect.value);
    });
    sessionCopy.addEventListener("click", () => void this.copySessionId());
    this.modeToggle?.addEventListener("click", () => {
      const mode =
        this.settings.codexCollaborationMode === "plan" ? "default" : "plan";
      window.peskApi.setCodexCollaborationMode(mode);
    });
    this.steerButton?.addEventListener("click", () => {
      const prompt = this.input.value.trim();
      if (!prompt) return;
      void window.peskApi.steerCodexTurn(prompt).then((next) => {
        this.input.value = "";
        this.resizeInput();
        this.updateSettings(next);
        this.input.focus();
      });
    });
    chat.addEventListener("mousedown", (event) => event.stopPropagation());
    chat.addEventListener("wheel", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => void this.submit(event));
    input.addEventListener("input", () => {
      this.resizeInput();
      void this.updateSuggestions();
    });
    input.addEventListener("keydown", (event) =>
      this.handleInputKeydown(event),
    );
    if (this.webChat) {
      const visualViewport = window.visualViewport;
      const keepFormVisible = (): void => {
        if (visualViewport && Number.isFinite(visualViewport.height)) {
          document.documentElement.style.setProperty(
            "--web-chat-viewport-height",
            `${visualViewport.height}px`,
          );
        }
        this.keepWebChatFormVisible();
      };
      input.addEventListener("focus", keepFormVisible);
      visualViewport?.addEventListener("resize", keepFormVisible);
      const removeListeners = (): void => {
        input.removeEventListener("focus", keepFormVisible);
        visualViewport?.removeEventListener("resize", keepFormVisible);
        window.removeEventListener("pagehide", removeListeners);
        document.documentElement.style.removeProperty(
          "--web-chat-viewport-height",
        );
      };
      window.addEventListener("pagehide", removeListeners, { once: true });
    }
    this.resizeInput();
  }

  handleKeydown(event: KeyboardEvent): void {
    if (
      !this.userInput?.hidden &&
      event.key === "ArrowUp" &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      this.focusUserInputOption();
      return;
    }
    if (
      !this.chat.hidden &&
      event.key.toLowerCase() === "c" &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
      !(
        event.target === this.input &&
        (this.settings.codexStatus === "working" ||
          this.settings.codexStatus === "waiting")
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
      (event.key === "Home" || event.key === "End") &&
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      this.history.scrollTo({
        top: event.key === "Home" ? 0 : this.history.scrollHeight,
        behavior: "smooth",
      });
      return;
    }
    if (
      !this.chat.hidden &&
      event.key === "ArrowRight" &&
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      this.copySelectedMessageToInput()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !this.chat.hidden &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      this.toggleSelectedMessage()
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !this.chat.hidden &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      const direction = event.key === "ArrowUp" ? -1 : 1;
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.selectMessage(direction, "user");
        return;
      }
      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.history.scrollBy({
          top: direction * 64,
          behavior: "smooth",
        });
        return;
      }
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.selectMessage(direction);
        return;
      }
    }
    if (this.userInput?.contains(event.target as Node)) return;
  }

  updateSettings(next: PeskSettings): void {
    this.settings = next;
    this.error.hidden = !next.codexError;
    this.error.textContent = next.codexError ? "Codex connection error." : "";
    this.sessionSelect.replaceChildren();
    if (!next.codexThreads.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No active session";
      this.sessionSelect.append(option);
    } else {
      for (const thread of next.codexThreads) {
        const option = document.createElement("option");
        option.value = thread.id;
        option.textContent = thread.preview
          ? `${thread.id} — ${thread.preview}`
          : thread.id;
        option.title = thread.id;
        this.sessionSelect.append(option);
      }
      this.sessionSelect.value = next.codexThreadId ?? "";
    }
    this.sessionSelect.disabled = !next.codexThreads.length;
    this.sessionCopy.disabled = !next.codexThreadId;
    this.renderHistory(
      next.codexHistory,
      Boolean(next.codexThreadId),
      next.codexQueuedSubmissions,
    );
    this.renderWorkingStatus();
    this.renderTokenUsage();
    this.renderRateLimit();
    this.renderUserInput();
    const steerable =
      next.codexStatus === "working" || next.codexStatus === "waiting";
    if (this.steerButton) {
      this.steerButton.hidden = !steerable;
      this.steerButton.disabled = !steerable;
    }
    this.form.hidden = Boolean(
      next.codexPendingUserInput ||
      next.codexPendingApproval ||
      this.activePlanConfirmation,
    );
    if (this.modeToggle) {
      const plan = next.codexCollaborationMode === "plan";
      this.modeToggle.textContent = plan ? "Plan" : "Default";
      this.modeToggle.classList.toggle("codex-mode-plan", plan);
      this.modeToggle.title = plan
        ? "Plan mode enabled for the next turn"
        : "Default mode enabled for the next turn";
    }
  }

  focusInput(): void {
    requestAnimationFrame(() => this.input.focus());
  }

  private keepWebChatFormVisible(): void {
    if (!this.webChat) return;
    requestAnimationFrame(() => {
      this.history.scrollTop = this.history.scrollHeight;
    });
  }

  private focusChatInput(): void {
    window.peskApi.focusCodexInput();
    this.focusInput();
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.suggestionCount()) {
      this.selectSuggestion(this.fileSuggestionIndex);
      return;
    }
    const prompt = this.input.value.trim();
    if (!prompt) return;
    const keepInputFocused = this.webChat;
    if (keepInputFocused) this.input.focus();
    const next = await window.peskApi.submitCodexPrompt(prompt);
    this.input.value = "";
    this.resizeInput();
    this.updateSettings(next);
    this.history.scrollTop = this.history.scrollHeight;
    if (keepInputFocused) {
      this.input.focus();
      this.keepWebChatFormVisible();
    } else {
      this.input.focus();
    }
  }

  private renderUserInput(force = false): void {
    const container = this.userInput;
    const pending = this.settings.codexPendingUserInput;
    const pendingApproval = this.settings.codexPendingApproval;
    const planConfirmation = this.activePlanConfirmation;
    if (!container) return;
    if (!pending && !pendingApproval && !planConfirmation) {
      container.replaceChildren();
      container.hidden = true;
      this.renderedUserInputRequestId = undefined;
      this.activeUserInputQuestionId = undefined;
      this.userInputQuestionIndex = 0;
      this.userInputAnswers = {};
      return;
    }
    if (!pending && !pendingApproval && planConfirmation) {
      const existing = container.querySelector<HTMLElement>(
        ".codex-plan-implementation-prompt",
      );
      if (
        !force &&
        existing?.dataset.planConfirmationKey === planConfirmation.key
      ) {
        return;
      }
      container.replaceChildren();
      container.hidden = false;
      this.renderedUserInputRequestId = undefined;
      this.activeUserInputQuestionId = undefined;
      this.userInputQuestionIndex = 0;
      this.userInputAnswers = {};
      container.append(
        this.renderPlanImplementationPrompt(
          planConfirmation.key,
          planConfirmation.planText,
        ),
      );
      requestAnimationFrame(() => {
        this.history.scrollTop = this.history.scrollHeight;
      });
      return;
    }
    if (!pending && pendingApproval) {
      this.renderApprovalInput(pendingApproval, force);
      return;
    }
    if (!pending) return;

    const requestChanged =
      this.renderedUserInputRequestId !== pending.requestId;
    if (requestChanged) {
      this.renderedUserInputRequestId = pending.requestId;
      this.userInputQuestionIndex = 0;
      this.userInputAnswers = {};
      this.activeUserInputQuestionId = pending.questions[0]?.id;
    }
    const question = pending.questions[this.userInputQuestionIndex];
    if (!question) return;
    if (!force && !requestChanged && container.querySelector("form")) return;
    container.replaceChildren();
    container.hidden = false;

    const title = document.createElement("strong");
    title.textContent = "Codex needs your input";
    container.append(title);

    const instructions = document.createElement("small");
    instructions.className = "codex-user-input-instructions";
    instructions.textContent =
      "Use ↑/↓ to select, Tab to add a note, and Enter to submit.";
    container.append(instructions);

    const form = document.createElement("form");
    form.className = "codex-user-input-form";
    const fieldset = document.createElement("fieldset");
    fieldset.dataset.questionId = question.id;
    const legend = document.createElement("legend");
    legend.textContent = question.header || question.question;
    fieldset.append(legend);
    if (question.header && question.question !== question.header) {
      const prompt = document.createElement("div");
      prompt.className = "codex-user-input-question";
      prompt.textContent = question.question;
      fieldset.append(prompt);
    }
    const options = [...(question.options ?? [])];
    if (question.isOther && options.length) {
      options.push({ label: "Other", description: "" });
    }
    for (const [optionIndex, option] of options.entries()) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `question-${question.id}`;
      input.value = option.label;
      input.tabIndex = optionIndex === 0 ? 0 : -1;
      input.dataset.questionId = question.id;
      input.addEventListener("focus", () => {
        this.activeUserInputQuestionId = question.id;
      });
      input.addEventListener("change", () => {
        for (const radio of fieldset.querySelectorAll<HTMLInputElement>(
          "input[type='radio']",
        )) {
          radio.tabIndex = radio === input ? 0 : -1;
        }
      });
      label.append(input, document.createTextNode(` ${option.label}`));
      if (option.description) {
        const description = document.createElement("small");
        description.className = "codex-user-input-option-description";
        description.textContent = option.description;
        label.append(description);
      }
      fieldset.append(label);
    }
    if (question.options?.length) {
      const noteLabel = document.createElement("label");
      noteLabel.className = "codex-user-input-note-label";
      noteLabel.textContent = "Note (optional)";
      const note = document.createElement("input");
      note.type = "text";
      note.placeholder = "Add a note";
      note.setAttribute(
        "aria-label",
        `Note for ${question.header || question.question}`,
      );
      note.dataset.questionId = question.id;
      note.dataset.note = "true";
      note.addEventListener("focus", () => {
        this.activeUserInputQuestionId = question.id;
      });
      noteLabel.append(note);
      fieldset.append(noteLabel);
    }
    if (!question.options?.length) {
      const input = document.createElement("input");
      input.type = question.isSecret ? "password" : "text";
      input.placeholder = question.isOther ? "Other" : question.question;
      input.dataset.questionId = question.id;
      input.dataset.other = "true";
      fieldset.append(input);
    }
    form.append(fieldset);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent =
      this.userInputQuestionIndex < pending.questions.length - 1
        ? "Next"
        : "Submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = Array.from(
        form.querySelectorAll<HTMLInputElement>("[data-question-id]"),
      )
        .filter(
          (input) =>
            input.dataset.questionId === question.id &&
            (input.type !== "radio" || input.checked),
        )
        .map((input) => (input.value ?? "").trim())
        .filter(Boolean);
      this.userInputAnswers[question.id] = selected;
      if (this.userInputQuestionIndex < pending.questions.length - 1) {
        this.userInputQuestionIndex += 1;
        this.activeUserInputQuestionId =
          pending.questions[this.userInputQuestionIndex]?.id;
        this.renderUserInput(true);
        this.focusUserInputOption();
        return;
      }
      const answers = { ...this.userInputAnswers };
      window.peskApi.respondCodexUserInput(pending.requestId, answers);
      submit.disabled = true;
      this.focusChatInput();
    });
    form.addEventListener("keydown", (event) => {
      if (
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "radio" &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const options = Array.from(
          event.target
            .closest("fieldset")
            ?.querySelectorAll<HTMLInputElement>("input[type='radio']") ?? [],
        );
        const currentIndex = options.indexOf(event.target);
        if (currentIndex >= 0 && options.length > 1) {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const next =
            options[
              (currentIndex + direction + options.length) % options.length
            ];
          for (const radio of options) radio.checked = false;
          next.checked = true;
          for (const radio of options) radio.tabIndex = radio === next ? 0 : -1;
          next.focus();
        }
        return;
      }
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "radio"
      ) {
        const fieldset = event.target.closest("fieldset");
        const note = fieldset?.querySelector<HTMLInputElement>(
          "input[data-note='true']",
        );
        const noteLabel = note?.closest("label");
        if (note && noteLabel) {
          event.preventDefault();
          note.focus();
        }
        return;
      }
      if (
        event.key === "Tab" &&
        event.target instanceof HTMLInputElement &&
        event.target.dataset.note === "true"
      ) {
        const fieldset = event.target.closest("fieldset");
        const selected = fieldset?.querySelector<HTMLInputElement>(
          "input[type='radio']:checked",
        );
        event.preventDefault();
        event.target.value = "";
        const noteLabel = event.target.closest("label");
        selected?.focus();
        return;
      }
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLInputElement &&
        (event.target.type === "radio" ||
          event.target.type === "text" ||
          event.target.type === "password") &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    container.append(form);
    if (requestChanged || force) {
      form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
      requestAnimationFrame(() => {
        form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
        if (requestChanged) {
          this.history.scrollTop = this.history.scrollHeight;
        }
      });
    }
  }

  private renderApprovalInput(
    pending: NonNullable<PeskSettings["codexPendingApproval"]>,
    force: boolean,
  ): void {
    const container = this.userInput;
    if (!container) return;
    const existing = container.querySelector("form");
    if (
      !force &&
      existing?.dataset.approvalRequestId === String(pending.requestId)
    )
      return;
    container.replaceChildren();
    container.hidden = false;
    const title = document.createElement("strong");
    title.textContent = "Codex needs approval";
    container.append(title);
    const form = document.createElement("form");
    form.className = "codex-user-input-form";
    form.dataset.approvalRequestId = String(pending.requestId);
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = pending.command || "Approval request";
    fieldset.append(legend);
    if (pending.reason) {
      const reason = document.createElement("div");
      reason.className = "codex-user-input-question";
      reason.textContent = pending.reason;
      fieldset.append(reason);
    }
    for (const [index, option] of pending.options.entries()) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "approval";
      input.value = option.id;
      input.checked = index === 0;
      label.append(input, document.createTextNode(` ${option.label}`));
      if (option.description) {
        const description = document.createElement("small");
        description.className = "codex-user-input-option-description";
        description.textContent = option.description;
        label.append(description);
      }
      fieldset.append(label);
    }
    form.append(fieldset);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>(
        "input[type='radio']:checked",
      );
      if (!selected) return;
      window.peskApi.respondCodexPermission(pending.requestId, selected.value);
      submit.disabled = true;
      this.focusChatInput();
    });
    container.append(form);
    requestAnimationFrame(() => {
      form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
      this.history.scrollTop = this.history.scrollHeight;
    });
  }

  focusUserInputOption(): void {
    const container = this.userInput;
    if (!container || container.hidden) return;
    const questionId = this.activeUserInputQuestionId;
    const fieldset = Array.from(
      container.querySelectorAll<HTMLElement>("fieldset"),
    ).find(
      (candidate) => !questionId || candidate.dataset.questionId === questionId,
    );
    const option =
      fieldset?.querySelector<HTMLInputElement>(
        "input[type='radio']:checked",
      ) ?? fieldset?.querySelector<HTMLInputElement>("input[type='radio']");
    option?.focus();
  }

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

  private resizeInput(): void {
    const maxHeight = 220;
    const wasAtBottom =
      this.history.scrollTop + this.history.clientHeight >=
      this.history.scrollHeight - 24;
    this.input.style.height = "auto";
    const height = Math.min(this.input.scrollHeight, maxHeight);
    this.input.style.height = `${height}px`;
    this.input.style.overflowY =
      this.input.scrollHeight > maxHeight ? "auto" : "hidden";
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        this.history.scrollTop = this.history.scrollHeight;
      });
    }
  }

  private renderTokenUsage(): void {
    if (!this.settings.codexThreadId) {
      this.tokenUsage.hidden = true;
      this.tokenUsage.textContent = "";
      this.tokenUsage.removeAttribute("title");
      return;
    }
    const usage = this.settings.codexTokenUsage;
    const modelInfo = this.settings.codexModelInfo;
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
      modelInfo?.reasoningEffort
        ? `Reasoning ${modelInfo.reasoningEffort}`
        : "",
      modelInfo?.serviceTier ? `Tier ${modelInfo.serviceTier}` : "",
    ].filter(Boolean);
    const usageParts = [
      total !== undefined ? `Total ${formatTokens(total)}` : "",
      usage?.total.inputTokens !== undefined
        ? `In ${formatTokens(usage.total.inputTokens)}`
        : "",
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
    const cwd = this.settings.codexCwd;
    const lines = [modelLine, contextLabel, cwd, usageParts.join(" · ")].filter(
      Boolean,
    );
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
    if (usageParts.length > 0) {
      const usageLine = document.createElement("div");
      usageLine.textContent = usageParts.join(" · ");
      this.tokenUsage.append(usageLine);
    }
    this.tokenUsage.title = [
      ...modelParts,
      contextLabel,
      cwd ?? "",
      ...usageParts,
    ]
      .filter(Boolean)
      .join(" · ");
    this.tokenUsage.hidden = lines.length === 0 && !cwd;
  }

  private renderRateLimit(): void {
    const limits = this.settings.codexRateLimits;
    const primary = limits?.primary;
    if (!primary) {
      this.rateLimit.hidden = true;
      this.rateLimit.textContent = "";
      return;
    }
    const used = Math.round(primary.usedPercent);
    const reached = Boolean(
      limits?.rateLimitReachedType || limits?.spendControlReached,
    );
    this.rateLimit.textContent = formatRateLimitDetails(limits).join(" · ");
    this.rateLimit.className = reached
      ? "codex-rate-limit-reached"
      : used >= 80
        ? "codex-rate-limit-warning"
        : "codex-rate-limit-ok";
    const details = formatRateLimitDetails(limits);
    this.rateLimit.setAttribute("aria-label", details.join("; "));
    this.rateLimit.hidden = false;
  }

  private selectMessage(
    direction: -1 | 1,
    role?: PeskSettings["codexHistory"][number]["role"],
  ): void {
    const messages = Array.from(
      this.history.querySelectorAll<HTMLElement>(".codex-message"),
    );
    if (!messages.length) return;

    const candidateIndices = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          !role || message.classList.contains(`codex-message-${role}`),
      )
      .map(({ index }) => index);
    if (!candidateIndices.length) return;
    this.input.blur();
    const visibleIndices = this.visibleMessageIndices(
      messages,
      candidateIndices,
    );
    const selectionIsVisible = visibleIndices.includes(
      this.selectedMessageIndex,
    );
    const currentCandidateIndex = candidateIndices.indexOf(
      this.selectedMessageIndex,
    );
    const nextIndex = selectionIsVisible
      ? candidateIndices[
          Math.max(
            0,
            Math.min(
              candidateIndices.length - 1,
              currentCandidateIndex + direction,
            ),
          )
        ]
      : ((direction < 0
          ? visibleIndices[visibleIndices.length - 1]
          : visibleIndices[0]) ??
        (direction < 0
          ? candidateIndices[candidateIndices.length - 1]
          : candidateIndices[0]));
    this.selectedMessageIndex = nextIndex;
    this.applySelectedMessage();
    messages[nextIndex]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }

  private applySelectedMessage(): void {
    const messages = Array.from(
      this.history.querySelectorAll<HTMLElement>(".codex-message"),
    );
    messages.forEach((message, index) => {
      const selected = index === this.selectedMessageIndex;
      message.classList.toggle("codex-message-selected", selected);
      message.setAttribute("aria-selected", String(selected));
    });
  }

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
        ({ bounds }) =>
          bounds.bottom > historyBounds.top &&
          bounds.top < historyBounds.bottom,
      )
      .map(({ index }) => index);
  }

  private toggleSelectedMessage(): boolean {
    if (this.selectedMessageIndex < 0) return false;
    const message =
      this.history.querySelectorAll<HTMLElement>(".codex-message")[
        this.selectedMessageIndex
      ];
    const details = message?.querySelector<HTMLDetailsElement>("details");
    if (!details) return false;
    details.open = !details.open;
    return true;
  }

  private copySelectedMessageToInput(): boolean {
    const text = this.selectedMessageText();
    if (!text) return false;
    this.input.value = text;
    this.resizeInput();
    this.focusInput();
    return true;
  }

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

  private selectedMessageText(): string | undefined {
    if (this.selectedMessageIndex < 0) return undefined;
    const message =
      this.history.querySelectorAll<HTMLElement>(".codex-message")[
        this.selectedMessageIndex
      ];
    if (!message) return undefined;
    const content = message.cloneNode(true) as HTMLElement;
    content
      .querySelectorAll(".codex-message-time, .codex-approval-actions")
      .forEach((element) => element.remove());
    return content.textContent?.trim() || undefined;
  }

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

  private handleInputKeydown(event: KeyboardEvent): void {
    if (this.suggestionCount()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const suggestionCount = this.suggestionCount();
        this.fileSuggestionIndex =
          (this.fileSuggestionIndex + direction + suggestionCount) %
          suggestionCount;
        this.renderFileSuggestions();
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        this.selectSuggestion(this.fileSuggestionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideFileSuggestions();
        return;
      }
    }
    if (
      event.key.toLowerCase() === "c" &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      (this.settings.codexStatus === "working" ||
        this.settings.codexStatus === "waiting")
    ) {
      event.preventDefault();
      void window.peskApi.interruptCodexTurn();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
      this.input.selectionStart = start + 1;
      this.input.selectionEnd = start + 1;
      this.resizeInput();
    } else if (event.shiftKey) {
      event.preventDefault();
    } else if (!event.altKey && !event.metaKey) {
      event.preventDefault();
      this.form.requestSubmit();
    } else if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const prompt = this.input.value.trim();
      if (prompt && (this.settings.codexStatus === "working" || this.settings.codexStatus === "waiting") && this.settings.codexThreadId) {
        void window.peskApi.steerCodexTurn(prompt).then((next) => {
          this.input.value = "";
          this.resizeInput();
          this.updateSettings(next);
        });
      } else {
        this.form.requestSubmit();
      }
    }
  }

  private async updateSuggestions(): Promise<void> {
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const beforeCursor = this.input.value.slice(0, cursor);
    const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
    if (commandMatch) {
      const query = commandMatch[1].toLowerCase();
      this.fileSearchSerial += 1;
      this.suggestionKind = "command";
      this.slashCommandResults = slashCommands.filter(({ command }) =>
        command.slice(1).startsWith(query),
      );
      this.fileSuggestionIndex = this.slashCommandResults.length ? 0 : -1;
      this.renderFileSuggestions();
      return;
    }
    const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      this.hideFileSuggestions();
      return;
    }
    const query = match[1];
    if (!query) {
      this.hideFileSuggestions();
      return;
    }
    const serial = ++this.fileSearchSerial;
    const results = await window.peskApi.fuzzyFileSearch(
      query,
      this.settings.codexCwd ? [this.settings.codexCwd] : [],
    );
    if (serial !== this.fileSearchSerial) return;
    this.suggestionKind = "file";
    this.fileSuggestionResults = results.slice(0, 8);
    this.fileSuggestionIndex = this.fileSuggestionResults.length ? 0 : -1;
    this.renderFileSuggestions();
  }

  private renderFileSuggestions(): void {
    this.fileSuggestions.replaceChildren();
    const results =
      this.suggestionKind === "command"
        ? this.slashCommandResults
        : this.fileSuggestionResults;
    this.fileSuggestions.hidden = !results.length;
    if (this.suggestionKind === "command") {
      this.slashCommandResults.forEach((result, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "codex-file-suggestion";
        button.setAttribute("role", "option");
        button.setAttribute(
          "aria-selected",
          String(index === this.fileSuggestionIndex),
        );
        const name = document.createElement("span");
        name.className = "codex-file-suggestion-name";
        name.textContent = result.command;
        const description = document.createElement("span");
        description.className = "codex-file-suggestion-path";
        description.textContent = result.description;
        button.append(name, description);
        button.title = result.description;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => this.selectSuggestion(index));
        this.fileSuggestions.append(button);
        if (index === this.fileSuggestionIndex) {
          button.scrollIntoView?.({ block: "nearest" });
        }
      });
      return;
    }
    this.fileSuggestionResults.forEach((result, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "codex-file-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute(
        "aria-selected",
        String(index === this.fileSuggestionIndex),
      );
      const name = document.createElement("span");
      name.className = "codex-file-suggestion-name";
      name.textContent = result.file_name;
      const separatorIndex = Math.max(
        result.path.lastIndexOf("/"),
        result.path.lastIndexOf("\\"),
      );
      const parentPath = document.createElement("span");
      parentPath.className = "codex-file-suggestion-path";
      parentPath.textContent =
        separatorIndex >= 0 ? result.path.slice(0, separatorIndex) : ".";
      const matchType = document.createElement("span");
      matchType.className = "codex-file-suggestion-type";
      matchType.textContent = result.match_type;
      button.append(name, parentPath, matchType);
      button.title = result.path;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.selectSuggestion(index));
      this.fileSuggestions.append(button);
      if (index === this.fileSuggestionIndex) {
        button.scrollIntoView?.({ block: "nearest" });
      }
    });
  }

  private selectSuggestion(index: number): void {
    if (this.suggestionKind === "command") {
      const result = this.slashCommandResults[index];
      if (!result) return;
      this.input.value = `${result.command} `;
      this.input.selectionStart = this.input.value.length;
      this.input.selectionEnd = this.input.value.length;
      this.hideFileSuggestions();
      this.resizeInput();
      this.input.focus();
      return;
    }
    const result = this.fileSuggestionResults[index];
    if (!result) return;
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const beforeCursor = this.input.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      this.hideFileSuggestions();
      return;
    }
    const tokenStart = cursor - match[1].length - 1;
    this.input.value = `${this.input.value.slice(0, tokenStart)}${result.path} ${this.input.value.slice(cursor)}`;
    const nextCursor = tokenStart + result.path.length + 1;
    this.input.selectionStart = nextCursor;
    this.input.selectionEnd = nextCursor;
    this.hideFileSuggestions();
    this.resizeInput();
    this.input.focus();
  }

  private hideFileSuggestions(): void {
    this.fileSearchSerial += 1;
    this.fileSuggestionResults = [];
    this.slashCommandResults = [];
    this.suggestionKind = undefined;
    this.fileSuggestionIndex = -1;
    this.fileSuggestions.hidden = true;
    this.fileSuggestions.replaceChildren();
  }

  private renderHistory(
    history: PeskSettings["codexHistory"],
    sessionConnected = false,
    queuedSubmissions: PeskSettings["codexQueuedSubmissions"] = [],
  ): void {
    this.updateActivePlanConfirmation(history);
    const structureKey = `${historyStructureKey(history)}|queue:${queuedSubmissions
      .map((submission) => `${submission.id}:${submission.text}`)
      .join("|")}`;
    const planContentChanged = (history ?? []).some((message, index) => {
      if (message.activity?.kind !== "plan") return false;
      const activityKey = message.itemId ?? `history-${index}`;
      return (
        this.renderedPlanDetails.get(activityKey) !==
        (message.activity.details ?? "")
      );
    });
    if (
      this.renderedHistoryStructureKey &&
      structureKey === this.renderedHistoryStructureKey &&
      this.schedulePlanUpdates(history)
    ) {
      return;
    }
    if (this.planRenderTimer !== undefined) {
      window.clearTimeout(this.planRenderTimer);
      this.planRenderTimer = undefined;
      this.pendingPlanHistory = undefined;
    }
    const wasAtBottom =
      this.historyInitialized &&
      this.history.scrollTop + this.history.clientHeight >=
        this.history.scrollHeight - 24;
    const openActivityKeys = new Set(
      Array.from(
        this.history.querySelectorAll<HTMLDetailsElement>(
          "details[data-activity-key]",
        ),
      )
        .filter((details) => details.open)
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    const renderedActivityKeys = new Set(
      Array.from(
        this.history.querySelectorAll<HTMLElement>(
          "details[data-activity-key]",
        ),
      )
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    this.history.replaceChildren();
    this.renderedHistoryStructureKey = structureKey;
    this.renderedPlanDetails.clear();
    if (!history?.length) {
      const empty = document.createElement("div");
      empty.className = "codex-empty-history";
      empty.textContent = "No messages yet.";
      this.history.append(empty);
      if (sessionConnected) {
        const connected = document.createElement("div");
        connected.className = "codex-session-connected";
        connected.textContent = "Session connected.";
        this.history.append(connected);
      }
    }
    for (const [index, message] of (history ?? []).entries()) {
      const bubble = document.createElement("div");
      bubble.className = `codex-message codex-message-${message.role}`;
      if (message.activity) {
        bubble.classList.add(`codex-activity-${message.activity.kind}`);
        if (message.activity.output)
          bubble.classList.add("codex-activity-output");
      }
      if (message.temporary) bubble.classList.add("codex-message-working");
      const activityKey = message.itemId ?? `history-${index}`;
      if (message.itemId) bubble.dataset.messageItemId = message.itemId;
      if (message.activity?.kind === "plan") {
        this.renderedPlanDetails.set(
          activityKey,
          message.activity.details ?? "",
        );
      }
      bubble.append(
        this.renderMessageContent(
          message,
          activityKey,
          openActivityKeys,
          renderedActivityKeys,
        ),
      );
      const time = document.createElement("time");
      time.className = "codex-message-time";
      time.textContent = new Date(
        message.timestamp ?? Date.now(),
      ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      bubble.append(time);
      if (message.approval) this.renderApproval(bubble, message);
      this.history.append(bubble);
    }
    if (queuedSubmissions.length) {
      const queue = document.createElement("section");
      queue.className = "codex-queued-submissions";
      const title = document.createElement("strong");
      title.textContent = "Queued";
      queue.append(title);
      for (const submission of queuedSubmissions) {
        const item = document.createElement("div");
        item.className = "codex-queued-submission";
        item.textContent = submission.text;
        item.title = "Queued follow-up";
        queue.append(item);
      }
      this.history.append(queue);
    }
    this.applySelectedMessage();
    if (!this.historyInitialized || wasAtBottom || planContentChanged) {
      this.history.scrollTop = this.history.scrollHeight;
    }
    this.historyInitialized = true;
  }

  private updateActivePlanConfirmation(
    history: PeskSettings["codexHistory"],
  ): void {
    this.activePlanConfirmation = undefined;
    const lastMessage = history?.[history.length - 1];
    if (
      lastMessage?.activity?.kind !== "plan" ||
      (lastMessage.activity.status !== "completed" &&
        lastMessage.activity.status !== "complete")
    ) {
      return;
    }
    const activityKey =
      lastMessage.itemId ?? `history-${(history?.length ?? 1) - 1}`;
    if (this.dismissedPlanConfirmations.has(activityKey)) return;
    this.activePlanConfirmation = {
      key: activityKey,
      planText: lastMessage.activity.details ?? lastMessage.text,
    };
  }

  private schedulePlanUpdates(history: PeskSettings["codexHistory"]): boolean {
    const planUpdates = (history ?? []).filter((message, index) => {
      if (message.activity?.kind !== "plan") return false;
      const activityKey = message.itemId ?? `history-${index}`;
      return (
        this.renderedPlanDetails.get(activityKey) !==
        (message.activity.details ?? "")
      );
    });
    if (!planUpdates.length) return true;
    const activityDetails = Array.from(
      this.history.querySelectorAll<HTMLDetailsElement>(
        "details[data-activity-key]",
      ),
    );
    if (
      !planUpdates.every((message, index) => {
        const historyIndex = history.indexOf(message);
        const activityKey =
          message.itemId ??
          `history-${historyIndex >= 0 ? historyIndex : index}`;
        return activityDetails.some(
          (details) => details.dataset.activityKey === activityKey,
        );
      })
    ) {
      return false;
    }
    this.pendingPlanHistory = history;
    if (this.planRenderTimer === undefined) {
      this.planRenderTimer = window.setTimeout(() => {
        this.planRenderTimer = undefined;
        const nextHistory = this.pendingPlanHistory;
        this.pendingPlanHistory = undefined;
        if (!nextHistory) return;
        for (const [index, message] of nextHistory.entries()) {
          if (message.activity?.kind !== "plan") continue;
          const activityKey = message.itemId ?? `history-${index}`;
          const details = Array.from(
            this.history.querySelectorAll<HTMLDetailsElement>(
              "details[data-activity-key]",
            ),
          ).find((candidate) => candidate.dataset.activityKey === activityKey);
          const content = details?.querySelector<HTMLElement>(
            ".codex-plan-content",
          );
          if (!content) {
            this.renderHistory(nextHistory);
            return;
          }
          content.innerHTML = renderMarkdown(message.activity.details ?? "");
          this.renderedPlanDetails.set(
            activityKey,
            message.activity.details ?? "",
          );
        }
        requestAnimationFrame(() => {
          this.history.scrollTop = this.history.scrollHeight;
        });
      }, 100);
    }
    return true;
  }

  private renderMessageContent(
    message: PeskSettings["codexHistory"][number],
    activityKey: string,
    openActivityKeys: Set<string>,
    renderedActivityKeys: Set<string>,
  ): HTMLElement {
    if (message.activity?.kind === "command") {
      const details = document.createElement("details");
      details.className = "codex-command-details";
      details.dataset.activityKey = activityKey;
      details.open = openActivityKeys.has(activityKey);
      const summary = document.createElement("summary");
      const command = message.activity.command?.replace(/\s+/g, " ").trim();
      summary.textContent = `Command · ${message.activity.status ?? "in progress"}`;
      if (command) {
        const commandLine = document.createElement("span");
        commandLine.className = "codex-command-summary-command";
        commandLine.textContent = `$ ${command}`;
        summary.append(commandLine);
      }
      details.append(summary);
      const body = document.createElement("pre");
      body.className = "codex-activity-details";
      body.textContent = formatCommandActivity(message.activity);
      details.append(body);
      return details;
    }
    if (message.activity?.kind === "fileChange") {
      return this.renderFileChangeActivity(
        message.activity,
        activityKey,
        openActivityKeys,
        renderedActivityKeys,
      );
    }
    if (message.activity?.kind === "plan") {
      const details = document.createElement("details");
      details.className = "codex-plan-details";
      details.dataset.activityKey = activityKey;
      details.open =
        openActivityKeys.has(activityKey) ||
        !renderedActivityKeys.has(activityKey);
      const summary = document.createElement("summary");
      summary.textContent = `Plan · ${message.activity.status ?? "in progress"}`;
      details.append(summary);
      const body = document.createElement("div");
      body.className = "codex-plan-content codex-markdown";
      body.innerHTML = renderMarkdown(message.activity.details ?? "");
      details.append(body);
      return details;
    }
    if (message.activity) {
      const details = document.createElement("details");
      details.className = "codex-activity-details-block";
      details.dataset.activityKey = activityKey;
      details.open = openActivityKeys.has(activityKey);
      const summary = document.createElement("summary");
      const label = activityLabel(message.activity.kind);
      summary.textContent = `${label} · ${message.activity.status ?? "in progress"}`;
      if (message.activity.summary) {
        const query = document.createElement("span");
        query.className = "codex-activity-summary-detail";
        query.textContent = message.activity.summary
          .replace(/\s+/g, " ")
          .trim();
        summary.append(query);
      }
      details.append(summary);
      const body = document.createElement("pre");
      body.className = "codex-activity-details";
      body.textContent = message.text;
      details.append(body);
      return details;
    }
    const content = document.createElement("div");
    if (message.role === "assistant" && !message.activity) {
      content.className = "codex-markdown";
      content.innerHTML = renderMarkdown(message.text);
    } else {
      content.textContent = message.text;
    }
    return content;
  }

  private renderPlanImplementationPrompt(
    activityKey: string,
    planText: string,
  ): HTMLElement {
    const prompt = document.createElement("section");
    prompt.className = "codex-plan-implementation-prompt";
    prompt.dataset.planConfirmationKey = activityKey;

    const title = document.createElement("strong");
    title.textContent = "Implement this plan?";
    prompt.append(title);

    const form = document.createElement("form");
    const choices = [
      [
        "implement",
        "Yes, implement this plan",
        "Switch to Default and start coding.",
      ],
      [
        "clear-context",
        "Yes, clear context and implement",
        "Fresh thread. The completed plan will be included.",
      ],
      [
        "stay-plan",
        "No, stay in Plan mode",
        "Continue planning with the model.",
      ],
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
      const selected = form.querySelector<HTMLInputElement>(
        "input[type='radio']:checked",
      )?.value;
      if (!selected) return;
      this.dismissedPlanConfirmations.add(activityKey);
      if (selected === "stay-plan") {
        this.renderHistory(
          this.settings.codexHistory,
          Boolean(this.settings.codexThreadId),
        );
        this.renderUserInput();
        this.form.hidden = false;
        this.focusChatInput();
        return;
      }
      submit.disabled = true;
      void window.peskApi
        .implementCodexPlan(planText, selected === "clear-context")
        .then((next) => {
          this.updateSettings(next);
          this.focusChatInput();
          this.renderHistory(
            this.settings.codexHistory,
            Boolean(this.settings.codexThreadId),
          );
        });
    });
    prompt.append(form);
    requestAnimationFrame(() => {
      form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
    });
    return prompt;
  }

  private renderFileChangeActivity(
    activity: NonNullable<PeskSettings["codexHistory"][number]["activity"]>,
    activityKey: string,
    openActivityKeys: Set<string>,
    renderedActivityKeys: Set<string>,
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "codex-file-change-details";
    details.dataset.activityKey = activityKey;
    details.open =
      openActivityKeys.has(activityKey) ||
      !renderedActivityKeys.has(activityKey);

    const summary = document.createElement("summary");
    summary.textContent = `File change · ${activity.status ?? "in progress"}`;
    details.append(summary);

    for (const change of activity.changes ?? []) {
      const lines = change.split("\n");
      const path = document.createElement("div");
      path.className = "codex-file-change-path";
      path.textContent = lines.shift() ?? "unknown file";
      details.append(path);

      if (lines.length) {
        const diff = document.createElement("pre");
        diff.className = "codex-file-change-diff";
        for (const line of lines) {
          const row = document.createElement("span");
          row.className = fileChangeLineClass(line);
          row.textContent = line;
          diff.append(row, "\n");
        }
        details.append(diff);
      }
    }
    return details;
  }

  private renderWorkingStatus(): void {
    if (this.workingTimer !== undefined)
      window.clearInterval(this.workingTimer);
    this.workingTimer = undefined;
    const since = this.settings.codexWorkingSince;
    const worked = this.settings.codexWorkedElapsed;
    this.workingStatus.hidden = since === undefined && worked === undefined;
    if (since === undefined) {
      this.workingStatus.classList.add("codex-working-status-complete");
      if (this.workingLabelTimer !== undefined)
        window.clearInterval(this.workingLabelTimer);
      this.workingLabelTimer = undefined;
      this.workingLabelSince = undefined;
      this.workingStatus.classList.toggle(
        "codex-working-status-interrupted",
        Boolean(this.settings.codexInterrupted),
      );
      this.workingStatus.firstElementChild!.textContent = this.settings
        .codexInterrupted
        ? "Conversation interrupted"
        : "Worked for";
      this.workingElapsed.textContent = formatElapsed(worked ?? 0);
      return;
    }
    this.workingStatus.classList.remove("codex-working-status-complete");
    this.workingStatus.classList.remove("codex-working-status-interrupted");
    if (
      this.workingLabelTimer === undefined ||
      this.workingLabelSince !== since
    ) {
      if (this.workingLabelTimer !== undefined)
        window.clearInterval(this.workingLabelTimer);
      this.workingLabelSince = since;
      const workingLabel = this.workingStatus.firstElementChild!;
      const fullLabel = "Working...";
      let characters = 0;
      let pause = 0;
      const updateLabel = () => {
        if (pause > 0) {
          pause -= 1;
          if (pause === 0) {
            characters = 0;
            workingLabel.textContent = "";
          }
          return;
        }
        if (characters < fullLabel.length) {
          characters += 1;
          workingLabel.textContent = fullLabel.slice(0, characters);
        } else {
          pause = 5;
        }
      };
      workingLabel.textContent = "";
      this.workingLabelTimer = window.setInterval(updateLabel, 220);
    }
    const update = () => {
      this.workingElapsed.textContent = formatElapsed(Date.now() - since);
    };
    update();
    this.workingTimer = window.setInterval(update, 1000);
  }

  private renderApproval(
    bubble: HTMLElement,
    message: PeskSettings["codexHistory"][number],
  ): void {
    const approval = message.approval;
    if (!approval) return;
    bubble.classList.add(`codex-approval-${approval.state}`);
    if (approval.state === "pending") {
      bubble.classList.add("codex-approval-pending");
      const actions = document.createElement("div");
      actions.className = "codex-approval-actions";
      const options = approval.options ?? [
        {
          id: "decline",
          label: "Decline",
          description: "Reject this request.",
        },
        {
          id: "accept",
          label: "Approve once",
          description: "Allow this request only.",
        },
      ];
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.decision = option.id;
        button.textContent = option.label;
        button.title = option.description;
        button.addEventListener("click", () =>
          window.peskApi.respondCodexPermission(
            approval.requestId ?? "",
            option.id,
          ),
        );
        actions.append(button);
      }
      bubble.append(actions);
    } else {
      const result = document.createElement("div");
      result.className = "codex-approval-result";
      result.textContent =
        approval.state === "approved" ? "Approved" : "Denied";
      bubble.append(result);
    }
  }
}

function activityLabel(
  kind: NonNullable<PeskSettings["codexHistory"][number]["activity"]>["kind"],
): string {
  switch (kind) {
    case "webSearch":
      return "Web search";
    case "tool":
      return "Tool";
    case "plan":
      return "Plan";
    case "other":
      return "Activity";
    default:
      return kind === "fileChange" ? "File change" : "Command";
  }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `${hours}h ${remainderMinutes}m ${remainderSeconds}s`;
}

function historyStructureKey(history: PeskSettings["codexHistory"]): string {
  return JSON.stringify(
    (history ?? []).map((message) => ({
      role: message.role,
      itemId: message.itemId,
      timestamp: message.timestamp,
      temporary: message.temporary,
      approval: message.approval,
      text: message.activity?.kind === "plan" ? undefined : message.text,
      activity: message.activity
        ? {
            ...message.activity,
            details:
              message.activity.kind === "plan"
                ? undefined
                : message.activity.details,
          }
        : undefined,
    })),
  );
}

function renderMarkdown(value: string): string {
  const html = marked.parse(value, { async: false, breaks: true, gfm: true });
  return sanitizeMarkdownHtml(String(html));
}

function sanitizeMarkdownHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set([
    "A",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "DEL",
    "EM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "LI",
    "OL",
    "P",
    "PRE",
    "STRONG",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);
  const visit = (element: Element): void => {
    for (const child of [...element.children]) {
      if (!allowed.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const keep =
          child.tagName === "A" &&
          ((name === "href" && /^(https?:|mailto:|#)/i.test(attribute.value)) ||
            name === "title");
        if (!keep) {
          child.removeAttribute(attribute.name);
        }
      }
      if (child.tagName === "A") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noreferrer");
      }
      visit(child);
    }
  };
  visit(template.content as unknown as Element);
  return template.innerHTML;
}

function formatCommandActivity(
  activity: NonNullable<PeskSettings["codexHistory"][number]["activity"]>,
): string {
  return [
    activity.command ? `$ ${activity.command}` : "",
    activity.cwd ? `cwd: ${activity.cwd}` : "",
    activity.output ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function fileChangeLineClass(line: string): string {
  if (line.startsWith("  +") && !line.startsWith("  +++")) {
    return "codex-file-change-added";
  }
  if (line.startsWith("  -") && !line.startsWith("  ---")) {
    return "codex-file-change-removed";
  }
  if (line.startsWith("  @@")) {
    return "codex-file-change-hunk";
  }
  return "codex-file-change-context";
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}

function formatDuration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatReset(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatPlan(plan: string): string {
  return plan
    .replaceAll("_", " ")
    .replace(/(^| )\S/g, (letter) => letter.toUpperCase());
}

function formatRateLimitDetails(
  limits: NonNullable<PeskSettings["codexRateLimits"]>,
): string[] {
  const formatWindow = (
    label: string,
    window: typeof limits.primary,
  ): string => {
    if (!window) return `${label}: unavailable`;
    const reset = window.resetsAt
      ? ` · resets ${formatReset(window.resetsAt)}`
      : "";
    return `${label}: ${Math.round(window.usedPercent)}% used${reset}`;
  };
  return [
    formatWindow("Quota", limits.primary),
    limits.secondary ? formatWindow("Secondary", limits.secondary) : "",
    limits.credits?.unlimited
      ? "Credits: unlimited"
      : limits.credits?.balance
        ? `Credits: ${limits.credits.balance}`
        : "",
    limits.individualLimit
      ? `Monthly: ${Math.round(limits.individualLimit.remainingPercent)}% remaining`
      : "",
    limits.planType ? `Plan: ${formatPlan(limits.planType)}` : "",
    limits.rateLimitReachedType
      ? `Status: ${formatPlan(limits.rateLimitReachedType)}`
      : limits.spendControlReached
        ? "Status: spend control reached"
        : "",
  ].filter(Boolean);
}
