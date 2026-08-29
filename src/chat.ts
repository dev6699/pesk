import { BrowserWindow, screen } from "electron";
import * as path from "node:path";
import { loadRawConfig } from "./config.js";

interface ChatSize {
  width: number;
  height: number;
}

/** Owns the Codex chat BrowserWindow. */
export class ChatWindowController {
  private readonly size: ChatSize;
  private chatWindow: BrowserWindow | null = null;

  constructor() {
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

  /** Shows chat without taking focus. Notification policy belongs upstream. */
  showInactive(anchorBounds?: Electron.Rectangle): void {
    this.create();
    if (anchorBounds) this.position(anchorBounds);
    this.chatWindow?.showInactive();
  }

  /** Focuses the chat window and asks its renderer to focus pending options. */
  focusForUserInput(anchorBounds?: Electron.Rectangle): void {
    this.focusChat("codex-user-input-focus", anchorBounds);
  }

  /** Focuses the normal Codex text input. */
  focusInput(anchorBounds?: Electron.Rectangle): void {
    this.focusChat("codex-input-focus", anchorBounds);
  }

  private focusChat(
    event: "codex-input-focus" | "codex-user-input-focus",
    anchorBounds?: Electron.Rectangle,
  ): void {
    this.create();
    if (anchorBounds) this.position(anchorBounds);
    this.chatWindow?.show();
    this.chatWindow?.focus();
    this.chatWindow?.webContents.focus();
    this.chatWindow?.webContents.send(event);
  }

  /** Places the chat window beside the pet within the active work area. */
  position(anchorBounds: Electron.Rectangle): void {
    if (!this.chatWindow) return;

    const area = screen.getDisplayMatching(anchorBounds).workArea;
    const { width: chatWidth, height: chatHeight } = this.size;

    let chatX = anchorBounds.x + anchorBounds.width;
    if (chatX + chatWidth > area.x + area.width) {
      chatX = anchorBounds.x - chatWidth;
    }
    chatX = Math.max(area.x, Math.min(chatX, area.x + area.width - chatWidth));
    const chatY = Math.max(
      area.y,
      Math.min(anchorBounds.y, area.y + area.height - chatHeight),
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
      if (process.env.DESKTOP_PET_DEVTOOLS === "1") {
        this.chatWindow?.webContents.openDevTools({ mode: "detach" });
      }
    });
    this.chatWindow.on("closed", () => {
      this.chatWindow = null;
    });
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
