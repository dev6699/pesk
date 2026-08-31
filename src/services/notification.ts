import type { ChatWindowController } from "../windows/chat";
import type { ChatWebServer } from "./chat-web-server";
import type { PetWindowController } from "../windows/pet";

export type NotificationEvent = "turnCompleted" | "approvalRequested" | "userInputRequested";

export interface NotificationRequest {
  event: NotificationEvent;
  threadId: string;
  selectedThreadId?: string;
  requestId?: string | number;
  command?: string;
  reason?: string;
}

/** Decides and coordinates all user-facing effects for Codex attention. */
export class NotificationController {
  constructor(
    private readonly pet: PetWindowController,
    private readonly chat: ChatWindowController,
    private readonly webServer: ChatWebServer,
  ) {}

  handle(request: NotificationRequest): void {
    const focused = this.isFocused();
    const shouldAlert = !focused;
    const kind = this.kindFor(request.event);
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
  }

  private showPetForUpdate(): void {
    this.pet.showForNotification();
    this.chat.showInactive(this.pet.window?.getBounds());
    this.pet.window?.moveTop();
  }

  private isFocused(): boolean {
    return Boolean(this.pet.window?.isFocused() || this.chat.window?.isFocused());
  }

  private kindFor(event: NotificationEvent): "finished" | "approval" | "input" {
    if (event === "turnCompleted") return "finished";
    if (event === "userInputRequested") return "input";
    return "approval";
  }
}
