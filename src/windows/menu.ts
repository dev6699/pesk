import { app, BrowserWindow, Menu, Tray } from "electron";
import * as path from "node:path";

interface MenuSettings {
  paused: boolean;
  locked: boolean;
  visible: boolean;
}

interface MenuOptions {
  getSettings: () => MenuSettings;
  getPetWindow: () => BrowserWindow | null;
  togglePaused: () => void;
  toggleLocked: () => void;
  togglePetVisibility: () => void;
  toggleCodexStatusSound: () => void;
  showPet: () => void;
}

/** Owns the tray menu and the keyboard-opened menu BrowserWindow. */
export class MenuController {
  private menuWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;

  constructor(private readonly options: MenuOptions) {}

  /** Creates the tray icon and installs its initial context menu. */
  create(): void {
    this.tray = new Tray(path.join(app.getAppPath(), "assets", "pesk-tray.png"));
    this.tray.setToolTip("Pesk");
    this.tray.on("click", () => this.options.showPet());
    this.refreshTrayMenu();
  }

  /** Rebuilds the tray context menu from current pet settings. */
  refreshTrayMenu(): void {
    this.tray?.setContextMenu(this.createPetMenu());
  }

  /** Opens the native context menu at the pet window. */
  showPetMenu(): void {
    const petWindow = this.options.getPetWindow();
    if (!petWindow) return;
    this.createPetMenu().popup({ window: petWindow });
  }

  /** Hides the custom menu window without destroying it. */
  hide(): void {
    this.menuWindow?.hide();
  }

  /** Creates or focuses the custom menu window. */
  showWindow(): void {
    if (!this.menuWindow) {
      this.createMenuWindow();
      return;
    }
    this.menuWindow.show();
    this.menuWindow.focus();
    this.menuWindow.webContents.send("menu-updated");
  }

  /** Closes the custom menu window. */
  close(): void {
    this.menuWindow?.close();
  }

  private createPetMenu(): Menu {
    const settings = this.options.getSettings();
    return Menu.buildFromTemplate([
      {
        label: settings.paused ? "Resume animation" : "Pause animation",
        click: this.options.togglePaused,
      },
      {
        label: settings.locked ? "Unlock position" : "Lock position",
        click: this.options.toggleLocked,
      },
      {
        label: settings.visible ? "Hide Pesk" : "Show Pesk",
        click: this.options.togglePetVisibility,
      },
      { type: "separator" },
      { label: "Quit Pesk", click: () => app.quit() },
    ]);
  }

  private createMenuWindow(): void {
    this.menuWindow = new BrowserWindow({
      type: "toolbar",
      width: 520,
      height: 620,
      title: "Pesk Menu",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      resizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "..", "preload.js"),
      },
    });
    this.menuWindow.setMenu(null);
    this.menuWindow.setSkipTaskbar(true);
    this.menuWindow.loadFile(path.join(__dirname, "..", "renderer", "menu.html"));
    this.menuWindow.once("ready-to-show", () => {
      this.menuWindow?.show();
      this.menuWindow?.focus();
      // if (process.env.DESKTOP_PET_DEVTOOLS === "1") {
      //   this.menuWindow?.webContents.openDevTools({ mode: "detach" });
      // }
    });
    this.menuWindow.on("focus", () =>
      this.menuWindow?.webContents.send("menu-focus-changed", true),
    );
    this.menuWindow.on("blur", () => {
      this.menuWindow?.webContents.send("menu-focus-changed", false);
      this.menuWindow?.hide();
    });
    this.menuWindow.on("closed", () => {
      this.menuWindow = null;
    });
  }
}
