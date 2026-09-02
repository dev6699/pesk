import { matchesShortcut } from "../../shared/shortcuts.js";
import { CodexInputController } from "./codex-input-controller.js";

interface PromptRendererCallbacks {
  updateState(next: RendererState): void;
  renderPlanImplementationPrompt(activityKey: string, planText: string): HTMLElement;
}

export class CodexPromptRenderer {
  private renderedUserInputRequestId: string | number | undefined;
  private activeUserInputQuestionId: string | undefined;
  private userInputQuestionIndex = 0;
  private userInputAnswers: Record<string, string[]> = {};
  private reviewPromptOpen = false;

  constructor(
    private readonly userInput: HTMLElement | undefined,
    private readonly history: HTMLElement,
    private readonly composerForm: HTMLFormElement,
    private readonly fileSuggestions: HTMLElement,
    private readonly input: HTMLTextAreaElement,
    private readonly webChat: boolean,
    private readonly getState: () => RendererState,
    private readonly getPlanConfirmation: () => { key: string; planText: string } | undefined,
    private readonly inputController: CodexInputController,
    private readonly callbacks: PromptRendererCallbacks,
  ) {}

  get isReviewPromptOpen(): boolean {
    return this.reviewPromptOpen;
  }

  openReviewPrompt(): void {
    this.reviewPromptOpen = true;
  }

  render(force = false): void {
    this.renderUserInput(force);
  }

  /** Renders pending user-input, approval, plan, and review prompts. */
  private renderUserInput(force = false): void {
    const container = this.userInput;
    const pending = this.getState().codex.pendingUserInput;
    const pendingApproval = this.getState().codex.pendingApproval;
    const planConfirmation = this.getPlanConfirmation();
    if (!container) return;
    if (container.dataset.projectManager === "true" || container.dataset.projectThread === "true")
      return;
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
        this.callbacks.renderPlanImplementationPrompt(
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
      this.inputController.focusChatInput();
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
      void this.inputController.updateSuggestions(input, false);
    });
    input.addEventListener("keydown", (event) => {
      if (this.inputController.handleSuggestionKeydown(event)) return;
      if (matchesShortcut(event, "dismissSuggestions")) {
        event.preventDefault();
        this.inputController.hideSuggestions();
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
      this.inputController.hideSuggestions();
      this.composerForm.hidden = false;
      this.composerForm.append(this.fileSuggestions);
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
      this.inputController.hideSuggestions();
      this.composerForm.hidden = false;
      this.composerForm.append(this.fileSuggestions);
      const next = await window.peskApi.startCodexReview(value);
      this.callbacks.updateState(next);
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
      this.inputController.focusChatInput();
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
}
