import type { BrowserWindow } from "electron";
import type { ChatWindowController } from "../windows/chat";
import type { PetWindowController } from "../windows/pet";

/** Coordinates focus between the pet, chat, and global focus shortcut. */
export class FocusController {
  private wiredWindow: BrowserWindow | null = null;
  private fileDialogOpen = false;

  constructor(
    private readonly chat: ChatWindowController,
    private readonly pet: PetWindowController,
  ) {}

  positionChat(): void {
    const petWindow = this.pet.window;
    if (petWindow && this.chat.window) this.chat.position(petWindow.getBounds());
  }

  wireChatWindow(): void {
    const window = this.chat.window;
    if (!window || window === this.wiredWindow) return;
    this.wiredWindow = window;
    window.on("focus", () => {
      this.fileDialogOpen = false;
      this.pet.setFocusIndicator(true);
    });
    window.on("blur", () => {
      setTimeout(() => {
        if (
          !this.fileDialogOpen &&
          !this.pet.window?.isFocused() &&
          !this.chat.window?.isFocused()
        ) {
          this.pet.setFocusIndicator(false);
          this.chat.hide();
        }
      }, 50);
    });
  }

  setFileDialogOpen(open: boolean): void {
    this.fileDialogOpen = open;
  }

  routeGlobalShortcut(hasPendingUserInput: boolean): void {
    this.routeFocusShortcut(hasPendingUserInput);
  }

  /** Routes focus to the most relevant control for the current application state. */
  private routeFocusShortcut(hasPendingUserInput: boolean): void {
    if (!this.chat.window?.isFocused()) {
      this.pet.focus();
    } else if (hasPendingUserInput) {
      this.chat.focusForUserInput();
    } else {
      this.chat.focusInput();
    }
  }
}
