import { marked } from "../../vendor/marked.js";
import { matchesShortcut } from "../../shared/shortcuts.js";

const slashCommands = [
  { command: "/plan", description: "Switch to Plan mode" },
  { command: "/goal", description: "Usage: /goal [<objective>|clear|edit|pause|resume]" },
  { command: "/default", description: "Switch to Default mode" },
  { command: "/new", description: "Start a new Codex session" },
  { command: "/fork", description: "Fork the current session" },
  { command: "/archive", description: "Archive the current session" },
  { command: "/delete", description: "Permanently delete the current session" },
  { command: "/review", description: "Review current changes" },
  { command: "/exec", description: "Run a sandboxed command" },
];

export class CodexRenderer {
  private readonly webChat = document.body.classList.contains("web-chat");
  private state: RendererState;
  private historyInitialized = false;
  private workingTimer: number | undefined;
  private workingLabelTimer: number | undefined;
  private workingLabelSince: number | undefined;
  private selectedMessageIndex = -1;
  private readonly rateLimit: HTMLElement;
  private readonly goal: HTMLElement;
  private readonly commandNotice: HTMLElement;
  private readonly statusDock?: HTMLElement;
  private readonly fileSuggestions: HTMLElement;
  private suggestionInput: HTMLTextAreaElement;
  private fileSearchSerial = 0;
  private fileSuggestionResults: FuzzyFileSearchResult[] = [];
  private slashCommandResults: typeof slashCommands = [];
  private suggestionKind: "file" | "command" | undefined;
  private fileSuggestionIndex = -1;
  private sessionNavigationIds: string[] = [];
  private pendingSessionId: string | undefined;
  private renderedUserInputRequestId: string | number | undefined;
  private activeUserInputQuestionId: string | undefined;
  private userInputQuestionIndex = 0;
  private userInputAnswers: Record<string, string[]> = {};
  private readonly dismissedPlanConfirmations = new Set<string>();
  private activePlanConfirmation: { key: string; planText: string } | undefined;
  private reviewPromptOpen = false;
  private pendingImages: Array<{ url: string; name: string }> = [];
  private readonly imageAttachments = document.getElementById("codex-image-attachments");
  private readonly imageInput = document.getElementById(
    "codex-image-input",
  ) as HTMLInputElement | null;
  private renderedHistoryStructureKey = "";
  private readonly renderedMessageContents = new Map<string, HTMLElement>();
  private readonly renderedMessageTexts = new Map<string, string>();
  private renderedHistoryKeys: string[] = [];
  private renderedPlanDetails = new Map<string, string>();
  private planRenderTimer: number | undefined;
  private pendingPlanHistory: RendererState["codex"]["history"] | undefined;
  private readonly readOnlyStatus =
    document.getElementById("codex-read-only") ?? document.createElement("div");

  /** Returns the number of active file or slash-command suggestions. */
  private suggestionCount(): number {
    return this.suggestionKind === "command"
      ? this.slashCommandResults.length
      : this.fileSuggestionResults.length;
  }

