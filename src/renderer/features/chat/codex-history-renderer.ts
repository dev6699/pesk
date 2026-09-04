import {
  formatCommandActivity,
  historyMessageKeyForRenderer,
  historyStructureKey,
  isPrefix,
  isSuffix,
  isReviewActivity,
  renderMarkdown,
} from "./codex-renderer-helpers.js";
import { CodexActivityRenderer } from "./codex-activity-renderer.js";
import { CodexHistoryScrollController } from "./codex-history-scroll-controller.js";

interface HistoryRendererCallbacks {
  applySelectedMessage(): void;
  setActivePlanConfirmation(value: { key: string; planText: string } | undefined): void;
  isPlanConfirmationDismissed(activityKey: string): boolean;
}

export class CodexHistoryRenderer {
  private readonly activityRenderer = new CodexActivityRenderer();
  private readonly content: HTMLElement;
  private readonly scrollController: CodexHistoryScrollController;
  private historyInitialized = false;
  private renderedHistoryStructureKey = "";
  private renderedHistoryBaseKey = "";
  private renderedHistoryLoading = false;
  private renderedSessionConnected = false;
  private readonly renderedMessageContents = new Map<string, HTMLElement>();
  private readonly renderedMessageTexts = new Map<string, string>();
  private readonly renderedActivityDetails = new Map<string, HTMLElement>();
  private readonly renderedActivityOutputs = new Map<string, string>();
  private readonly streamingPlainMessages = new Set<string>();
  private readonly streamedAssistantTexts = new Map<string, string>();
  private renderedHistoryKeys: string[] = [];
  private resizeObserver?: ResizeObserver;
  private renderedPlanDetails = new Map<string, string>();
  private planRenderTimer: number | undefined;
  private pendingPlanHistory: RendererState["codex"]["history"] | undefined;

