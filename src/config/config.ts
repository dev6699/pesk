import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultTheme, themes, type RendererTheme } from "./themes";

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
  codexAppServerUrl: string;
  codexStatusSound: string;
  webAccessEnabled: boolean;
  webPort: number;
  webTlsKey: string;
  webTlsCert: string;
  theme: RendererTheme;
  themeName: string;
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
  try {
    const user = JSON.parse(fs.readFileSync(userConfigPath, "utf8")) as Record<string, any>;
    const hasUserPathOverride = [
      "animationsDir",
      "codexStatusSound",
      "webTlsKey",
      "webTlsCert",
    ].some((key) => typeof user[key] === "string" && user[key].trim());
    return hasUserPathOverride ? app.getPath("userData") : app.getAppPath();
  } catch {
    return app.getAppPath();
  }
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
  codexAppServerUrl: "ws://127.0.0.1:4500",
  codexStatusSound: "",
  webAccessEnabled: false,
  webPort: 4587,
  webTlsKey: "",
  webTlsCert: "",
  theme: defaultTheme,
  themeName: "amber",
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
      codexAppServerUrl:
        typeof config.codexAppServerUrl === "string" && /^wss?:\/\//.test(config.codexAppServerUrl)
          ? config.codexAppServerUrl
          : defaultConfig.codexAppServerUrl,
      codexStatusSound:
        typeof config.codexStatusSound === "string" && config.codexStatusSound.trim()
          ? path.resolve(getConfigDirectory(), config.codexStatusSound.trim())
          : defaultConfig.codexStatusSound,
      webAccessEnabled: config.webAccessEnabled === true,
      webPort:
        typeof config.webPort === "number" &&
        Number.isInteger(config.webPort) &&
        config.webPort >= 1024 &&
        config.webPort <= 65535
          ? config.webPort
          : defaultConfig.webPort,
      webTlsKey:
        typeof config.webTlsKey === "string" && config.webTlsKey.trim()
          ? path.resolve(getConfigDirectory(), config.webTlsKey.trim())
          : defaultConfig.webTlsKey,
      webTlsCert:
        typeof config.webTlsCert === "string" && config.webTlsCert.trim()
          ? path.resolve(getConfigDirectory(), config.webTlsCert.trim())
          : defaultConfig.webTlsCert,
      theme:
        typeof config.theme === "string" && config.theme in themes
          ? themes[config.theme]
          : defaultConfig.theme,
      themeName:
        typeof config.theme === "string" && config.theme in themes
          ? config.theme
          : defaultConfig.themeName,
    };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveTheme(themeName: string): void {
  const userPath = path.join(app.getPath("userData"), "config.json");
  let user: Record<string, any> = {};
  try {
    user = JSON.parse(fs.readFileSync(userPath, "utf8"));
  } catch {
    // A user configuration is optional and can be created on first change.
  }
  user.theme = themeName;
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify(user, null, 2));
}
