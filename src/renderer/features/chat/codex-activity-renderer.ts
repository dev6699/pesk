import {
  activityLabel,
  fileChangeLineClass,
  formatCommandActivity,
  isReviewActivity,
  renderMarkdown,
} from "./codex-renderer-helpers.js";

export class CodexActivityRenderer {
  /** Renders markdown, attachments, and activity details for a message. */
  renderMessageContent(
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
      this.renderAssistantContent(content, message.text);
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

  /** Renders assistant Markdown synchronously. */
  renderAssistantContent(content: HTMLElement, text: string): void {
    content.innerHTML = renderMarkdown(text);
  }

  /** Creates the expandable file-change activity presentation. */
  renderFileChangeActivity(
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

  /** Renders the approval state for the current thread. */
  renderApproval(bubble: HTMLElement, message: RendererState["codex"]["history"][number]): void {
    const approval = message.approval;
    if (!approval) return;
    bubble.classList.add(`codex-approval-${approval.state}`);
    if (approval.state === "pending") {
      bubble.classList.add("codex-approval-pending");
      const actions = document.createElement("div");
      actions.className = "codex-approval-actions";
      const options = approval.options ?? [
        { id: "decline", label: "Decline", description: "Reject this request." },
        { id: "accept", label: "Approve once", description: "Allow this request only." },
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
