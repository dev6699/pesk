import { BrowserWindow, screen } from "electron";
import * as path from "node:path";
import { loadRawConfig } from "./config.js";

interface ChatWindowOptions {
  getPetWindow: () => BrowserWindow | null;
  keepPetAbove: () => void;
  setPetFocus: (focused: boolean) => void;
  setCodexUpdateIndicator: (active: boolean) => void;
}

interface ChatSize {
  width: number;
  height: number;
}

/** Owns the Codex chat BrowserWindow and its relationship to the pet window. */
export class ChatWindowController {
  private readonly size: ChatSize;
  private chatWindow: BrowserWindow | null = null;

  constructor(private readonly options: ChatWindowOptions) {
    const config = loadRawConfig();
    this.size = {
      width: positiveNumber(config.chatWidth, 330),
      height: positiveNumber(config.chatHeight, 360),
    };
  }

  /** Returns the current chat window, if it has been created. */
  get window(): BrowserWindow | null {
    return this.chatWindow;
  }

  /** Returns the configured chat dimensions for renderer layout. */
  getSize(): ChatSize {
    return this.size;
  }

  /** Shows chat when Codex activity requires the pet to become visible. */
  showForCodexUpdate(): void {
    const petWindow = this.options.getPetWindow();
    if (!petWindow) return;
    const chatWasVisible = this.chatWindow?.isVisible() ?? false;
    if (!petWindow.isVisible()) petWindow.show();
    this.create();
    this.position();
    this.chatWindow?.showInactive();
    this.options.keepPetAbove();
    if (!chatWasVisible) this.options.setCodexUpdateIndicator(true);
  }

  /** Shows chat for a pending Codex approval request. */
  showForApproval(): void {
    this.create();
    this.position();
    this.chatWindow?.showInactive();
    this.options.keepPetAbove();
    this.options.setCodexUpdateIndicator(true);
  }

  /** Focuses the chat window and asks its renderer to focus pending options. */
  focusForUserInput(): void {
    this.create();
    this.position();
    this.chatWindow?.show();
    this.chatWindow?.focus();
    this.chatWindow?.webContents.focus();
    this.chatWindow?.webContents.send("codex-user-input-focus");
  }

  /** Focuses the normal Codex text input. */
  focusInput(): void {
    this.create();
    this.position();
    this.chatWindow?.show();
    this.chatWindow?.focus();
    this.chatWindow?.webContents.focus();
    this.chatWindow?.webContents.send("codex-input-focus");
  }

  /** Places the chat window beside the pet within the active work area. */
  position(): void {
    const petWindow = this.options.getPetWindow();
    if (!petWindow || !this.chatWindow) return;

    const petBounds = petWindow.getBounds();
    const area = screen.getDisplayMatching(petBounds).workArea;
    const { width: chatWidth, height: chatHeight } = this.size;

    let chatX = petBounds.x + petBounds.width;
    if (chatX + chatWidth > area.x + area.width) {
      chatX = petBounds.x - chatWidth;
    }
    chatX = Math.max(area.x, Math.min(chatX, area.x + area.width - chatWidth));
    const chatY = Math.max(
      area.y,
      Math.min(petBounds.y, area.y + area.height - chatHeight),
    );
    const [currentX, currentY] = this.chatWindow.getPosition();
    if (currentX !== chatX || currentY !== chatY) {
      this.chatWindow.setPosition(chatX, chatY, false);
    }
  }

  /** Creates the hidden chat window and loads its renderer. */
  create(): void {
    if (this.chatWindow) return;

    this.chatWindow = new BrowserWindow({
      type: "toolbar",
      width: this.size.width,
      height: this.size.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.js"),
      },
    });

    this.chatWindow.setMenu(null);
    this.chatWindow.setSkipTaskbar(true);
    this.chatWindow.loadFile(path.join(__dirname, "renderer", "chat.html"));
    this.chatWindow.once("ready-to-show", () => {
      this.chatWindow?.setSize(this.size.width, this.size.height, false);
      this.position();
      this.options.keepPetAbove();
      if (process.env.DESKTOP_PET_DEVTOOLS === "1") {
        this.chatWindow?.webContents.openDevTools({ mode: "detach" });
      }
    });
    this.chatWindow.on("closed", () => {
      this.chatWindow = null;
    });
    this.chatWindow.on("focus", () => {
      this.options.setPetFocus(true);
    });
    this.chatWindow.on("blur", () => {
      setTimeout(() => {
        if (
          !this.options.getPetWindow()?.isFocused() &&
          !this.chatWindow?.isFocused()
        ) {
          this.options.setPetFocus(false);
          this.chatWindow?.hide();
        }
      }, 50);
    });
  }

  /** Shows chat when its persisted visibility preference allows it. */
  showIfVisible(): void {
    this.showForPetFocus();
  }

  /** Shows chat when the pet window receives focus. */
  showForPetFocus(): void {
    this.create();
    if (!this.chatWindow?.isVisible()) this.position();
    this.chatWindow?.showInactive();
  }

  /** Hides chat on pet blur unless chat itself owns focus. */
  hideIfNotFocused(): void {
    if (this.chatWindow?.isFocused()) return;
    this.chatWindow?.hide();
  }

  /** Hides chat without changing its persisted visibility preference. */
  hide(): void {
    this.chatWindow?.hide();
  }

  /** Closes the chat window during application shutdown. */
  close(): void {
    this.chatWindow?.close();
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
