import { BrowserWindow, screen } from "electron";
import * as path from "node:path";
import { loadRawConfig } from "../config/config.js";
import type { PeskSettings } from "../config/config.js";

export interface ChatSize {
  width: number;
  height: number;
}

const MIN_CHAT_WIDTH = 360;
const MIN_CHAT_HEIGHT = 300;

/** Owns the Codex chat BrowserWindow. */
export class ChatWindowController {
  private readonly configuredSize: ChatSize;
  private size: ChatSize;
  private chatWindow: BrowserWindow | null = null;
  private anchorBounds: Electron.Rectangle | null = null;
  private readonly getSettings: () => PeskSettings;
  private readonly saveSettings: () => void;

  constructor(options: { getSettings: () => PeskSettings; saveSettings: () => void }) {
    const config = loadRawConfig();
    this.configuredSize = {
      width: positiveNumber(config.chatWidth, MIN_CHAT_WIDTH),
      height: positiveNumber(config.chatHeight, MIN_CHAT_HEIGHT),
    };
    this.getSettings = options.getSettings;
    this.saveSettings = options.saveSettings;
    this.size = this.savedSize();
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
    this.anchorBounds = anchorBounds;

    const area = screen.getDisplayMatching(anchorBounds).workArea;
    const { width: chatWidth, height: chatHeight } = this.size;

    let chatX = anchorBounds.x + anchorBounds.width;
    if (chatX + chatWidth > area.x + area.width) {
      chatX = anchorBounds.x - chatWidth;
    }
    chatX = Math.max(area.x, Math.min(chatX, area.x + area.width - chatWidth));
    const chatY = Math.max(area.y, Math.min(anchorBounds.y, area.y + area.height - chatHeight));
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
      resizable: true,
      minWidth: MIN_CHAT_WIDTH,
      minHeight: MIN_CHAT_HEIGHT,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
    });

    this.chatWindow.setMenu(null);
    this.chatWindow.setSkipTaskbar(true);
    this.chatWindow.loadURL("pesk://renderer/chat.html");
    this.chatWindow.on("resize", () => this.rememberSize());
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

  private savedSize(): ChatSize {
    const settings = this.getSettings();
    return {
      width: Math.max(
        MIN_CHAT_WIDTH,
        positiveNumber(settings.chatWidth, this.configuredSize.width),
      ),
      height: Math.max(
        MIN_CHAT_HEIGHT,
        positiveNumber(settings.chatHeight, this.configuredSize.height),
      ),
    };
  }

  private rememberSize(): void {
    if (!this.chatWindow) return;
    const [width, height] = this.chatWindow.getSize();
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    const settings = this.getSettings();
    settings.chatWidth = width;
    settings.chatHeight = height;
    this.saveSettings();
    if (this.anchorBounds) this.position(this.anchorBounds);
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
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
