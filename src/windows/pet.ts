import { app, BrowserWindow, screen } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getConfigDirectory, loadRawConfig } from "../config/config.js";
import type { PeskSettings } from "../config/config.js";

export interface AnimationFrames {
  name: string;
  frames: string[];
  fps: number;
  size: number;
}

interface PetWindowOptions {
  getSettings: () => PeskSettings;
  saveSettings: () => void;
  publishRendererState: () => void;
  refreshTrayMenu: () => void;
  positionChat: () => void;
  showChat: () => void;
  hideChat: () => void;
  hideChatImmediately: () => void;
  hideMenu: () => void;
  focusChat: () => void;
  isChatFocused: () => boolean;
}

/** Owns the animated pet window, movement state, and animation selection. */
export class PetWindowController {
  private readonly animationFrames: AnimationFrames[];
  private petWindow: BrowserWindow | null = null;
  private dragTimer: NodeJS.Timeout | null = null;
  private dragTick = 0;
  private wanderDirection = 1;
  private wanderVerticalDirection = 1;
  private contentSize = { width: 0, height: 0 };

  constructor(private readonly options: PetWindowOptions) {
    this.animationFrames = loadAnimations();
  }

  /** Returns the current pet window, if it has been created. */
  get window(): BrowserWindow | null {
    return this.petWindow;
  }

  /** Returns the configured animation frame sets. */
  getAnimations(): AnimationFrames[] {
    return this.animationFrames;
  }

  /** Updates the pet renderer's focus indicator for pet or chat focus. */
  setFocusIndicator(focused: boolean): void {
    if (focused) this.setCodexUpdateIndicator(false);
    this.petWindow?.webContents.send("pet-focus-changed", focused);
  }

  /** Updates the indicator shown while Codex has opened chat without focus. */
  setCodexUpdateIndicator(active: boolean): void {
    this.petWindow?.webContents.send("pet-codex-update-changed", active);
  }

  /** Keeps the background-thread attention indicator active through auto-focus. */
  setBackgroundAttention(active: boolean): void {
    this.petWindow?.webContents.send("pet-codex-update-changed", active);
  }

  /** Plays the Codex attention sound for a background-thread prompt. */
  playCodexStatusSound(): void {
    this.petWindow?.webContents.send("pet-codex-status-sound");
  }

  /** Returns the configured native pet size used for window scaling. */
  getSize(): number {
    return this.animationFrames[0]?.size ?? 180;
  }

  /** Persists a configured animation selection. */
  selectAnimation(name: string): void {
    const animation = this.animationFrames.find((item) => item.name === name);
    if (!animation) return;
    const settings = this.options.getSettings();
    settings.animation = animation.name;
    this.options.saveSettings();
    this.options.publishRendererState();
  }

  /** Persists whether animation selection is fixed or shuffled. */
  setAnimationMode(mode: PeskSettings["animationMode"]): void {
    const settings = this.options.getSettings();
    settings.animationMode = mode;
    this.options.saveSettings();
    this.options.publishRendererState();
    this.options.refreshTrayMenu();
  }

  /** Creates the transparent pet window and wires its lifecycle events. */
  create(): void {
    const settings = this.options.getSettings();
    const position = this.initialPosition();
    const { width, height } = this.windowSize(settings.scale);
    this.petWindow = new BrowserWindow({
      type: "toolbar",
      x: position.x,
      y: position.y,
      width,
      height,
      frame: false,
      thickFrame: false,
      roundedCorners: false,
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
        preload: path.join(__dirname, "..", "preload.js"),
      },
    });

