export class CodexRenderer {
  private settings: PetSettings;
  private historyInitialized = false;

  constructor(
    private readonly chat: HTMLElement,
    private readonly sessionSelect: HTMLSelectElement,
    private readonly error: HTMLElement,
    private readonly history: HTMLElement,
    private readonly form: HTMLFormElement,
    private readonly input: HTMLTextAreaElement,
    settings: PetSettings,
  ) {
    this.settings = settings;
    sessionSelect.addEventListener("change", () => {
      if (sessionSelect.value)
        window.petApi.selectCodexThread(sessionSelect.value);
    });
    chat.addEventListener("mousedown", (event) => event.stopPropagation());
    chat.addEventListener("wheel", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => void this.submit(event));
    input.addEventListener("keydown", (event) =>
      this.handleInputKeydown(event),
    );
  }

  handleKeydown(event: KeyboardEvent): void {
    if (
      !this.chat.hidden &&
      event.ctrlKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      this.history.scrollBy({
        top: event.key === "ArrowUp" ? -64 : 64,
        behavior: "smooth",
      });
      return;
    }
    const pendingApproval = this.history.querySelector<HTMLElement>(
      ".codex-approval-pending",
    );
    const approve = pendingApproval?.querySelector<HTMLButtonElement>(
      "[data-decision='allow']",
    );
    const deny = pendingApproval?.querySelector<HTMLButtonElement>(
      "[data-decision='deny']",
    );
    if (event.key.toLowerCase() === "y" && approve) {
      event.preventDefault();
      approve.click();
    } else if (event.key.toLowerCase() === "n" && deny) {
      event.preventDefault();
      deny.click();
    }
  }

  updateFocus(focused: boolean): void {
    this.chat.hidden = !this.settings.codexChatVisible;
    if (focused) {
      requestAnimationFrame(() => {
        this.history.scrollTo({
          top: this.history.scrollHeight,
          behavior: "auto",
        });
        this.input.focus();
      });
    }
  }

  updateSettings(next: PetSettings): void {
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
    this.renderHistory(next.codexHistory, Boolean(next.codexThreadId));
    this.chat.hidden = !next.codexChatVisible;
    if (!this.chat.hidden && document.activeElement !== this.input) {
      requestAnimationFrame(() => this.input.focus());
    }
  }

  setVisibility(visible: boolean): void {
    this.chat.hidden = !visible || !this.settings.codexChatVisible;
  }

  focusInput(): void {
    if (this.settings.codexChatVisible)
      requestAnimationFrame(() => this.input.focus());
  }

  private async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const prompt = this.input.value.trim();
    if (
      !prompt ||
      this.settings.codexStatus === "working" ||
      this.settings.codexStatus === "waiting"
    )
      return;
    const next = await window.petApi.submitCodexPrompt(prompt);
    this.input.value = "";
    this.updateSettings(next);
    this.input.focus();
  }

  private handleInputKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
      this.input.selectionStart = start + 1;
      this.input.selectionEnd = start + 1;
    } else if (!event.shiftKey) {
      event.preventDefault();
      this.form.requestSubmit();
    }
  }

  private renderHistory(
    history: PetSettings["codexHistory"],
    sessionConnected = false,
  ): void {
    const wasAtBottom =
      this.historyInitialized &&
      this.history.scrollTop + this.history.clientHeight >=
      this.history.scrollHeight - 24;
    this.history.replaceChildren();
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
    for (const message of history ?? []) {
      const bubble = document.createElement("div");
      bubble.className = `codex-message codex-message-${message.role}`;
      if (message.temporary) bubble.classList.add("codex-message-working");
      bubble.textContent = message.text;
      const time = document.createElement("time");
      time.className = "codex-message-time";
      time.textContent = new Date(
        message.timestamp ?? Date.now(),
      ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      bubble.append(time);
      if (message.approval) this.renderApproval(bubble, message);
      this.history.append(bubble);
    }
    if (!this.historyInitialized || wasAtBottom) {
      this.history.scrollTop = this.history.scrollHeight;
    }
    this.historyInitialized = true;
  }

  private renderApproval(
    bubble: HTMLElement,
    message: PetSettings["codexHistory"][number],
  ): void {
    const approval = message.approval;
    if (!approval) return;
    bubble.classList.add(`codex-approval-${approval.state}`);
    if (approval.state === "pending") {
      bubble.classList.add("codex-approval-pending");
      const actions = document.createElement("div");
      actions.className = "codex-approval-actions";
      for (const [decision, label] of [
        ["deny", "Deny (N)"],
        ["allow", "Approve (Y)"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.decision = decision;
        button.textContent = label;
        button.addEventListener("click", () =>
          window.petApi.respondCodexPermission(
            approval.requestId ?? "",
            decision,
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