  constructor(
    private readonly history: HTMLElement,
    private readonly getState: () => RendererState,
    private readonly callbacks: HistoryRendererCallbacks,
  ) {
    this.content =
      history.querySelector<HTMLElement>("#codex-history-content") ??
      (() => {
        const content = document.createElement("div");
        content.id = "codex-history-content";
        while (history.firstChild) content.append(history.firstChild);
        history.append(content);
        return content;
      })();
    this.scrollController = new CodexHistoryScrollController(this.history, this.content);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.scrollController.handleResize();
      });
      this.resizeObserver.observe(this.history);
      this.resizeObserver.observe(this.content);
    }
  }

  reset(): void {
    this.scrollController.reset();
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(this.history);
    this.resizeObserver?.observe(this.content);
    this.historyInitialized = false;
    this.renderedHistoryStructureKey = "";
    this.renderedHistoryBaseKey = "";
    this.renderedHistoryLoading = false;
    this.renderedSessionConnected = false;
    this.renderedHistoryKeys = [];
  }

  noteManualScroll(): void {
    this.scrollController.noteManualScroll();
  }

  handleHistoryScroll(): void {
    this.scrollController.handleScroll();
  }

  isAutoScrollAllowed(): boolean {
    return this.scrollController.isFollowing();
  }

  scrollToLatest(force = true): void {
    this.scrollController.scrollToLatest(force);
  }

  scrollToTop(): void {
    this.scrollController.scrollToTop();
  }

  scrollBy(top: number): void {
    this.scrollController.scrollBy(top);
  }

  revealMessage(message: HTMLElement): void {
    this.scrollController.revealMessage(message);
  }

  captureAnchor(): { key: string; offset: number } | undefined {
    const historyBounds = this.history.getBoundingClientRect();
    const messages = Array.from(this.content.querySelectorAll<HTMLElement>(".codex-message"));
    const message = messages.find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > historyBounds.top && bounds.top < historyBounds.bottom;
    });
    const key = message?.dataset.historyKey;
    if (!message || !key) return undefined;
    return { key, offset: message.getBoundingClientRect().top - historyBounds.top };
  }

  restoreAnchor(anchor: { key: string; offset: number } | undefined): void {
    if (!anchor) return;
    const message = Array.from(this.content.querySelectorAll<HTMLElement>(".codex-message")).find(
      (candidate) => candidate.dataset.historyKey === anchor.key,
    );
    if (!message) return;
    const historyBounds = this.history.getBoundingClientRect();
    const delta = message.getBoundingClientRect().top - historyBounds.top - anchor.offset;
    if (Math.abs(delta) < 1) return;
    this.history.scrollTop += delta;
  }

  applyStreamDelta(delta: CodexStreamDelta): void {
    if (delta.threadId && delta.threadId !== this.getState().codex.threadId) return;
    const key =
      delta.itemId ??
      [...this.renderedHistoryKeys]
        .reverse()
        .find((candidate) => this.renderedMessageContents.has(candidate));
    if (!key) return;
    if (delta.kind === "assistant") {
      const shouldFollowLatest = this.scrollController.shouldFollowUpdate();
      let content = this.renderedMessageContents.get(key);
      if (!content && delta.itemId) {
        const message = {
          role: "assistant" as const,
          text: this.streamedAssistantTexts.get(key) ?? "",
          itemId: delta.itemId,
        };
        const bubble = this.createMessageBubble(
          message,
          this.renderedHistoryKeys.length,
          new Set(),
          new Set(),
        );
        this.content.append(bubble);
        if (!this.renderedHistoryKeys.includes(key)) this.renderedHistoryKeys.push(key);
        content = this.renderedMessageContents.get(key);
      }
      if (!content) return;
      if (delta.completed) {
        this.streamingPlainMessages.delete(key);
        this.streamedAssistantTexts.delete(key);
        this.activityRenderer.renderAssistantContent(
          content,
          this.renderedMessageTexts.get(key) ?? content.textContent ?? "",
        );
        return;
      }
      const text = `${this.streamedAssistantTexts.get(key) ?? this.renderedMessageTexts.get(key) ?? content.textContent ?? ""}${delta.delta}`;
      content.textContent = text;
      this.renderedMessageTexts.set(key, text);
      if (delta.itemId) this.streamedAssistantTexts.set(key, text);
      this.streamingPlainMessages.add(key);
      if (shouldFollowLatest) this.scrollController.scrollToLatest(false);
      return;
    }
    const details = this.renderedActivityDetails.get(key);
    if (!details) return;
    const previousOutput = this.renderedActivityOutputs.get(key) ?? "";
    const output = `${previousOutput}${delta.delta}`;
    const currentDetails = details.textContent ?? "";
    const prefix =
      previousOutput && currentDetails.endsWith(previousOutput)
        ? currentDetails.slice(0, -previousOutput.length)
        : "";
    details.textContent = `${prefix}${output}`;
    this.renderedActivityOutputs.set(key, output);
  }

  /** Renders chat history incrementally when possible, preserving message nodes,
   * expanded activities, and the user's scroll position while reading history.
   */
  renderHistory(
    history: RendererState["codex"]["history"],
    sessionConnected = false,
    historyLoading = false,
    queuedSubmissions: RendererState["codex"]["queuedSubmissions"] = [],
  ): void {
    this.updateActivePlanConfirmation(history);
    const structureKey = `${historyStructureKey(history)}|queue:${queuedSubmissions
      .map((submission) => `${submission.id}:${submission.text}`)
      .join("|")}|loading:${historyLoading}|connected:${sessionConnected}`;
    const baseHistoryKey = historyStructureKey(history);
    const planContentChanged = (history ?? []).some((message, index) => {
      if (message.activity?.kind !== "plan") return false;
      const activityKey = historyMessageKeyForRenderer(message, index);
      return this.renderedPlanDetails.get(activityKey) !== (message.activity.details ?? "");
    });
    const historyKeys = (history ?? []).map(historyMessageKeyForRenderer);
    if (
      this.historyInitialized &&
      !historyLoading &&
      historyKeys.length < this.renderedHistoryKeys.length &&
      isPrefix(historyKeys, this.renderedHistoryKeys)
    ) {
      return;
    }
    const sameRenderedHistory =
      this.historyInitialized &&
      !planContentChanged &&
      this.renderedHistoryBaseKey === baseHistoryKey &&
      this.renderedHistoryLoading === historyLoading &&
      this.renderedSessionConnected === sessionConnected &&
      this.renderedHistoryKeys.length === historyKeys.length &&
      this.renderedHistoryKeys.every((key, index) => key === historyKeys[index]);
    if (sameRenderedHistory && this.renderedHistoryStructureKey !== structureKey) {
      const previousScrollTop = this.history.scrollTop;
      const shouldFollowLatest = this.scrollController.shouldFollowUpdate();
      this.renderQueuedSubmissions(queuedSubmissions);
      this.renderedHistoryStructureKey = structureKey;
      this.updateRenderedMessageContent(history);
      this.callbacks.applySelectedMessage();
      if (shouldFollowLatest) this.scrollToLatest(false);
      else {
        this.scrollController.restoreReaderPosition(previousScrollTop);
      }
      return;
    }
    const canIncrementallyAppend =
      this.historyInitialized && isPrefix(this.renderedHistoryKeys, historyKeys);
    if (canIncrementallyAppend && historyKeys.length > this.renderedHistoryKeys.length) {
      const previousScrollTop = this.history.scrollTop;
      const shouldFollowLatest = this.scrollController.shouldFollowUpdate();
      this.content
        .querySelectorAll(".codex-empty-history, .codex-loading-history, .codex-session-connected")
        .forEach((placeholder) => placeholder.remove());
      const openActivityKeys = new Set(
        Array.from(this.content.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
          .filter((details) => details.open)
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      const renderedActivityKeys = new Set(
        Array.from(this.content.querySelectorAll<HTMLElement>("details[data-activity-key]"))
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      for (let index = this.renderedHistoryKeys.length; index < historyKeys.length; index += 1) {
        this.content.append(
          this.createMessageBubble(history[index], index, openActivityKeys, renderedActivityKeys),
        );
      }
      this.renderQueuedSubmissions(queuedSubmissions);
      this.renderedHistoryKeys = historyKeys;
      this.renderedHistoryStructureKey = structureKey;
      this.renderedHistoryBaseKey = baseHistoryKey;
      this.renderedHistoryLoading = historyLoading;
      this.renderedSessionConnected = sessionConnected;
      this.schedulePlanUpdates(history);
      this.updateRenderedMessageContent(history);
      this.callbacks.applySelectedMessage();
      if (shouldFollowLatest) this.scrollToLatest(false);
      else {
        this.scrollController.restoreReaderPosition(previousScrollTop);
      }
      return;
    }
    const canIncrementallyPrepend =
      this.historyInitialized &&
      !queuedSubmissions.length &&
      !planContentChanged &&
      isSuffix(this.renderedHistoryKeys, historyKeys);
    if (canIncrementallyPrepend && historyKeys.length > this.renderedHistoryKeys.length) {
      const anchor = this.captureAnchor();
      const openActivityKeys = new Set(
        Array.from(this.content.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
          .filter((details) => details.open)
          .map((details) => details.dataset.activityKey)
          .filter((key): key is string => Boolean(key)),
      );
      const renderedActivityKeys = new Set(
        Array.from(this.content.querySelectorAll<HTMLElement>("details[data-activity-key]"))
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
      this.content.prepend(fragment);
      this.renderedHistoryKeys = historyKeys;
      this.renderedHistoryStructureKey = structureKey;
      this.renderedHistoryBaseKey = baseHistoryKey;
      this.renderedHistoryLoading = historyLoading;
      this.renderedSessionConnected = sessionConnected;
      this.callbacks.applySelectedMessage();
      this.restoreAnchor(anchor);
      return;
    }
    const sameHistory =
      this.historyInitialized &&
      !queuedSubmissions.length &&
      this.renderedHistoryStructureKey === structureKey &&
      this.renderedHistoryKeys.length === historyKeys.length &&
      this.renderedHistoryKeys.every((key, index) => key === historyKeys[index]);
    if (sameHistory) {
      const previousScrollTop = this.history.scrollTop;
      const shouldFollowLatest = this.scrollController.shouldFollowUpdate();
      this.updateRenderedMessageContent(history);
      this.renderedHistoryStructureKey = structureKey;
      this.schedulePlanUpdates(history);
      this.callbacks.applySelectedMessage();
      if (shouldFollowLatest) this.scrollToLatest(false);
      else {
        this.scrollController.restoreReaderPosition(previousScrollTop);
      }
      return;
    }
    if (
      this.renderedHistoryStructureKey &&
      structureKey === this.renderedHistoryStructureKey &&
      planContentChanged &&
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
    const shouldFollowLatest =
      !this.historyInitialized || this.scrollController.shouldFollowUpdate();
    const previousScrollTop = this.history.scrollTop;
    const previousScrollHeight = this.history.scrollHeight;
    const openActivityKeys = new Set(
      Array.from(this.content.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"))
        .filter((details) => details.open)
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    const renderedActivityKeys = new Set(
      Array.from(this.content.querySelectorAll<HTMLElement>("details[data-activity-key]"))
        .map((details) => details.dataset.activityKey)
        .filter((key): key is string => Boolean(key)),
    );
    if (this.historyInitialized && this.history.clientHeight > 0 && previousScrollHeight > 0) {
      this.scrollController.lockContentExtent(previousScrollHeight);
    }
    this.content.replaceChildren();
    this.renderedHistoryStructureKey = structureKey;
    this.renderedHistoryKeys = historyKeys;
    this.renderedMessageContents.clear();
    this.renderedMessageTexts.clear();
    this.renderedActivityDetails.clear();
    this.renderedActivityOutputs.clear();
    this.streamingPlainMessages.clear();
    this.renderedPlanDetails.clear();
    if (!history?.length && historyLoading) {
      const loading = document.createElement("div");
      loading.className = "codex-loading-history";
      loading.textContent = "Loading messages…";
      this.content.append(loading);
    } else if (!history?.length) {
      const empty = document.createElement("div");
      empty.className = "codex-empty-history";
      empty.textContent = "No messages yet.";
      this.content.append(empty);
      if (sessionConnected) {
        const connected = document.createElement("div");
        connected.className = "codex-session-connected";
        connected.textContent = "Session connected.";
        this.content.append(connected);
      }
    }
    for (const [index, message] of (history ?? []).entries()) {
      this.content.append(
        this.createMessageBubble(message, index, openActivityKeys, renderedActivityKeys),
      );
    }
    this.renderQueuedSubmissions(queuedSubmissions);
    this.renderedHistoryBaseKey = baseHistoryKey;
    this.renderedHistoryLoading = historyLoading;
    this.renderedSessionConnected = sessionConnected;
    this.callbacks.applySelectedMessage();
    this.observeHistoryMessages();
    if (shouldFollowLatest) {
      this.scrollToLatest(false);
    } else {
      this.scrollController.restoreReaderPosition(previousScrollTop);
    }
    this.historyInitialized = true;
  }

  private observeHistoryMessages(): void {
    this.content.querySelectorAll<HTMLElement>(".codex-message").forEach((message) => {
      this.resizeObserver?.observe(message);
    });
  }

  private renderQueuedSubmissions(
    queuedSubmissions: RendererState["codex"]["queuedSubmissions"],
  ): void {
    this.content.querySelectorAll(".codex-queued-submissions").forEach((queue) => queue.remove());
    if (!queuedSubmissions.length) return;
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
    this.content.append(queue);
  }

  isNearBottom(): boolean {
    return this.scrollController.isNearBottom();
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
    bubble.dataset.historyKey = activityKey;
    if (message.itemId) bubble.dataset.messageItemId = message.itemId;
    if (message.activity?.kind === "plan") {
      this.renderedPlanDetails.set(activityKey, message.activity.details ?? "");
    }
    bubble.append(
      this.activityRenderer.renderMessageContent(
        message,
        activityKey,
        openActivityKeys,
        renderedActivityKeys,
      ),
    );
    const content = bubble.firstElementChild;
    if (content instanceof HTMLElement && !message.activity) {
      this.renderedMessageContents.set(activityKey, content);
      const streamedText =
        message.role === "assistant" && this.getState().codex.status !== "idle"
          ? this.streamedAssistantTexts.get(activityKey)
          : undefined;
      const text = streamedText ?? message.text;
      if (streamedText !== undefined) content.textContent = streamedText;
      this.renderedMessageTexts.set(activityKey, text);
      if (message.role === "assistant" && this.getState().codex.status === "idle") {
        this.streamedAssistantTexts.delete(activityKey);
      }
    }
    if (content instanceof HTMLElement && message.activity?.kind === "command") {
      const details = content.querySelector<HTMLElement>(".codex-activity-details");
      if (details) {
        this.renderedActivityDetails.set(activityKey, details);
        this.renderedActivityOutputs.set(activityKey, message.activity.output ?? "");
      }
    }
    const time = document.createElement("time");
    time.className = "codex-message-time";
    time.textContent = new Date(message.timestamp ?? Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    bubble.append(time);
    if (message.approval) this.activityRenderer.renderApproval(bubble, message);
    return bubble;
  }

  /** Updates rendered message content without rebuilding stable nodes. */
  private updateRenderedMessageContent(history: RendererState["codex"]["history"]): void {
    for (const [index, message] of (history ?? []).entries()) {
      const activityKey = historyMessageKeyForRenderer(message, index);
      if (message.activity?.kind === "command") {
        const output = message.activity.output ?? "";
        if (this.renderedActivityOutputs.get(activityKey) !== output) {
          const details = this.renderedActivityDetails.get(activityKey);
          if (details) {
            details.textContent = formatCommandActivity(message.activity);
            this.renderedActivityOutputs.set(activityKey, output);
          }
        }
        continue;
      }
      if (message.activity || (message.images?.length ?? 0) > 0) continue;
      const content = this.renderedMessageContents.get(activityKey);
      if (!content) continue;
      if (message.role === "assistant") {
        if (this.streamingPlainMessages.has(activityKey)) {
          if (
            this.getState().codex.status === "working" ||
            this.getState().codex.status === "waiting"
          ) {
            content.textContent = message.text;
            this.renderedMessageTexts.set(activityKey, message.text);
            continue;
          }
          this.streamingPlainMessages.delete(activityKey);
          this.streamedAssistantTexts.delete(activityKey);
          this.activityRenderer.renderAssistantContent(content, message.text);
          this.renderedMessageTexts.set(activityKey, message.text);
          continue;
        }
        if (this.renderedMessageTexts.get(activityKey) === message.text) continue;
        this.activityRenderer.renderAssistantContent(content, message.text);
      } else {
        if (this.renderedMessageTexts.get(activityKey) === message.text) continue;
        content.textContent = message.text;
      }
      this.renderedMessageTexts.set(activityKey, message.text);
    }
  }

  /** Synchronizes the active plan implementation confirmation. */
  private updateActivePlanConfirmation(history: RendererState["codex"]["history"]): void {
    this.callbacks.setActivePlanConfirmation(undefined);
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
    if (this.callbacks.isPlanConfirmationDismissed(activityKey)) return;
    this.callbacks.setActivePlanConfirmation({
      key: activityKey,
      planText: planActivityText,
    });
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
      this.content.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"),
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
            this.content.querySelectorAll<HTMLDetailsElement>("details[data-activity-key]"),
          ).find((candidate) => candidate.dataset.activityKey === activityKey);
          const content = details?.querySelector<HTMLElement>(".codex-plan-content");
          if (!content) {
            this.renderHistory(nextHistory);
            return;
          }
          content.innerHTML = renderMarkdown(message.activity.details ?? "");
          this.renderedPlanDetails.set(activityKey, message.activity.details ?? "");
        }
        if (this.isAutoScrollAllowed()) this.scrollToLatest(false);
      }, 100);
    }
    return true;
  }
}
