import { app, globalShortcut } from "electron";
import * as path from "node:path";
import { ChatWindowController } from "../windows/chat";
import { FocusController } from "./focus";
import { ChatWebServer } from "../services/chat-web-server";
import { CodexController } from "../codex";
import { loadConfig, loadSettings, saveSettings, saveTheme } from "../config/config";
import { themes, type RendererTheme } from "../config/themes";
import type { PeskSettings } from "../config/config";
import { registerIpcHandlers } from "./ipc";
import { MenuController } from "../windows/menu";
import { NotificationController } from "../services/notification";
import { PetWindowController } from "../windows/pet";
import { PresetController } from "../services/preset";
import { RendererStatePublisher } from "./renderer-state";
import { handleWebCommand } from "./web-commands";
import { shortcutAccelerator } from "../renderer/shared/shortcuts";

export interface ApplicationContext {
  codex: CodexController;
  pet: PetWindowController;
  chat: ChatWindowController;
  presets: PresetController;
  menu: MenuController;
  webServer: ChatWebServer;
  state: RendererStatePublisher;
  focus: FocusController;
  userDataPath: string;
  quit: () => void;
  setTheme: (themeName: string) => void;
}

export class PeskApplication implements ApplicationContext {
  private settings!: PeskSettings;
  private statusSoundUrl = "";
  private stopped = false;
  private notifications!: NotificationController;
  private _webServer!: ChatWebServer;
  private _codex!: CodexController;
  private _pet!: PetWindowController;
  private _chat!: ChatWindowController;
  private _presets!: PresetController;
  private _menu!: MenuController;
  private _state!: RendererStatePublisher;
  private _focus!: FocusController;
  private theme!: RendererTheme;
  private themeName!: string;

  get codex() {
    return this._codex;
  }
  get pet() {
    return this._pet;
  }
  get chat() {
    return this._chat;
  }
  get presets() {
    return this._presets;
  }
  get menu() {
    return this._menu;
  }
  get webServer() {
    return this._webServer;
  }
  get state() {
    return this._state;
  }
  get focus() {
    return this._focus;
  }
  get userDataPath() {
    return app.getPath("userData");
  }

  setTheme(themeName: string): void {
    if (!(themeName in themes)) return;
    this.themeName = themeName;
    this.theme = themes[this.themeName];
    saveTheme(this.themeName);
    this.state.publish();
  }

  start(): void {
    this.settings = loadSettings();
    const config = loadConfig();
    this.theme = config.theme;
    this.themeName = config.themeName;
    this.statusSoundUrl = config.codexStatusSound;
    const debug = (...values: unknown[]): void => {
      if (!app.isPackaged) console.log("[pesk]", ...values);
    };
    this._chat = new ChatWindowController();
    this._presets = new PresetController(debug);
    this._webServer = new ChatWebServer({
      enabled: config.webAccessEnabled,
      port: config.webPort,
      tlsKey: config.webTlsKey,
      tlsCert: config.webTlsCert,
      rendererDirectory: path.join(__dirname, "..", "renderer"),
      webPushVapidPath: path.join(this.userDataPath, "web-push-vapid.json"),
      webPushSubscriptionsPath: path.join(this.userDataPath, "web-push-subscriptions.json"),
      deviceCredentialsPath: path.join(this.userDataPath, "web-devices.json"),
      getState: () => this.state.getState(),
      handleCommand: (message, reply) => this.handleWebCommand(message, reply),
      debug,
    });
    this._pet = new PetWindowController({
      getSettings: () => this.settings,
      saveSettings: () => saveSettings(this.settings),
      publishRendererState: () => this.state.publish(),
      refreshTrayMenu: () => this.menu.refreshTrayMenu(),
      positionChat: () => this.focus.positionChat(),
      showChat: () => {
        this.chat.showInactive(this.pet.window?.getBounds());
        this.pet.window?.moveTop();
      },
      hideChat: () => {
        if (!this.chat.window?.isFocused()) this.chat.hide();
        this.pet.setFocusIndicator(
          Boolean(this.pet.window?.isFocused() || this.chat.window?.isFocused()),
        );
      },
      hideChatImmediately: () => this.chat.hide(),
      hideMenu: () => this.menu.hide(),
      focusChat: () => {
        this.chat.create();
        this.focus.wireChatWindow();
        this.chat.focusInput(this.pet.window?.getBounds());
      },
      isChatFocused: () => this.chat.window?.isFocused() ?? false,
    });
    this._focus = new FocusController(this.chat, this.pet);
    this.notifications = new NotificationController(this.pet, this.chat, this.webServer);
    this._menu = new MenuController({
      getSettings: () => this.settings,
      getPetWindow: () => this.pet.window,
      togglePaused: () => this.pet.togglePaused(),
      toggleLocked: () => this.pet.toggleLocked(),
      togglePetVisibility: () => this.pet.toggleVisibility(),
      toggleCodexStatusSound: () => this.pet.toggleCodexStatusSound(),
      showPet: () => this.pet.show(),
    });
    this._codex = new CodexController({
      publishRendererState: () => this.state.publish(),
      publishStreamDelta: (delta) => this.state.publishStreamDelta(delta),
      handleNotification: (request) => this.notifications.handle(request),
      isChatVisible: () => this.chat.window?.isVisible() ?? false,
      clearNotification: () => this.notifications.clear(),
      debug,
    });
    this.codex.setSocketUrl(config.codexAppServerUrl);
    this._state = new RendererStatePublisher(
      () => this.settings,
      this.codex,
      () => this.statusSoundUrl,
      () => this.theme,
      () => this.themeName,
      () => this.pet.window,
      () => this.chat.window,
      this.webServer,
    );
    this.normalizeAnimation();
    registerIpcHandlers(this);
    this.registerShortcuts();
    this.pet.create();
    this.chat.create();
    this.focus.wireChatWindow();
    this.menu.create();
    this.codex.start();
    void this.webServer.start();
  }

  stop(): void {
    if (this.stopped || !this._codex) return;
    this.stopped = true;
    globalShortcut.unregisterAll();
    this.codex.stop();
    void this.webServer.stop();
    this.chat.close();
    this.pet.close();
    this.menu.close();
    saveSettings(this.settings);
  }

  quit(): void {
    app.quit();
  }

  private handleWebCommand(message: unknown, reply: (message: unknown) => void): void {
    handleWebCommand({ codex: this.codex, getState: () => this.state.getState() }, message, reply);
  }

  private normalizeAnimation(): void {
    const animations = this.pet.getAnimations();
    if (animations.some((animation) => animation.name === this.settings.animation)) return;
    const firstAnimation = animations[0];
    if (!firstAnimation) return;
    this.settings.animation = firstAnimation.name;
    saveSettings(this.settings);
  }

  private registerShortcuts(): void {
    globalShortcut.register(shortcutAccelerator("menu"), () => this.menu.showWindow());
    globalShortcut.register(shortcutAccelerator("petFocus"), () =>
      this.focus.routeGlobalShortcut(Boolean(this.codex.getState().pendingUserInput)),
    );
  }
}
