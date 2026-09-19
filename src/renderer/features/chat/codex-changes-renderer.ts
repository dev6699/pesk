import { fileChangeLineClass } from "./codex-renderer-helpers.js";

type CodexMessage = RendererState["codex"]["threads"]["current"]["thread"]["messages"][number];

interface ChangeEntry {
  path: string;
  kind: "new" | "deleted" | "modified";
  records: ChangeRecord[];
}

interface ChangeRecord {
  kind: "new" | "deleted" | "modified";
  diff: string;
}

interface ChangeTurn {
  id: string;
  timestamp?: number;
  prompt?: string;
  changes: ChangeEntry[];
}

/** Renders the lightweight thread-wide view of already-loaded file changes. */
export class CodexChangesRenderer {
  private readonly closeButton: HTMLButtonElement;
  private readonly content: HTMLElement;
  private renderedChangesKey = "";

  constructor(
    private readonly panel: HTMLElement,
    private readonly toggle: HTMLButtonElement,
    private readonly navigateToTurn: (turnId: string, edge: "start" | "end") => void,
    private readonly fillPrompt: (prompt: string) => void,
  ) {
    this.closeButton = panel.querySelector<HTMLButtonElement>("[data-changes-close]")!;
    this.content = panel.querySelector<HTMLElement>("[data-changes-content]")!;
    toggle.addEventListener("click", () => this.setOpen(Boolean(panel.hidden)));
    this.closeButton.addEventListener("click", () => this.setOpen(false));
    panel.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-changes-backdrop]")) this.setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) this.setOpen(false);
    });
  }

  render(messages: CodexMessage[]): void {
    const turns = this.collectTurns(messages);
    const changesKey = JSON.stringify(turns);
    if (changesKey === this.renderedChangesKey) return;
    this.renderedChangesKey = changesKey;
    this.content.replaceChildren();
    if (!turns.length) {
      const empty = document.createElement("p");
      empty.className = "codex-changes-empty";
      empty.textContent = "No file changes in the loaded history.";
      this.content.append(empty);
      this.toggle.disabled = true;
      return;
    }
    this.toggle.disabled = false;
    for (const turn of turns) this.content.append(this.renderTurn(turn));
  }

  private collectTurns(messages: CodexMessage[]): ChangeTurn[] {
    const turns = new Map<string, ChangeTurn>();
    const turnTimestamps = new Map<string, number>();
    const turnPrompts = new Map<string, string>();
    for (const message of messages) {
      if (
        message.turnId &&
        message.timestamp !== undefined &&
        !turnTimestamps.has(message.turnId)
      ) {
        turnTimestamps.set(message.turnId, message.timestamp);
      }
      if (
        message.role === "user" &&
        message.turnId &&
        message.text.trim() &&
        !turnPrompts.has(message.turnId)
      ) {
        turnPrompts.set(message.turnId, message.text.replace(/\s+/g, " ").trim());
      }
    }
    for (const message of messages) {
      const activity = message.activity;
      if (!activity || activity.kind !== "fileChange") continue;
      if (["failed", "declined"].includes(activity.status?.toLowerCase() ?? "")) continue;
      const id = message.turnId ?? "unknown";
      const turn = turns.get(id) ?? {
        id,
        timestamp: turnTimestamps.get(id) ?? message.timestamp,
        prompt: turnPrompts.get(id),
        changes: [],
      };
      turn.timestamp ??= message.timestamp;
      for (const change of activity.changes ?? []) {
        const lines = change.split("\n");
        const label = lines.shift() ?? "unknown file";
        const separator = label.indexOf(": ");
        const prefix = separator >= 0 ? label.slice(0, separator).toLowerCase() : "";
        const record = {
          kind: prefix === "added" ? "new" : prefix === "deleted" ? "deleted" : "modified",
          diff: lines.join("\n"),
        } as const;
        const existing = turn.changes.find(
          (candidate) => candidate.path === (separator >= 0 ? label.slice(separator + 2) : label),
        );
        if (existing) {
          existing.records.push(record);
          existing.kind =
            record.kind === "deleted"
              ? "deleted"
              : existing.records.some((candidate) => candidate.kind === "new")
                ? "new"
                : "modified";
          continue;
        }
        turn.changes.push({
          path: separator >= 0 ? label.slice(separator + 2) : label,
          kind: record.kind,
          records: [record],
        });
      }
      turns.set(id, turn);
    }
    return [...turns.values()].sort(
      (left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0),
    );
  }

  private renderTurn(turn: ChangeTurn): HTMLElement {
    const details = document.createElement("details");
    details.className = "codex-changes-turn";
    const summary = document.createElement("summary");
    if (turn.timestamp !== undefined) {
      const time = document.createElement("span");
      time.className = "codex-changes-time";
      time.textContent = new Date(turn.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      summary.append(time);
    }
    const turnLabel = document.createElement("span");
    turnLabel.className = "codex-changes-turn-label";
    const counts = new Map<ChangeEntry["kind"], number>();
    for (const change of turn.changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
    for (const kind of ["new", "modified", "deleted"] as const) {
      const count = counts.get(kind);
      if (!count) continue;
      const badge = document.createElement("span");
      badge.className = `codex-changes-kind codex-changes-kind-${kind}`;
      badge.textContent = `${count} ${kind === "new" ? "New" : kind === "deleted" ? "Deleted" : "Modified"}`;
      turnLabel.append(badge);
    }
    summary.append(turnLabel);
    if (turn.prompt) {
      const prompt = document.createElement("span");
      prompt.className = "codex-changes-turn-prompt";
      prompt.textContent = turn.prompt;
      prompt.title = turn.prompt;
      summary.append(prompt);
    }
    if (turn.id !== "unknown") {
      const actions = document.createElement("div");
      actions.className = "codex-changes-turn-actions";
      for (const edge of ["start", "end"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = edge === "start" ? "Start" : "End";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.navigateToTurn(turn.id, edge);
        });
        actions.append(button);
      }
      summary.append(actions);
    }
    details.append(summary);
    for (const change of turn.changes) details.append(this.renderChange(change));
    return details;
  }

  private renderChange(change: ChangeEntry): HTMLElement {
    const item = document.createElement("section");
    item.className = "codex-changes-file";
    const fileHeader = document.createElement("div");
    fileHeader.className = "codex-changes-file-header";
    const badge = document.createElement("span");
    badge.className = `codex-changes-kind codex-changes-kind-${change.kind}`;
    badge.textContent =
      change.kind === "new" ? "New" : change.kind === "deleted" ? "Deleted" : "Modified";
    const path = document.createElement("strong");
    path.textContent = change.path;
    const fillButton = document.createElement("button");
    fillButton.type = "button";
    fillButton.className = "codex-changes-fill";
    fillButton.title = "Use this file and its changes in the prompt";
    fillButton.setAttribute("aria-label", `Use changes for ${change.path} in the prompt`);
    fillButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V4h11v13h-3M5 7h11v13H5z"></path><path d="M8 11h5M8 15h5"></path></svg>';
    fillButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.fillPrompt(this.formatPrompt(change));
    });
    fileHeader.append(path, fillButton, badge);
    item.append(fileHeader);
    if (change.records.length === 1) {
      item.append(this.renderDiff(change.records[0].diff));
    } else {
      const raw = document.createElement("details");
      raw.className = "codex-changes-raw";
      raw.open = true;
      const rawSummary = document.createElement("summary");
      rawSummary.textContent = `Raw changes · ${change.records.length}`;
      raw.append(rawSummary);
      for (const [index, record] of change.records.entries()) {
        const recordSection = document.createElement("section");
        recordSection.className = "codex-changes-raw-record";
        const recordHeader = document.createElement("div");
        recordHeader.className = "codex-changes-raw-record-header";
        const recordLabel = document.createElement("span");
        recordLabel.textContent = `Change ${index + 1}`;
        const recordBadge = document.createElement("span");
        recordBadge.className = `codex-changes-kind codex-changes-kind-${record.kind}`;
        recordBadge.textContent =
          record.kind === "new" ? "New" : record.kind === "deleted" ? "Deleted" : "Modified";
        recordHeader.append(recordLabel, recordBadge);
        recordSection.append(recordHeader, this.renderDiff(record.diff));
        raw.append(recordSection);
      }
      item.append(raw);
    }
    return item;
  }

  private formatPrompt(change: ChangeEntry): string {
    const records = change.records
      .map(
        (record, index) =>
          `### Change ${index + 1} (${this.changeLabel(record.kind)})\n\n\`\`\`diff\n${record.diff}\n\`\`\``,
      )
      .join("\n\n");
    return `\`${change.path}\`\n\n${records}`;
  }

  private changeLabel(kind: ChangeRecord["kind"]): string {
    return kind === "new" ? "New" : kind === "deleted" ? "Deleted" : "Modified";
  }

  private renderDiff(value: string): HTMLElement {
    const diff = document.createElement("pre");
    diff.className = "codex-changes-diff";
    for (const line of value.split("\n")) {
      const row = document.createElement("span");
      row.className = fileChangeLineClass(line);
      row.textContent = line;
      diff.append(row, "\n");
    }
    return diff;
  }

  private setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    if (open) this.closeButton.focus();
  }
}