  /** Creates the renderer and wires chat, history, and composer events. */
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
    this.suggestionInput = input;
    this.renderWorkingStatus();
    this.renderStatusDock();
    this.renderCommandMode();
    sessionSelect.addEventListener("change", () => {
      if (sessionSelect.value) window.peskApi.selectCodexThread(sessionSelect.value);
    });
    sessionCopy.addEventListener("click", () => void this.copySessionId());
    this.history.addEventListener("scroll", () => {
      if (
        this.state.codex.hasOlderHistory &&
        !this.state.codex.historyLoading &&
        this.history.scrollTop <= 48
      ) {
        void this.loadOlderHistory();
      }
    });
    this.steerButton?.addEventListener("click", () => {
      const prompt = this.input.value.trim();
      if (!prompt) return;
      void window.peskApi.steerCodexTurn(prompt).then((next) => {
        this.input.value = "";
        this.resizeInput();
        this.updateState(next);
        this.input.focus();
      });
    });
    chat.addEventListener("mousedown", (event) => event.stopPropagation());
    chat.addEventListener("wheel", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => void this.submit(event));
    this.setupImageAttachments();
    input.addEventListener("input", () => {
      this.suggestionInput = input;
      this.resizeInput();
      this.renderCommandMode();
      void this.updateSuggestions(input);
    });
    input.addEventListener("keydown", (event) => this.handleInputKeydown(event));
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
        document.documentElement.style.removeProperty("--web-chat-viewport-height");
      };
      window.addEventListener("pagehide", removeListeners, { once: true });
    }
    this.resizeInput();
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

  /** Applies renderer state and refreshes all visible chat controls. */
  updateState(next: RendererState): void {
    if (next.codex.threadId !== this.state.codex.threadId) {
      this.historyInitialized = false;
      this.renderedHistoryStructureKey = "";
      this.renderedHistoryKeys = [];
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
    this.renderCommandNotice(next.codex.commandNotice);
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
      this.sessionSelect.value = next.codex.threadId ?? "";
    }
    this.sessionSelect.disabled = !displayedThreads.length;
    this.sessionCopy.disabled = !next.codex.threadId;
    this.renderHistory(
      next.codex.history,
      Boolean(next.codex.threadId),
      next.codex.queuedSubmissions,
    );
    this.renderWorkingStatus();
    this.renderStatusDock();
    this.renderCommandMode();
    this.renderTokenUsage();
    this.renderRateLimit();
    this.renderGoal();
    this.renderUserInput();
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
      this.reviewPromptOpen,
    );
    if (this.modeToggle) {
      const plan = next.codex.collaborationMode === "plan";
      this.modeToggle.hidden = !plan;
      this.modeToggle.textContent = plan ? "Plan" : "Default";
      this.modeToggle.classList.toggle("codex-mode-plan", plan);
      this.modeToggle.title = plan ? "Plan mode enabled for the next turn" : "Default mode";
    }
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

  /** Focuses the main prompt input on the next animation frame. */
  focusInput(): void {
    requestAnimationFrame(() => this.input.focus());
  }

  /** Keeps the web composer visible when the mobile viewport changes. */
  private keepWebChatFormVisible(): void {
    if (!this.webChat) return;
    requestAnimationFrame(() => {
      this.history.scrollTop = this.history.scrollHeight;
    });
  }

  /** Requests native focus and focuses the chat input. */
  private focusChatInput(): void {
    window.peskApi.focusCodexInput();
    this.focusInput();
  }

  /** Validates and submits the current prompt or review request. */
  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.suggestionCount()) {
      this.selectSuggestion(this.fileSuggestionIndex);
      return;
    }
    const prompt = this.input.value.trim();
    if (!prompt && !this.pendingImages.length) return;
    if (this.state.codex.readOnly) return;
    if (/^\/review$/i.test(prompt)) {
      if (this.state.codex.status !== "idle" || !this.state.codex.threadId) {
        return;
      }
      this.input.value = "";
      this.hideFileSuggestions();
      this.resizeInput();
      this.reviewPromptOpen = true;
      this.form.hidden = true;
      this.renderUserInput(true);
      return;
    }
    const keepInputFocused = this.webChat;
    if (keepInputFocused) this.input.focus();
    const images = this.pendingImages;
    const next = images.length
      ? await window.peskApi.submitCodexPrompt(prompt, images)
      : await window.peskApi.submitCodexPrompt(prompt);
    this.input.value = "";
    this.pendingImages = [];
    this.renderImageAttachments();
    this.resizeInput();
    this.renderCommandMode();
    this.updateState(next);
    this.history.scrollTop = this.history.scrollHeight;
    if (keepInputFocused) {
      this.input.focus();
      this.keepWebChatFormVisible();
    } else {
      this.input.focus();
    }
  }

  /** Installs image paste, drop, and file-picker handlers. */
  private setupImageAttachments(): void {
    const dropTarget = this.form;
    this.imageInput?.addEventListener("change", () => {
      void this.addImageFiles(this.imageInput?.files);
      window.peskApi.setChatFileDialogOpen(false);
      if (this.imageInput) this.imageInput.value = "";
    });
    this.input.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      void this.addImageFiles(files);
    });
    document.getElementById("codex-image-select")?.addEventListener("click", () => {
      window.peskApi.setChatFileDialogOpen(true);
      this.imageInput?.click();
    });
    dropTarget.addEventListener("dragover", (event) => {
      if (!this.hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropTarget.classList.add("codex-drop-active");
    });
    dropTarget.addEventListener("dragleave", (event) => {
      if (event.relatedTarget instanceof Node && dropTarget.contains(event.relatedTarget)) return;
      dropTarget.classList.remove("codex-drop-active");
    });
    dropTarget.addEventListener("drop", (event) => {
      if (!this.hasImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      dropTarget.classList.remove("codex-drop-active");
      void this.addImageFiles(event.dataTransfer?.files);
    });
  }

  /** Reports whether a data transfer contains image files. */
  private hasImageFiles(dataTransfer: DataTransfer | null): boolean {
    return Boolean(
      Array.from(dataTransfer?.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      ),
    );
  }

  /** Converts accepted image files to data URLs for pending attachments. */
  private async addImageFiles(files: Iterable<File> | null | undefined): Promise<void> {
    for (const file of Array.from(files ?? [])) {
      if (!file.type.startsWith("image/")) continue;
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (url) this.pendingImages.push({ url, name: file.name });
    }
    this.renderImageAttachments();
  }

  /** Renders the current pending image attachments. */
  private renderImageAttachments(): void {
    if (!this.imageAttachments) return;
    this.imageAttachments.replaceChildren();
    this.imageAttachments.hidden = !this.pendingImages.length;
    this.pendingImages.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "codex-image-attachment";
      const preview = document.createElement("img");
      preview.src = image.url;
      preview.alt = "";
      const name = document.createElement("span");
      name.textContent = image.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${image.name}`);
      remove.addEventListener("click", () => {
        this.pendingImages.splice(index, 1);
        this.renderImageAttachments();
      });
      item.append(preview, name, remove);
      this.imageAttachments?.append(item);
    });
  }

  /** Updates the composer indicator for shell and exec command modes. */
  private renderCommandMode(): void {
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

  /** Renders pending user-input, approval, plan, and review prompts. */
  private renderUserInput(force = false): void {
    const container = this.userInput;
    const pending = this.state.codex.pendingUserInput;
    const pendingApproval = this.state.codex.pendingApproval;
    const planConfirmation = this.activePlanConfirmation;
    if (!container) return;
    if (!pending && !pendingApproval && !planConfirmation && !this.reviewPromptOpen) {
      container.replaceChildren();
      container.hidden = true;
      this.renderedUserInputRequestId = undefined;
      this.activeUserInputQuestionId = undefined;
      this.userInputQuestionIndex = 0;
      this.userInputAnswers = {};
      return;
    }
    if (!pending && !pendingApproval && !planConfirmation && this.reviewPromptOpen) {
      this.renderReviewPrompt(force);
      return;
    }
    if (!pending && !pendingApproval && planConfirmation) {
      const existing = container.querySelector<HTMLElement>(".codex-plan-implementation-prompt");
      if (!force && existing?.dataset.planConfirmationKey === planConfirmation.key) {
        return;
      }
      container.replaceChildren();
      container.hidden = false;
      this.renderedUserInputRequestId = undefined;
      this.activeUserInputQuestionId = undefined;
      this.userInputQuestionIndex = 0;
      this.userInputAnswers = {};
      container.append(
        this.renderPlanImplementationPrompt(planConfirmation.key, planConfirmation.planText),
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

    const requestChanged = this.renderedUserInputRequestId !== pending.requestId;
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
    instructions.textContent = "Use ↑/↓ to select, Tab to add a note, and Enter to submit.";
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
        for (const radio of fieldset.querySelectorAll<HTMLInputElement>("input[type='radio']")) {
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
      note.setAttribute("aria-label", `Note for ${question.header || question.question}`);
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
      this.userInputQuestionIndex < pending.questions.length - 1 ? "Next" : "Submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = Array.from(form.querySelectorAll<HTMLInputElement>("[data-question-id]"))
        .filter(
          (input) =>
            input.dataset.questionId === question.id && (input.type !== "radio" || input.checked),
        )
        .map((input) => (input.value ?? "").trim())
        .filter(Boolean);
      this.userInputAnswers[question.id] = selected;
      if (this.userInputQuestionIndex < pending.questions.length - 1) {
        this.userInputQuestionIndex += 1;
        this.activeUserInputQuestionId = pending.questions[this.userInputQuestionIndex]?.id;
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
        (matchesShortcut(event, "questionNext") || matchesShortcut(event, "questionPrevious")) &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "radio"
      ) {
        const options = Array.from(
          event.target
            .closest("fieldset")
            ?.querySelectorAll<HTMLInputElement>("input[type='radio']") ?? [],
        );
        const currentIndex = options.indexOf(event.target);
        if (currentIndex >= 0 && options.length > 1) {
          event.preventDefault();
          const direction = matchesShortcut(event, "questionNext") ? 1 : -1;
          const next = options[(currentIndex + direction + options.length) % options.length];
          for (const radio of options) radio.checked = false;
          next.checked = true;
          for (const radio of options) radio.tabIndex = radio === next ? 0 : -1;
          next.focus();
        }
        return;
      }
      if (
        matchesShortcut(event, "questionToNote") &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "radio"
      ) {
        const fieldset = event.target.closest("fieldset");
        const note = fieldset?.querySelector<HTMLInputElement>("input[data-note='true']");
        const noteLabel = note?.closest("label");
        if (note && noteLabel) {
          event.preventDefault();
          note.focus();
        }
        return;
      }
      if (
        matchesShortcut(event, "questionFromNote") &&
        event.target instanceof HTMLInputElement &&
        event.target.dataset.note === "true"
      ) {
        const fieldset = event.target.closest("fieldset");
        const selected = fieldset?.querySelector<HTMLInputElement>("input[type='radio']:checked");
        event.preventDefault();
        event.target.value = "";
        const noteLabel = event.target.closest("label");
        selected?.focus();
        return;
      }
      if (
        matchesShortcut(event, "submit") &&
        event.target instanceof HTMLInputElement &&
        (event.target.type === "radio" ||
          event.target.type === "text" ||
          event.target.type === "password")
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

  /** Renders the review confirmation prompt when a review is active. */
  private renderReviewPrompt(force: boolean): void {
    const container = this.userInput;
    if (!container) return;
    if (!force && container.querySelector(".codex-review-prompt")) return;
    container.replaceChildren();
    container.hidden = false;
    const title = document.createElement("strong");
    title.textContent = "Review current changes";
    container.append(title);
    const instructions = document.createElement("small");
    instructions.className = "codex-user-input-instructions";
    instructions.textContent = "Codex will use this conversation and the current project changes.";
    container.append(instructions);
    const form = document.createElement("form");
    form.className = "codex-user-input-form codex-review-prompt";
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "What would you like Codex to review?";
    fieldset.append(legend);
    const input = document.createElement("textarea");
    input.rows = 4;
    input.placeholder = "For example: Check for bugs and missing tests.";
    input.setAttribute("aria-label", "Review instructions");
    input.addEventListener("input", () => {
      this.suggestionInput = input;
      void this.updateSuggestions(input, false);
    });
    input.addEventListener("keydown", (event) => {
      this.suggestionInput = input;
      if (this.handleSuggestionKeydown(event)) return;
      if (matchesShortcut(event, "dismissSuggestions")) {
        event.preventDefault();
        this.hideFileSuggestions();
        cancel.click();
        return;
      }
      if (event.key !== "Enter") return;
      if (this.webChat && matchesShortcut(event, "submit")) {
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = `${input.value.slice(0, start)}\n${input.value.slice(end)}`;
        input.selectionStart = start + 1;
        input.selectionEnd = start + 1;
        return;
      }
      if (matchesShortcut(event, "newline")) {
        event.preventDefault();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = `${input.value.slice(0, start)}\n${input.value.slice(end)}`;
        input.selectionStart = start + 1;
        input.selectionEnd = start + 1;
        return;
      }
      if (matchesShortcut(event, "submit")) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const inputArea = document.createElement("div");
    inputArea.className = "codex-review-input-area";
    inputArea.append(input, this.fileSuggestions);
    fieldset.append(inputArea);
    form.append(fieldset);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Submit review";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.reviewPromptOpen = false;
      this.hideFileSuggestions();
      this.form.hidden = false;
      this.form.append(this.fileSuggestions);
      this.renderUserInput(true);
      this.input.focus();
    });
    form.append(submit, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      submit.disabled = true;
      cancel.disabled = true;
      this.reviewPromptOpen = false;
      this.hideFileSuggestions();
      this.form.hidden = false;
      this.form.append(this.fileSuggestions);
      const next = await window.peskApi.startCodexReview(value);
      this.updateState(next);
      this.input.focus();
    });
    container.append(form);
    if (force) {
      input.focus();
      requestAnimationFrame(() => {
        input.focus();
        this.history.scrollTop = this.history.scrollHeight;
      });
    }
  }

  /** Renders the approval controls for a pending tool request. */
  private renderApprovalInput(
    pending: NonNullable<RendererState["codex"]["pendingApproval"]>,
    force: boolean,
  ): void {
    const container = this.userInput;
    if (!container) return;
    const existing = container.querySelector("form");
    if (!force && existing?.dataset.approvalRequestId === String(pending.requestId)) return;
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
      const selected = form.querySelector<HTMLInputElement>("input[type='radio']:checked");
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

  /** Focuses the currently selected pending-question option. */
  focusUserInputOption(): void {
    const container = this.userInput;
    if (!container || container.hidden) return;
    const questionId = this.activeUserInputQuestionId;
    const fieldset = Array.from(container.querySelectorAll<HTMLElement>("fieldset")).find(
      (candidate) => !questionId || candidate.dataset.questionId === questionId,
    );
    const option =
      fieldset?.querySelector<HTMLInputElement>("input[type='radio']:checked") ??
      fieldset?.querySelector<HTMLInputElement>("input[type='radio']");
    option?.focus();
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

  /** Resizes the prompt input while preserving bottom anchoring. */
  private resizeInput(): void {
    const maxHeight = 220;
    const wasAtBottom =
      this.history.scrollTop + this.history.clientHeight >= this.history.scrollHeight - 24;
    this.input.style.height = "auto";
    const height = Math.min(this.input.scrollHeight, maxHeight);
    this.input.style.height = `${height}px`;
    this.input.style.overflowY = this.input.scrollHeight > maxHeight ? "auto" : "hidden";
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        this.history.scrollTop = this.history.scrollHeight;
      });
    }
  }

  /** Scrolls history to the bottom after the next layout pass. */
  private scrollHistoryToBottom(): void {
    const scroll = (): void => {
      this.history.scrollTop = this.history.scrollHeight;
      requestAnimationFrame(() => {
        this.history.scrollTop = this.history.scrollHeight;
      });
    };
    requestAnimationFrame(scroll);
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

  /** Applies the selected-message styling and accessibility state. */
  private applySelectedMessage(): void {
    const messages = Array.from(this.history.querySelectorAll<HTMLElement>(".codex-message"));
    messages.forEach((message, index) => {
      const selected = index === this.selectedMessageIndex;
      message.classList.toggle("codex-message-selected", selected);
      message.setAttribute("aria-selected", String(selected));
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

  /** Copies the selected user message into the composer. */
  private copySelectedMessageToInput(): boolean {
    const text = this.selectedMessageText();
    if (!text) return false;
    this.input.value = text;
    this.resizeInput();
    this.focusInput();
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

  /** Handles keyboard navigation within the suggestion list. */
  private handleSuggestionKeydown(event: KeyboardEvent): boolean {
    if (!this.suggestionCount()) return false;
    if (matchesShortcut(event, "suggestionNext") || matchesShortcut(event, "suggestionPrevious")) {
      event.preventDefault();
      const direction = matchesShortcut(event, "suggestionNext") ? 1 : -1;
      const suggestionCount = this.suggestionCount();
      this.fileSuggestionIndex =
        (this.fileSuggestionIndex + direction + suggestionCount) % suggestionCount;
      this.renderFileSuggestions();
      return true;
    }
    if (matchesShortcut(event, "submit")) {
      event.preventDefault();
      this.selectSuggestion(this.fileSuggestionIndex);
      return true;
    }
    if (matchesShortcut(event, "dismissSuggestions")) {
      event.preventDefault();
      this.hideFileSuggestions();
      return true;
    }
    return false;
  }

  /** Handles prompt editing, submission, and suggestion shortcuts. */
  private handleInputKeydown(event: KeyboardEvent): void {
    if (this.handleSuggestionKeydown(event)) {
      return;
    }
    if (
      matchesShortcut(event, "interrupt") &&
      (this.state.codex.status === "working" || this.state.codex.status === "waiting")
    ) {
      event.preventDefault();
      void window.peskApi.interruptCodexTurn();
      return;
    }
    if (event.key !== "Enter") return;
    if (this.webChat && matchesShortcut(event, "submit")) {
      event.preventDefault();
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
      this.input.selectionStart = start + 1;
      this.input.selectionEnd = start + 1;
      this.resizeInput();
      return;
    }
    if (matchesShortcut(event, "newline")) {
      event.preventDefault();
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
      this.input.selectionStart = start + 1;
      this.input.selectionEnd = start + 1;
      this.resizeInput();
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
        (this.state.codex.status === "working" || this.state.codex.status === "waiting") &&
        this.state.codex.threadId
      ) {
        void window.peskApi.steerCodexTurn(prompt).then((next) => {
          this.input.value = "";
          this.resizeInput();
          this.updateState(next);
        });
      } else {
        this.form.requestSubmit();
      }
    }
  }

  /** Updates file and slash-command suggestions for the prompt input. */
  private async updateSuggestions(
    input: HTMLTextAreaElement = this.suggestionInput,
    allowCommands = true,
  ): Promise<void> {
    this.suggestionInput = input;
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
    if (allowCommands && commandMatch) {
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
      this.state.codex.cwd ? [this.state.codex.cwd] : [],
    );
    if (serial !== this.fileSearchSerial) return;
    this.suggestionKind = "file";
    this.fileSuggestionResults = results.slice(0, 8);
    this.fileSuggestionIndex = this.fileSuggestionResults.length ? 0 : -1;
    this.renderFileSuggestions();
  }

  /** Renders the currently available prompt suggestions. */
  private renderFileSuggestions(): void {
    this.fileSuggestions.replaceChildren();
    const results =
      this.suggestionKind === "command" ? this.slashCommandResults : this.fileSuggestionResults;
    this.fileSuggestions.hidden = !results.length;
    if (this.suggestionKind === "command") {
      this.slashCommandResults.forEach((result, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "codex-file-suggestion codex-command-suggestion";
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(index === this.fileSuggestionIndex));
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
          this.scrollSuggestionIntoView(button);
        }
      });
      return;
    }
    this.fileSuggestionResults.forEach((result, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "codex-file-suggestion";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.fileSuggestionIndex));
      const name = document.createElement("span");
      name.className = "codex-file-suggestion-name";
      name.textContent = result.file_name;
      const separatorIndex = Math.max(result.path.lastIndexOf("/"), result.path.lastIndexOf("\\"));
      const parentPath = document.createElement("span");
      parentPath.className = "codex-file-suggestion-path";
      parentPath.textContent = separatorIndex >= 0 ? result.path.slice(0, separatorIndex) : ".";
      const matchType = document.createElement("span");
      matchType.className = "codex-file-suggestion-type";
      matchType.textContent = result.match_type;
      button.append(name, parentPath, matchType);
      button.title = result.path;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.selectSuggestion(index));
      this.fileSuggestions.append(button);
      if (index === this.fileSuggestionIndex) {
        this.scrollSuggestionIntoView(button);
      }
    });
  }

  /** Scrolls the active suggestion into the visible list area. */
  private scrollSuggestionIntoView(button: HTMLElement): void {
    button.scrollIntoView?.({ block: "nearest" });
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < this.fileSuggestions.scrollTop) {
      this.fileSuggestions.scrollTop = top;
    } else if (bottom > this.fileSuggestions.scrollTop + this.fileSuggestions.clientHeight) {
      this.fileSuggestions.scrollTop = bottom - this.fileSuggestions.clientHeight;
    }
  }

  /** Inserts the selected suggestion into the prompt input. */
  private selectSuggestion(index: number): void {
    const input = this.suggestionInput;
    if (this.suggestionKind === "command") {
      const result = this.slashCommandResults[index];
      if (!result) return;
      input.value = `${result.command} `;
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
      this.hideFileSuggestions();
      if (input === this.input) {
        this.resizeInput();
        this.renderCommandMode();
      }
      input.focus();
      return;
    }
    const result = this.fileSuggestionResults[index];
    if (!result) return;
    const cursor = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursor);
    const match = beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) {
      this.hideFileSuggestions();
      return;
    }
    const tokenStart = cursor - match[1].length - 1;
    input.value = `${input.value.slice(0, tokenStart)}${result.path} ${input.value.slice(cursor)}`;
    const nextCursor = tokenStart + result.path.length + 1;
    input.selectionStart = nextCursor;
    input.selectionEnd = nextCursor;
    this.hideFileSuggestions();
    if (input === this.input) this.resizeInput();
    input.focus();
  }

  /** Clears and hides all prompt suggestions. */
  private hideFileSuggestions(): void {
    this.fileSearchSerial += 1;
    this.fileSuggestionResults = [];
    this.slashCommandResults = [];
    this.suggestionKind = undefined;
    this.fileSuggestionIndex = -1;
    this.fileSuggestions.hidden = true;
    this.fileSuggestions.replaceChildren();
  }

  /**
   * Renders chat history incrementally when possible, preserving message nodes,
   * expanded activities, and the user's scroll position while reading history.
   */
  private renderHistory(
    history: RendererState["codex"]["history"],
    sessionConnected = false,
    queuedSubmissions: RendererState["codex"]["queuedSubmissions"] = [],
  ): void {
    this.updateActivePlanConfirmation(history);
    const structureKey = `${historyStructureKey(history)}|queue:${queuedSubmissions
      .map((submission) => `${submission.id}:${submission.text}`)
      .join("|")}`;
    const planContentChanged = (history ?? []).some((message, index) => {
      if (message.activity?.kind !== "plan") return false;
      const activityKey = historyMessageKeyForRenderer(message, index);
      return this.renderedPlanDetails.get(activityKey) !== (message.activity.details ?? "");
    });
    const historyKeys = (history ?? []).map(historyMessageKeyForRenderer);
    const canIncrementallyAppend =
      this.historyInitialized &&
      !queuedSubmissions.length &&
      !planContentChanged &&
      isPrefix(this.renderedHistoryKeys, historyKeys);
    if (canIncrementallyAppend && historyKeys.length > this.renderedHistoryKeys.length) {
      const wasAtBottom =
        this.history.scrollTop + this.history.clientHeight >= this.history.scrollHeight - 24;
      this.history
        .querySelectorAll(".codex-empty-history, .codex-session-connected")
        .forEach((placeholder) => placeholder.remove());
      const openActivityKeys = new Set(
        Array.from(this.history.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
          .filter((details) => details.open)
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      const renderedActivityKeys = new Set(
        Array.from(this.history.querySelectorAll<HTMLElement>("details[data-activity-key]"))
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      for (let index = this.renderedHistoryKeys.length; index < historyKeys.length; index += 1) {
        this.history.append(
          this.createMessageBubble(history[index], index, openActivityKeys, renderedActivityKeys),
        );
      }
      this.renderedHistoryKeys = historyKeys;
      this.renderedHistoryStructureKey = structureKey;
      this.applySelectedMessage();
      if (wasAtBottom) this.scrollHistoryToBottom();
      return;
    }
    const canIncrementallyPrepend =
      this.historyInitialized &&
      !queuedSubmissions.length &&
      !planContentChanged &&
      isSuffix(this.renderedHistoryKeys, historyKeys);
    if (canIncrementallyPrepend && historyKeys.length > this.renderedHistoryKeys.length) {
      const previousHeight = this.history.scrollHeight;
      const previousTop = this.history.scrollTop;
      const openActivityKeys = new Set(
        Array.from(this.history.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
          .filter((details) => details.open)
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      const renderedActivityKeys = new Set(
        Array.from(this.history.querySelectorAll<HTMLElement>("details[data-activity-key]"))
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      const fragment = document.createDocumentFragment();
      for (
        let index = 0;
        index < historyKeys.length - this.renderedHistoryKeys.length;
        index += 1
      ) {
        fragment.append(
          this.createMessageBubble(history[index], index, openActivityKeys, renderedActivityKeys),
        );
      }
      this.history.prepend(fragment);
      this.renderedHistoryKeys = historyKeys;
      this.renderedHistoryStructureKey = structureKey;
      this.applySelectedMessage();
      this.history.scrollTop = previousTop + (this.history.scrollHeight - previousHeight);
      return;
    }
    if (
      this.renderedHistoryStructureKey &&
      structureKey === this.renderedHistoryStructureKey &&
      this.schedulePlanUpdates(history)
    ) {
      this.updateRenderedMessageContent(history);
      return;
    }
    if (this.planRenderTimer !== undefined) {
      window.clearTimeout(this.planRenderTimer);
      this.planRenderTimer = undefined;
      this.pendingPlanHistory = undefined;
    }
    const wasAtBottom =
      this.historyInitialized &&
      this.history.scrollTop + this.history.clientHeight >= this.history.scrollHeight - 24;
    const openActivityKeys = new Set(
      Array.from(this.history.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
        .filter((details) => details.open)
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    const renderedActivityKeys = new Set(
      Array.from(this.history.querySelectorAll<HTMLElement>("details[data-activity-key]"))
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    this.history.replaceChildren();
    this.renderedHistoryStructureKey = structureKey;
    this.renderedHistoryKeys = historyKeys;
    this.renderedMessageContents.clear();
    this.renderedMessageTexts.clear();
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
      this.history.append(
        this.createMessageBubble(message, index, openActivityKeys, renderedActivityKeys),
      );
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
        const text = document.createElement("span");
        text.textContent = submission.text || "Image attachment";
        item.append(text);
        for (const image of submission.images ?? []) {
          const preview = document.createElement("img");
          preview.className = "codex-queued-submission-image";
          preview.src = image.url;
          preview.alt = image.name ? `Queued image: ${image.name}` : "Queued image";
          item.append(preview);
        }
        item.title = "Queued follow-up";
        queue.append(item);
      }
      this.history.append(queue);
    }
    this.applySelectedMessage();
    if (!this.historyInitialized || wasAtBottom || planContentChanged) {
      this.scrollHistoryToBottom();
    }
    this.historyInitialized = true;
  }

  /** Creates a DOM bubble for one history message. */
  private createMessageBubble(
    message: RendererState["codex"]["history"][number],
    index: number,
    openActivityKeys: Set<string>,
    renderedActivityKeys: Set<string>,
  ): HTMLElement {
    const bubble = document.createElement("div");
    bubble.className = `codex-message codex-message-${message.role}`;
    if (message.activity) {
      bubble.classList.add(`codex-activity-${message.activity.kind}`);
      if (
        message.activity.kind === "command" &&
        (message.activity.status === "failed" || message.activity.status === "declined")
      ) {
        bubble.classList.add("codex-activity-command-failed");
      }
      if (isReviewActivity(message.activity)) bubble.classList.add("codex-activity-review");
      if (message.activity.output) bubble.classList.add("codex-activity-output");
    }
    if (message.temporary) bubble.classList.add("codex-message-working");
    const activityKey = historyMessageKeyForRenderer(message, index);
    if (message.itemId) bubble.dataset.messageItemId = message.itemId;
    if (message.activity?.kind === "plan") {
      this.renderedPlanDetails.set(activityKey, message.activity.details ?? "");
    }
    bubble.append(
      this.renderMessageContent(message, activityKey, openActivityKeys, renderedActivityKeys),
    );
    const content = bubble.firstElementChild;
    if (content instanceof HTMLElement && !message.activity) {
      this.renderedMessageContents.set(activityKey, content);
      this.renderedMessageTexts.set(activityKey, message.text);
    }
    const time = document.createElement("time");
    time.className = "codex-message-time";
    time.textContent = new Date(message.timestamp ?? Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    bubble.append(time);
    if (message.approval) this.renderApproval(bubble, message);
    return bubble;
  }

  /** Updates rendered message content without rebuilding stable nodes. */
  private updateRenderedMessageContent(history: RendererState["codex"]["history"]): void {
    for (const [index, message] of (history ?? []).entries()) {
      if (message.activity || (message.images?.length ?? 0) > 0) continue;
      const activityKey = historyMessageKeyForRenderer(message, index);
      if (this.renderedMessageTexts.get(activityKey) === message.text) continue;
      const content = this.renderedMessageContents.get(activityKey);
      if (!content) return;
      if (message.role === "assistant") {
        content.innerHTML = renderMarkdown(message.text);
      } else {
        content.textContent = message.text;
      }
      this.renderedMessageTexts.set(activityKey, message.text);
    }
  }

  /** Synchronizes the active plan implementation confirmation. */
  private updateActivePlanConfirmation(history: RendererState["codex"]["history"]): void {
    this.activePlanConfirmation = undefined;
    const lastMessage = history?.[history.length - 1];
    let planActivityIndex = -1;
    let planActivityText = "";
    const activityIndexes = lastMessage?.activity?.kind === "plan" ? [history.length - 1] : [];
    for (const index of activityIndexes) {
      const activity = history[index].activity;
      if (
        activity?.kind === "plan" &&
        (activity.status === "completed" || activity.status === "complete") &&
        (activity.details ?? history[index].text).length > planActivityText.length
      ) {
        planActivityIndex = index;
        planActivityText = activity.details ?? history[index].text;
      }
    }
    if (planActivityIndex < 0) {
      return;
    }
    const planActivity = history[planActivityIndex];
    const activityKey = historyMessageKeyForRenderer(planActivity, planActivityIndex);
    if (this.dismissedPlanConfirmations.has(activityKey)) return;
    this.activePlanConfirmation = {
      key: activityKey,
      planText: planActivityText,
    };
  }

  /** Batches streamed plan updates for efficient rendering. */
  private schedulePlanUpdates(history: RendererState["codex"]["history"]): boolean {
    const planUpdates = (history ?? []).filter((message, index) => {
      if (message.activity?.kind !== "plan") return false;
      const activityKey = historyMessageKeyForRenderer(message, index);
      return this.renderedPlanDetails.get(activityKey) !== (message.activity.details ?? "");
    });
    if (!planUpdates.length) return true;
    const activityDetails = Array.from(
      this.history.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"),
    );
    if (
      !planUpdates.every((message, index) => {
        const historyIndex = history.indexOf(message);
        const activityKey = historyMessageKeyForRenderer(
          message,
          historyIndex >= 0 ? historyIndex : index,
        );
        return activityDetails.some((details) => details.dataset.activityKey === activityKey);
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
          const activityKey = historyMessageKeyForRenderer(message, index);
          const details = Array.from(
            this.history.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"),
          ).find((candidate) => candidate.dataset.activityKey === activityKey);
          const content = details?.querySelector<HTMLElement>(".codex-plan-content");
          if (!content) {
            this.renderHistory(nextHistory);
            return;
          }
          content.innerHTML = renderMarkdown(message.activity.details ?? "");
          this.renderedPlanDetails.set(activityKey, message.activity.details ?? "");
        }
        requestAnimationFrame(() => {
          this.history.scrollTop = this.history.scrollHeight;
        });
      }, 100);
    }
    return true;
  }

  /** Renders markdown, attachments, and activity details for a message. */
  private renderMessageContent(
    message: RendererState["codex"]["history"][number],
    activityKey: string,
    openActivityKeys: Set<string>,
    renderedActivityKeys: Set<string>,
  ): HTMLElement {
    if (message.activity?.kind === "command") {
      const details = document.createElement("details");
      details.className = "codex-command-details";
      details.dataset.activityKey = activityKey;
      details.open =
        openActivityKeys.has(activityKey) ||
        (!renderedActivityKeys.has(activityKey) && message.activity.userInitiated === true);
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
      details.open = openActivityKeys.has(activityKey) || !renderedActivityKeys.has(activityKey);
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
      details.open =
        openActivityKeys.has(activityKey) ||
        isReviewActivity(message.activity) ||
        message.activity.label === "contextCompaction";
      const summary = document.createElement("summary");
      const label = activityLabel(message.activity.kind);
      summary.textContent = `${label} · ${message.activity.status ?? "in progress"}`;
      if (message.activity.summary) {
        const query = document.createElement("span");
        query.className = "codex-activity-summary-detail";
        query.textContent = message.activity.summary.replace(/\s+/g, " ").trim();
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
    for (const image of message.images ?? []) {
      const preview = document.createElement("img");
      preview.className = "codex-message-image";
      preview.src = image.url;
      preview.alt = image.name ? `Attached image: ${image.name}` : "Attached image";
      content.append(preview);
    }
    return content;
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
        this.focusChatInput();
        return;
      }
      submit.disabled = true;
      const implementation = window.peskApi.implementCodexPlan(
        planText,
        selected === "clear-context",
      );
      void implementation.then((next) => {
        this.updateState(next);
        this.focusChatInput();
        this.renderHistory(this.state.codex.history, Boolean(this.state.codex.threadId));
      });
    });
    prompt.append(form);
    requestAnimationFrame(() => {
      form.querySelector<HTMLInputElement>("input[type='radio']")?.focus();
    });
    return prompt;
  }

  /** Creates the expandable file-change activity presentation. */
  private renderFileChangeActivity(
    activity: NonNullable<RendererState["codex"]["history"][number]["activity"]>,
    activityKey: string,
    openActivityKeys: Set<string>,
    renderedActivityKeys: Set<string>,
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "codex-file-change-details";
    details.dataset.activityKey = activityKey;
    details.open = openActivityKeys.has(activityKey) || !renderedActivityKeys.has(activityKey);

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

  /** Renders the working indicator and elapsed duration. */
  private renderWorkingStatus(): void {
    if (this.workingTimer !== undefined) window.clearInterval(this.workingTimer);
    this.workingTimer = undefined;
    const since = this.state.codex.workingSince;
    const worked = this.state.codex.workedElapsed;
    this.workingStatus.hidden =
      since === undefined && worked === undefined && !this.state.codex.interrupted;
    if (since === undefined) {
      this.workingStatus.classList.add("codex-working-status-complete");
      if (this.workingLabelTimer !== undefined) window.clearInterval(this.workingLabelTimer);
      this.workingLabelTimer = undefined;
      this.workingLabelSince = undefined;
      this.workingStatus.classList.toggle(
        "codex-working-status-interrupted",
        Boolean(this.state.codex.interrupted),
      );
      this.workingStatus.firstElementChild!.textContent = this.state.codex.interrupted
        ? "Conversation interrupted"
        : "Worked for";
      this.workingElapsed.textContent = formatElapsed(worked ?? 0);
      return;
    }
    this.workingStatus.classList.remove("codex-working-status-complete");
    this.workingStatus.classList.remove("codex-working-status-interrupted");
    if (this.workingLabelTimer === undefined || this.workingLabelSince !== since) {
      if (this.workingLabelTimer !== undefined) window.clearInterval(this.workingLabelTimer);
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

  /** Renders the status dock visibility and current status. */
  private renderStatusDock(): void {
    if (this.statusDock) {
      this.statusDock.hidden = this.commandNotice.hidden && this.workingStatus.hidden;
    }
  }

  /** Renders or hides the current command notice. */
  private renderCommandNotice(notice: string | undefined): void {
    this.commandNotice.hidden = !notice;
    this.commandNotice.replaceChildren();
    for (const [index, line] of (notice ?? "").split("\n").entries()) {
      const lineElement = document.createElement("div");
      lineElement.className =
        index === 0 ? "codex-command-notice-title" : "codex-command-notice-line";
      if (line.startsWith("Commands:")) lineElement.classList.add("codex-command-notice-commands");
      lineElement.textContent = line;
      this.commandNotice.append(lineElement);
    }
  }

  /** Renders the approval state for the current thread. */
  private renderApproval(
    bubble: HTMLElement,
    message: RendererState["codex"]["history"][number],
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
          window.peskApi.respondCodexPermission(approval.requestId ?? "", option.id),
        );
        actions.append(button);
      }
      bubble.append(actions);
    } else {
      const result = document.createElement("div");
      result.className = "codex-approval-result";
      result.textContent = approval.state === "approved" ? "Approved" : "Denied";
      bubble.append(result);
    }
  }
}

function activityLabel(
  kind: NonNullable<RendererState["codex"]["history"][number]["activity"]>["kind"],
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

function isReviewActivity(
  activity: NonNullable<RendererState["codex"]["history"][number]["activity"]>,
): boolean {
  return activity.label === "enteredReviewMode" || activity.label === "exitedReviewMode";
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

function historyStructureKey(history: RendererState["codex"]["history"]): string {
  return JSON.stringify(
    (history ?? []).map((message) => ({
      role: message.role,
      itemId: message.itemId,
      timestamp: message.timestamp,
      temporary: message.temporary,
      approval: message.approval,
      // Plain assistant text is streamed frequently. It is updated in place so
      // a long history does not get rebuilt for every token.
      text:
        message.activity?.kind === "plan"
          ? undefined
          : message.activity || message.role !== "assistant"
            ? message.text
            : undefined,
      images: message.images,
      activity: message.activity
        ? {
            ...message.activity,
            details: message.activity.kind === "plan" ? undefined : message.activity.details,
          }
        : undefined,
    })),
  );
}

function historyMessageKeyForRenderer(
  message: RendererState["codex"]["history"][number],
  index: number,
): string {
  return (
    message.itemId ?? `${message.turnId ?? "history"}:${message.role}:${message.timestamp ?? index}`
  );
}

function isPrefix(previous: string[], next: string[]): boolean {
  if (previous.length > next.length) return false;
  return previous.every((key, index) => key === next[index]);
}

function isSuffix(previous: string[], next: string[]): boolean {
  if (previous.length > next.length) return false;
  const offset = next.length - previous.length;
  return previous.every((key, index) => key === next[offset + index]);
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
    "IMG",
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
          child.tagName === "A"
            ? (name === "href" && /^(https?:|mailto:|#)/i.test(attribute.value)) || name === "title"
            : child.tagName === "IMG"
              ? (name === "src" &&
                  /^(https?:|data:image\/(?:png|jpe?g|gif|webp|avif);)/i.test(attribute.value)) ||
                name === "alt" ||
                name === "title"
              : false;
        if (!keep) {
          child.removeAttribute(attribute.name);
        }
      }
      if (child.tagName === "IMG" && !child.getAttribute("src")) {
        child.remove();
        continue;
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
  activity: NonNullable<RendererState["codex"]["history"][number]["activity"]>,
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
  return plan.replaceAll("_", " ").replace(/(^| )\S/g, (letter) => letter.toUpperCase());
}

function formatRateLimitDetails(
  limits: NonNullable<RendererState["codex"]["rateLimits"]>,
): string[] {
  const formatWindow = (label: string, window: typeof limits.primary): string => {
    if (!window) return `${label}: unavailable`;
    const reset = window.resetsAt ? ` · resets ${formatReset(window.resetsAt)}` : "";
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
