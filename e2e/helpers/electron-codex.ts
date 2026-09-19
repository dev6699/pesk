import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { expect } from "playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FakeCodexAppServer } from "../servers/fake-codex/server";
import {
  createElectronProfile,
  resetElectronProfile,
  removeElectronProfile,
} from "./electron-profile";

export class ElectronCodexHarness {
  readonly server = new FakeCodexAppServer();
  readonly buildDirectory = path.resolve(process.env.PESK_BUILD_DIR || "build");
  readonly bundledConfigPath = path.join(this.buildDirectory, "config.json");
  readonly mainPath = path.join(this.buildDirectory, "main.js");
  readonly userDataDirectory: string;
  readonly userConfigPath: string;
  originalConfig = "";
  private activeConfig: Record<string, unknown> | undefined;
  private app: ElectronApplication | undefined;

  constructor(private readonly sharedProfile?: string) {
    this.userDataDirectory = sharedProfile ?? createElectronProfile();
    this.userConfigPath = path.join(this.userDataDirectory, "config.json");
  }

  async start() {
    await resetElectronProfile(this.userDataDirectory);
    await this.server.ready();
    this.originalConfig = fs.readFileSync(this.bundledConfigPath, "utf8");
    this.activeConfig = JSON.parse(this.originalConfig) as Record<string, unknown>;
    this.writeConfig({
      codexAppServerProfiles: [{ id: "e2e", name: "E2E", url: this.server.url }],
      activeCodexAppServerProfileId: "e2e",
    });
  }

  writeConfig(values: Record<string, unknown>) {
    this.activeConfig = { ...(this.activeConfig ?? JSON.parse(this.originalConfig)), ...values };
    fs.writeFileSync(this.userConfigPath, JSON.stringify(this.activeConfig, null, 2));
  }

  async launch(environment?: NodeJS.ProcessEnv): Promise<ElectronApplication> {
    const launchEnvironment = {
      ...process.env,
      ...environment,
      PESK_E2E_FIXED_WINDOW_POSITION: "80,80",
      PESK_E2E_USER_DATA_DIR: this.userDataDirectory,
    };
    this.app = await electron.launch({
      args: [`--user-data-dir=${this.userDataDirectory}`, this.mainPath],
      executablePath: process.env.PESK_ELECTRON_EXECUTABLE,
      env: Object.fromEntries(
        Object.entries(launchEnvironment).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
    });
    return this.app;
  }

  async waitForChat(app: ElectronApplication): Promise<Page> {
    const chat = await this.waitForWindow(app, "chat.html");
    await expect(chat.locator("#codex-chat")).toBeVisible();
    await this.showChat(app);
    return chat;
  }

  async waitForWindow(app: ElectronApplication, filename: string): Promise<Page> {
    let window: Page | undefined;
    await expect
      .poll(
        () => {
          window = app
            .windows()
            .find((page) => new URL(page.url()).pathname.endsWith(`/${filename}`));
          return Boolean(window);
        },
        { message: `Electron should open ${filename}` },
      )
      .toBe(true);
    await window!.waitForLoadState("domcontentloaded");
    return window!;
  }

  async relaunch(app: ElectronApplication): Promise<{ app: ElectronApplication; chat: Page }> {
    await app.close();
    const relaunched = await this.launch();
    return { app: relaunched, chat: await this.waitForChat(relaunched) };
  }

  async showChat(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ BrowserWindow }) => {
      const chat = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("chat.html"),
      );
      chat?.show();
      chat?.focus();
    });
  }

  async waitForMenu(app: ElectronApplication): Promise<Page> {
    return this.waitForWindow(app, "menu.html");
  }

  async focusWindow(app: ElectronApplication, page: Page): Promise<void> {
    const window = await app.browserWindow(page);
    try {
      // Pesk installs a once("ready-to-show") handler on each native window.
      // Finish that initial show before requesting focus, otherwise it can race
      // with our focus request and immediately hide the menu on blur.
      await window.evaluate(async (window) => {
        if (window.listenerCount("ready-to-show") > 0)
          await new Promise<void>((resolve) => window.once("ready-to-show", () => resolve()));
      });
      await window.evaluate((window) => {
        window.show();
        window.moveTop();
        window.focus();
        window.webContents.focus();
      });
      await expect.poll(() => window.evaluate((window) => window.isVisible())).toBe(true);
      await expect(page.locator("body")).toBeVisible();
    } finally {
      await window.dispose();
    }
  }

  async dispose() {
    await this.app?.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().forEach((w) => w.close());
    });
    await this.app?.close();
    await this.server.close();
    if (!this.sharedProfile) await removeElectronProfile(this.userDataDirectory);
  }
}