    this.petWindow.setMenu(null);
    this.petWindow.setSkipTaskbar(true);
    this.petWindow.setAlwaysOnTop(true, "floating");
    this.petWindow.loadFile(path.join(__dirname, "..", "renderer", "pet.html"));
    this.petWindow.once("ready-to-show", () => {
      if (settings.visible) this.petWindow?.showInactive();
      // if (process.env.DESKTOP_PET_DEVTOOLS === "1") {
      //   this.petWindow?.webContents.openDevTools({ mode: "detach" });
      // }
    });
    this.petWindow.on("moved", () => {
      this.saveWindowPosition();
      if (!this.dragTimer) this.options.positionChat();
    });
    this.petWindow.on("focus", () => {
      this.petWindow?.webContents.send("pet-focus-changed", true);
      this.options.showChat();
      this.options.focusChat();
    });
    this.petWindow.on("blur", () => {
      this.petWindow?.webContents.send("pet-focus-changed", false);
      this.options.hideChat();
    });
    this.petWindow.on("closed", () => {
      this.petWindow = null;
    });
  }

  /** Toggles pet and chat visibility while preserving chat preference. */
  toggleVisibility(): void {
    const settings = this.options.getSettings();
    settings.visible = !settings.visible;
    if (settings.visible) this.petWindow?.show();
    else this.petWindow?.hide();
    if (settings.visible) this.options.showChat();
    else this.options.hideChat();
    this.options.saveSettings();
    this.options.refreshTrayMenu();
    this.options.publishRendererState();
  }

  /** Toggles animation pause state. */
  togglePaused(): void {
    const settings = this.options.getSettings();
    settings.paused = !settings.paused;
    this.options.publishRendererState();
    this.options.refreshTrayMenu();
    this.options.saveSettings();
  }

  /** Toggles the notification sound for Codex status transitions. */
  toggleCodexStatusSound(): void {
    const settings = this.options.getSettings();
    settings.codexStatusSound = !settings.codexStatusSound;
    this.options.publishRendererState();
    this.options.refreshTrayMenu();
    this.options.saveSettings();
  }

  /** Toggles the pet position lock. */
  toggleLocked(): void {
    const settings = this.options.getSettings();
    settings.locked = !settings.locked;
    this.options.publishRendererState();
    this.options.refreshTrayMenu();
    this.options.saveSettings();
  }

  /** Shows the pet and restores chat when its preference allows it. */
  show(): void {
    const settings = this.options.getSettings();
    settings.visible = true;
    this.petWindow?.show();
    this.options.showChat();
    this.options.saveSettings();
    this.options.refreshTrayMenu();
  }

  /** Shows the pet for a notification without opening or focusing chat. */
  showForNotification(): void {
    const settings = this.options.getSettings();
    settings.visible = true;
    this.petWindow?.showInactive();
    this.options.saveSettings();
    this.options.refreshTrayMenu();
  }

  /** Brings the pet and Codex chat to the foreground for keyboard input. */
  focus(): void {
    if (!this.petWindow) return;
    if (this.petWindow.isFocused()) {
      this.options.focusChat();
      return;
    }
    if (this.options.isChatFocused()) {
      this.options.focusChat();
      return;
    }
    const settings = this.options.getSettings();
    settings.visible = true;
    this.options.hideMenu();
    this.petWindow.setFocusable(true);
    this.petWindow.show();
    this.petWindow.setSkipTaskbar(true);
    this.petWindow.moveTop();
    this.petWindow.webContents.send("codex-chat-visibility", true);
    this.petWindow.focus();
    this.petWindow.webContents.focus();
    this.petWindow.webContents.send("codex-input-focus");
    this.options.focusChat();
  }

  /** Brings only the pet window to the foreground. */
  focusWindow(): void {
    if (!this.petWindow || !this.petWindow.isVisible()) return;
    this.petWindow.show();
    this.petWindow.moveTop();
    this.petWindow.focus();
    this.petWindow.webContents.focus();
  }

  /** Moves the pet by renderer-provided deltas within its work area. */
  move(dx: number, dy: number): void {
    const settings = this.options.getSettings();
    if (!this.petWindow || settings.locked || !Number.isFinite(dx) || !Number.isFinite(dy)) return;

    const [x, y] = this.petWindow.getPosition();
    const area = screen.getDisplayMatching(this.petWindow.getBounds()).workArea;
    const bounds = this.petWindow.getBounds();
    const minX = area.x;
    // Keep the bounds valid even when status content is wider than the work area.
    // In that case the window is anchored at the work-area edge instead of being
    // moved to a negative coordinate by the inverted range.
    const maxX = Math.max(minX, area.x + area.width - bounds.width);
    const minY = area.y;
    const maxY = Math.max(minY, area.y + area.height - bounds.height);
    let nextX = x + Math.abs(dx) * this.wanderDirection;
    let nextY = y + Math.abs(dy) * this.wanderVerticalDirection;
    if (nextX >= maxX) {
      nextX = maxX;
      this.wanderDirection = -1;
    } else if (nextX <= minX) {
      nextX = minX;
      this.wanderDirection = 1;
    }
    if (nextY >= maxY) {
      nextY = maxY;
      this.wanderVerticalDirection = -1;
    } else if (nextY <= minY) {
      nextY = minY;
      this.wanderVerticalDirection = 1;
    }
    this.petWindow.setPosition(Math.round(nextX), Math.round(nextY), false);
    this.options.positionChat();
  }

  /** Starts cursor tracking for native-feeling pet dragging. */
  startDragging(): void {
    const settings = this.options.getSettings();
    if (!this.petWindow || settings.locked || this.dragTimer) return;

    const [windowX, windowY] = this.petWindow.getPosition();
    const cursor = screen.getCursorScreenPoint();
    const offsetX = cursor.x - windowX;
    const offsetY = cursor.y - windowY;
    this.options.hideChatImmediately();
    this.dragTimer = setInterval(() => {
      if (!this.petWindow || settings.locked) return this.stopDragging();
      const current = screen.getCursorScreenPoint();
      const nextX = Math.round(current.x - offsetX);
      const nextY = Math.round(current.y - offsetY);
      const [windowX, windowY] = this.petWindow.getPosition();
      if (nextX !== windowX || nextY !== windowY) {
        this.petWindow.setPosition(nextX, nextY, false);
      }
      this.dragTick += 1;
    }, 16);
  }

  /** Stops cursor tracking and persists the final pet position. */
  stopDragging(): void {
    const wasDragging = this.dragTimer !== null;
    if (this.dragTimer) clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.dragTick = 0;
    if (wasDragging) this.options.focusChat();
    this.saveWindowPosition();
  }

  /** Resizes the pet around its current center within display limits. */
  resize(scale: number): void {
    if (!this.petWindow || !Number.isFinite(scale)) return;
    const settings = this.options.getSettings();
    const display = screen.getDisplayMatching(this.petWindow.getBounds());
    const nextScale = Math.min(this.maxScale(display), Math.max(0.25, scale));
    const [oldWidth, oldHeight] = this.petWindow.getSize();
    const [oldX, oldY] = this.petWindow.getPosition();
    const { width: newWidth, height: newHeight } = this.windowSize(nextScale);
    const centerX = oldX + oldWidth / 2;
    const centerY = oldY + oldHeight / 2;
    settings.scale = nextScale;
    this.petWindow.setResizable(true);
    this.petWindow.setSize(newWidth, newHeight, false);
    this.petWindow.setResizable(false);
    this.petWindow.setPosition(
      Math.round(centerX - newWidth / 2),
      Math.round(centerY - newHeight / 2),
      false,
    );
    this.options.positionChat();
    this.options.saveSettings();
    this.options.publishRendererState();
  }

  /** Resizes the transparent window to contain renderer-reported status content. */
  resizeContent(width: number, height: number): void {
    if (!this.petWindow || !Number.isFinite(width) || !Number.isFinite(height)) return;
    this.contentSize = {
      width: Math.max(0, Math.ceil(width)),
      height: Math.max(0, Math.ceil(height)),
    };
    const { width: newWidth, height: newHeight } = this.windowSize(
      this.options.getSettings().scale,
    );
    const [oldWidth, oldHeight] = this.petWindow.getSize();
    if (oldWidth === newWidth && oldHeight === newHeight) return;

    const [oldX, oldY] = this.petWindow.getPosition();
    const centerX = oldX + oldWidth / 2;
    const centerY = oldY + oldHeight / 2;
    const area = screen.getDisplayMatching(this.petWindow.getBounds()).workArea;
    this.petWindow.setResizable(true);
    this.petWindow.setSize(newWidth, newHeight, false);
    this.petWindow.setResizable(false);
    this.petWindow.setPosition(
      Math.round(
        Math.min(
          area.x + Math.max(0, area.width - newWidth),
          Math.max(area.x, centerX - newWidth / 2),
        ),
      ),
      Math.round(
        Math.min(
          area.y + Math.max(0, area.height - newHeight),
          Math.max(area.y, centerY - newHeight / 2),
        ),
      ),
      false,
    );
    this.options.positionChat();
  }

  /** Stops movement and closes the pet window during shutdown. */
  close(): void {
    this.stopDragging();
    this.petWindow?.close();
  }

  private saveWindowPosition(): void {
    if (!this.petWindow) return;
    const settings = this.options.getSettings();
    const [x, y] = this.petWindow.getPosition();
    const display = screen.getDisplayMatching(this.petWindow.getBounds());
    settings.x = x;
    settings.y = y;
    settings.monitor = {
      id: display.id,
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor,
    };
    this.options.saveSettings();
  }

  private maxScale(display = screen.getPrimaryDisplay()): number {
    const area = display.workArea;
    return Math.max(0.25, Math.min(area.width / this.getSize(), area.height / this.getSize()));
  }

  private windowSize(scale: number): { width: number; height: number } {
    const artSize = Math.round(this.getSize() * scale);
    return {
      width: Math.max(artSize, this.contentSize.width),
      height: Math.max(artSize, this.contentSize.height),
    };
  }

  private initialPosition(): { x: number; y: number } {
    const settings = this.options.getSettings();
    const saved = settings.monitor;
    const displays = screen.getAllDisplays();
    const display =
      (saved &&
        (displays.find((item) => item.id === saved.id) ??
          displays.find(
            (item) =>
              item.bounds.x === saved.x &&
              item.bounds.y === saved.y &&
              item.bounds.width === saved.width &&
              item.bounds.height === saved.height,
          ))) ??
      screen.getPrimaryDisplay();
    const area = display.workArea;
    const scale = Math.min(this.maxScale(display), Math.max(0.25, settings.scale || 1));
    settings.scale = scale;
    const size = Math.round(this.getSize() * scale);
    const maxX = area.x + Math.max(0, area.width - size);
    const maxY = area.y + Math.max(0, area.height - size);
    return {
      x: Math.min(maxX, Math.max(area.x, settings.x ?? maxX - 40)),
      y: Math.min(maxY, Math.max(area.y, settings.y ?? maxY - 40)),
    };
  }
}

