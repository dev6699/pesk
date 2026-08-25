import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SavedMonitor {
  id?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

export interface PeskSettings {
  animation: string;
  animationMode: "selected" | "shuffle";
  x?: number;
  y?: number;
  monitor?: SavedMonitor;
  scale: number;
  paused: boolean;
  locked: boolean;
  visible: boolean;
  codexStatusSound: boolean;
}

export interface AppConfig {
  menuShortcut: string;
  petFocusShortcut: string;
  codexAppServerUrl: string;
  codexStatusSound: string;
}

export function loadRawConfig(): Record<string, any> {
  const bundledPath = path.join(app.getAppPath(), "config.json");
  const userPath = path.join(app.getPath("userData"), "config.json");
  let bundled: Record<string, any> = {};
  let user: Record<string, any> = {};
  try {
    bundled = JSON.parse(fs.readFileSync(bundledPath, "utf8"));
  } catch {
    // Bundled configuration is optional during development.
  }
  try {
    user = JSON.parse(fs.readFileSync(userPath, "utf8"));
  } catch {
    // User configuration is an optional post-install override.
  }
  return {
    ...bundled,
    ...user,
    animations: { ...(bundled.animations ?? {}), ...(user.animations ?? {}) },
  };
}

export function getConfigDirectory(): string {
  const userConfigPath = path.join(app.getPath("userData"), "config.json");
  return fs.existsSync(userConfigPath)
    ? app.getPath("userData")
    : app.getAppPath();
}

const defaultSettings: PeskSettings = {
  animation: "idle",
  animationMode: "selected",
  scale: 1,
  paused: false,
  locked: false,
  visible: true,
  codexStatusSound: true,
};

const defaultConfig: AppConfig = {
  menuShortcut: "Ctrl+Down",
  petFocusShortcut: "Ctrl+Up",
  codexAppServerUrl: "ws://127.0.0.1:4500",
  codexStatusSound: "",
};

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function loadSettings(): PeskSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    delete saved.codexChatVisible;
    delete saved.codexThreadId;
    return { ...defaultSettings, ...saved };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: PeskSettings): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

export function loadConfig(): AppConfig {
  try {
    const config = loadRawConfig();
    return {
      menuShortcut:
        typeof config.menuShortcut === "string" && config.menuShortcut.trim()
          ? config.menuShortcut.trim()
          : defaultConfig.menuShortcut,
      petFocusShortcut:
        typeof config.petFocusShortcut === "string" &&
        config.petFocusShortcut.trim()
          ? config.petFocusShortcut.trim()
          : defaultConfig.petFocusShortcut,
      codexAppServerUrl:
        typeof config.codexAppServerUrl === "string" &&
        /^wss?:\/\//.test(config.codexAppServerUrl)
          ? config.codexAppServerUrl
          : defaultConfig.codexAppServerUrl,
      codexStatusSound:
        typeof config.codexStatusSound === "string" &&
        config.codexStatusSound.trim()
          ? path.resolve(getConfigDirectory(), config.codexStatusSound.trim())
          : defaultConfig.codexStatusSound,
    };
  } catch {
    return { ...defaultConfig };
  }
}
