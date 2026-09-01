import { formatElapsed } from "./codex-renderer-helpers.js";

export class CodexStatusRenderer {
  private workingTimer: number | undefined;
  private workingLabelTimer: number | undefined;
  private workingLabelSince: number | undefined;

  constructor(
    private readonly workingStatus: HTMLElement,
    private readonly workingElapsed: HTMLElement,
    private readonly statusDock: HTMLElement | undefined,
    private readonly commandNotice: HTMLElement,
    private readonly getState: () => RendererState,
  ) {}

  update(): void {
    this.renderWorkingStatus();
    this.renderCommandNotice(this.getState().codex.commandNotice);
    if (this.statusDock) {
      this.statusDock.hidden = this.commandNotice.hidden && this.workingStatus.hidden;
    }
  }

  private renderWorkingStatus(): void {
    if (this.workingTimer !== undefined) window.clearInterval(this.workingTimer);
    this.workingTimer = undefined;
    const { workingSince: since, workedElapsed: worked, interrupted } = this.getState().codex;
    this.workingStatus.hidden = since === undefined && worked === undefined && !interrupted;
    if (since === undefined) {
      this.workingStatus.classList.add("codex-working-status-complete");
      if (this.workingLabelTimer !== undefined) window.clearInterval(this.workingLabelTimer);
      this.workingLabelTimer = undefined;
      this.workingLabelSince = undefined;
      this.workingStatus.classList.toggle("codex-working-status-interrupted", Boolean(interrupted));
      this.workingStatus.firstElementChild!.textContent = interrupted
        ? "Conversation interrupted"
        : "Worked for";
      this.workingElapsed.textContent = formatElapsed(worked ?? 0);
      return;
    }
    this.workingStatus.classList.remove(
      "codex-working-status-complete",
      "codex-working-status-interrupted",
    );
    if (this.workingLabelTimer === undefined || this.workingLabelSince !== since) {
      if (this.workingLabelTimer !== undefined) window.clearInterval(this.workingLabelTimer);
      this.workingLabelSince = since;
      const workingLabel = this.workingStatus.firstElementChild!;
      const fullLabel = "Working...";
      let characters = 0;
      let pause = 0;
      const updateLabel = (): void => {
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
    const update = (): void => {
      this.workingElapsed.textContent = formatElapsed(Date.now() - since);
    };
    update();
    this.workingTimer = window.setInterval(update, 1000);
  }

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
}