function loadAnimations(): AnimationFrames[] {
  const config = loadRawConfig();
  const configuredAnimationsDir =
    typeof config.animationsDir === "string" && config.animationsDir.trim()
      ? config.animationsDir.trim()
      : null;
  const animationPaths = configuredAnimationsDir
    ? [
        path.isAbsolute(configuredAnimationsDir)
          ? configuredAnimationsDir
          : path.resolve(getConfigDirectory(), configuredAnimationsDir),
      ]
    : [path.join(app.getPath("userData"), "animations")];
  const existingAnimationPaths = animationPaths.filter((directory) => fs.existsSync(directory));
  if (!existingAnimationPaths.length) return [];

  let defaultFps = 6;
  let configuredSize = 180;
  const animationFps: Record<string, number> = {};
  try {
    if (Number.isFinite(config.fps) && config.fps > 0) defaultFps = config.fps;
    if (Number.isFinite(config.petSize) && config.petSize > 0) configuredSize = config.petSize;
    if (config.animations && typeof config.animations === "object") {
      for (const [name, value] of Object.entries(config.animations)) {
        const fps = (value as { fps?: unknown }).fps;
        if (
          typeof value === "object" &&
          value !== null &&
          Number.isFinite(fps) &&
          (fps as number) > 0
        ) {
          animationFps[name.toLowerCase()] = fps as number;
        }
      }
    }
  } catch {
    // A missing or invalid global config uses the default animation settings.
  }

  const animations = new Map<string, AnimationFrames>();
  for (const animationsPath of existingAnimationPaths) {
    for (const entry of fs
      .readdirSync(animationsPath, { withFileTypes: true })
      .filter((item) => item.isDirectory())) {
      const directory = path.join(animationsPath, entry.name);
      const frames = fs
        .readdirSync(directory)
        .filter((file) => /^\d{3}\.png$/i.test(file))
        .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
        .map((file) => pathToFileURL(path.join(directory, file)).href);
      if (frames.length) {
        animations.set(entry.name, {
          name: entry.name,
          frames,
          fps: animationFps[entry.name.toLowerCase()] ?? defaultFps,
          size: configuredSize,
        });
      }
    }
  }
  return [...animations.values()];
}
