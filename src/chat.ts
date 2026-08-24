import { BrowserWindow, screen } from "electron";
import * as path from "node:path";
import { loadRawConfig } from "./config.js";

export interface ChatSettings {
  codexChatVisible: boolean;
}

interface ChatWindowOptions {
  getPetWindow: () => BrowserWindow | null;
  getSettings: () => ChatSettings;
  saveSettings: () => void;
  sendSettings: () => void;
  keepPetAbove: () => void;
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

  /** Places the chat window beside the pet within the active work area. */
  position(): void {
    const petWindow = this.options.getPetWindow();
    if (!petWindow || !this.chatWindow) return;

    const petBounds = petWindow.getBounds();
    const area = screen.getDisplayMatching(petBounds).workArea;
    const { width: chatWidth, height: chatHeight } = this.size;
    this.chatWindow.setSize(chatWidth, chatHeight, false);

    let chatX = petBounds.x + petBounds.width - 60;
    if (chatX + chatWidth > area.x + area.width) {
      chatX = petBounds.x - chatWidth + 60;
    }
    chatX = Math.max(area.x, Math.min(chatX, area.x + area.width - chatWidth));
    const chatY = Math.max(
      area.y,
      Math.min(petBounds.y, area.y + area.height - chatHeight),
    );
    this.chatWindow.setPosition(chatX, chatY, false);
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
      if (this.options.getSettings().codexChatVisible) {
        this.chatWindow?.showInactive();
      }
      this.options.keepPetAbove();
      if (process.env.DESKTOP_PET_DEVTOOLS === "1") {
        this.chatWindow?.webContents.openDevTools({ mode: "detach" });
      }
    });
    this.chatWindow.on("closed", () => {
      this.chatWindow = null;
    });
    this.chatWindow.on("focus", () => this.options.keepPetAbove());
  }

  /** Shows chat when Codex activity requires the pet to become visible. */
  showForCodexUpdate(): void {
    const petWindow = this.options.getPetWindow();
    if (!petWindow) return;

    const settings = this.options.getSettings();
    const chatWasHidden = !settings.codexChatVisible;
    settings.codexChatVisible = true;
    if (chatWasHidden) this.options.saveSettings();
    if (!petWindow.isVisible()) petWindow.show();
    petWindow.webContents.send("codex-chat-visibility", true);
    this.create();
    this.position();
    this.chatWindow?.showInactive();
    this.options.keepPetAbove();
    if (chatWasHidden) this.options.sendSettings();
  }

  /** Shows chat for a pending Codex approval request. */
  showForApproval(): void {
    const settings = this.options.getSettings();
    settings.codexChatVisible = true;
    this.create();
    this.position();
    this.chatWindow?.showInactive();
    this.options.keepPetAbove();
    this.options.saveSettings();
  }

  /** Toggles the persisted chat visibility preference and window state. */
  toggle(): void {
    const settings = this.options.getSettings();
    settings.codexChatVisible = !settings.codexChatVisible;
    this.create();
    if (settings.codexChatVisible) {
      this.position();
      this.chatWindow?.show();
      this.options.keepPetAbove();
    } else {
      this.chatWindow?.hide();
    }
    this.options.saveSettings();
    this.options.sendSettings();
    if (settings.codexChatVisible) {
      this.options.getPetWindow()?.webContents.send("codex-input-focus");
    }
  }

  /** Shows chat when its persisted visibility preference allows it. */
  showIfVisible(): void {
    if (!this.options.getSettings().codexChatVisible) return;
    this.create();
    this.position();
    this.chatWindow?.show();
    this.options.keepPetAbove();
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
