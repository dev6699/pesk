import type { ChatWindowController } from "../windows/chat";
import type { ChatWebServer } from "./chat-web-server";
import type { PetWindowController } from "../windows/pet";
import type { CodexController, CodexAttentionEvent } from "../codex/controller";

export interface NotificationControllerOptions {
  codex: Pick<CodexController, "selectThread" | "selectNextAttentionThread">;
  isChatVisible: () => boolean;
}

/** Decides and coordinates all user-facing effects for Codex attention. */
export class NotificationController {
  constructor(
    private readonly pet: PetWindowController,
    private readonly chat: ChatWindowController,
    private readonly webServer: ChatWebServer,
    private readonly options?: NotificationControllerOptions,
  ) {}

  handle(event: CodexAttentionEvent): void {
    if (!this.options?.isChatVisible()) {
      this.options?.codex.selectThread(event.threadId, false);
    }
    const focused = this.isFocused();
    const shouldAlert = !focused;
    const kind = this.kindFor(event.event);
    if (shouldAlert) this.pet.setBackgroundAttention(true);

    if (kind === "finished") {
      this.showPetForUpdate();
      if (!focused) this.pet.setCodexUpdateIndicator(true);
    } else if (kind === "approval") {
      this.pet.showForNotification();
      this.chat.showInactive(this.pet.window?.getBounds());
      this.pet.window?.moveTop();
      if (!this.isFocused()) this.pet.setCodexUpdateIndicator(true);
    } else {
      this.pet.showForNotification();
      this.chat.showInactive(this.pet.window?.getBounds());
      this.pet.window?.moveTop();
    }

    if (shouldAlert) {
      this.pet.playCodexStatusSound();
      this.webServer.notifyCodexAttention(kind);
    }
  }

  clear(): void {
    this.pet.setCodexUpdateIndicator(false);
    if (this.options && !this.options.isChatVisible()) {
      this.options.codex.selectNextAttentionThread();
    }
  }

  private showPetForUpdate(): void {
    this.pet.showForNotification();
    this.chat.showInactive(this.pet.window?.getBounds());
    this.pet.window?.moveTop();
  }

  private isFocused(): boolean {
    return Boolean(this.pet.window?.isFocused() || this.chat.window?.isFocused());
  }

  private kindFor(event: CodexAttentionEvent["event"]): "finished" | "approval" | "input" {
    if (event === "turnCompleted") return "finished";
    if (event === "userInputRequested") return "input";
    return "approval";
  }
}
