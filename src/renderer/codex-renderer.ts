import { marked } from "./vendor/marked.js";

export class CodexRenderer {
  private settings: PetSettings;
  private historyInitialized = false;
  private workingTimer: number | undefined;
  private workingLabelTimer: number | undefined;
  private workingLabelSince: number | undefined;
  private selectedMessageIndex = -1;

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
    settings: PetSettings,
  ) {
    this.settings = settings;
    this.renderWorkingStatus();
    sessionSelect.addEventListener("change", () => {
      if (sessionSelect.value)
        window.peskApi.selectCodexThread(sessionSelect.value);
    });
    sessionCopy.addEventListener("click", () => void this.copySessionId());
    chat.addEventListener("mousedown", (event) => event.stopPropagation());
    chat.addEventListener("wheel", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => void this.submit(event));
    input.addEventListener("input", () => this.resizeInput());
    input.addEventListener("keydown", (event) =>
      this.handleInputKeydown(event),
    );
    this.resizeInput();
  }

  handleKeydown(event: KeyboardEvent): void {
    if (
      !this.chat.hidden &&
      event.key.toLowerCase() === "c" &&
      (event.ctrlKey || event.metaKey) &&
      !event.shiftKey &&
      !event.altKey &&
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
      event.altKey &&
      !event.shiftKey &&
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
    this.sessionCopy.disabled = !next.codexThreadId;
    this.renderHistory(next.codexHistory, Boolean(next.codexThreadId));
    this.renderWorkingStatus();
    this.renderTokenUsage();
  }

  focusInput(): void {
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
    const next = await window.peskApi.submitCodexPrompt(prompt);
    this.input.value = "";
    this.resizeInput();
    this.updateSettings(next);
    this.input.focus();
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
    const usage = this.settings.codexTokenUsage;
    const modelInfo = this.settings.codexModelInfo;
    if (!usage && !modelInfo) {
      this.tokenUsage.hidden = true;
      this.tokenUsage.textContent = "";
      return;
    }
    const total = usage?.total.totalTokens;
    const lastTurn = usage?.lastTurn?.totalTokens;
    const currentContext = usage?.lastTurn?.inputTokens;
    const context = usage?.modelContextWindow;
    const contextPercent =
      currentContext !== undefined && context
        ? Math.min(100, (currentContext / context) * 100)
        : undefined;
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
      lastTurn !== undefined ? `Turn ${formatTokens(lastTurn)}` : "",
      contextPercent !== undefined && currentContext !== undefined
        ? `Context ${contextPercent.toFixed(1)}% (${formatTokens(currentContext)} / ${formatTokens(context!)})`
        : context !== undefined
          ? `Context window ${formatTokens(context)}`
          : "",
    ].filter(Boolean);
    const lines = [modelParts.join(" · "), usageParts.join(" · ")].filter(
      Boolean,
    );
    this.tokenUsage.textContent = lines.join("\n");
    this.tokenUsage.title = [...modelParts, ...usageParts].join(" · ");
    this.tokenUsage.hidden = lines.length === 0;
  }

  private selectMessage(
    direction: -1 | 1,
    role?: PetSettings["codexHistory"][number]["role"],
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
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const start = this.input.selectionStart;
      const end = this.input.selectionEnd;
      this.input.value = `${this.input.value.slice(0, start)}\n${this.input.value.slice(end)}`;
      this.input.selectionStart = start + 1;
      this.input.selectionEnd = start + 1;
      this.resizeInput();
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
    this.applySelectedMessage();
    if (!this.historyInitialized || wasAtBottom) {
      this.history.scrollTop = this.history.scrollHeight;
    }
    this.historyInitialized = true;
  }

  private renderMessageContent(
    message: PetSettings["codexHistory"][number],
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

  private renderFileChangeActivity(
    activity: NonNullable<PetSettings["codexHistory"][number]["activity"]>,
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
      this.workingStatus.firstElementChild!.textContent = "Worked for";
      this.workingElapsed.textContent = formatElapsed(worked ?? 0);
      return;
    }
    this.workingStatus.classList.remove("codex-working-status-complete");
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
          window.peskApi.respondCodexPermission(
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

function activityLabel(
  kind: NonNullable<PetSettings["codexHistory"][number]["activity"]>["kind"],
): string {
  switch (kind) {
    case "webSearch":
      return "Web search";
    case "tool":
      return "Tool";
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
  activity: NonNullable<PetSettings["codexHistory"][number]["activity"]>,
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
