import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeCodexAppServer } from "../servers/fake-codex/server";

export class ElectronCodexHarness {
  readonly server = new FakeCodexAppServer();
  readonly buildDirectory = path.resolve(process.env.PESK_BUILD_DIR || "build");
  readonly bundledConfigPath = path.join(this.buildDirectory, "config.json");
  readonly mainPath = path.join(this.buildDirectory, "main.js");
  readonly userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pesk-e2e-user-"));
  readonly userConfigPath = path.join(this.userDataDirectory, "config.json");
  private readonly applications = new Set<ElectronApplication>();
  originalConfig = "";
  private activeConfig: Record<string, unknown> | undefined;

  async start() {
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
    const app = await electron.launch({
      args: [`--user-data-dir=${this.userDataDirectory}`, this.mainPath],
      executablePath: process.env.PESK_ELECTRON_EXECUTABLE,
      env: Object.fromEntries(
        Object.entries(launchEnvironment).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
    });
    const playwrightClose = app.close.bind(app);
    app.close = async () => {
      let childProcess: ReturnType<ElectronApplication["process"]> | undefined;
      try {
        childProcess = app.process();
      } catch {
        return;
      }
      const exitPromise = app
        .evaluate(({ app: electronApp }) => electronApp.exit(0))
        .catch(() => undefined);
      try {
        await Promise.race([exitPromise, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      } catch {
        // The process may already have exited, especially after a crash test.
      }
      try {
        await Promise.race([
          playwrightClose(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ]);
      } catch {
        // E2E cleanup should not fail because the process exited during teardown.
      }
      if (childProcess.exitCode === null) {
        try {
          childProcess.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
        await waitForProcessExit(childProcess);
      }
    };
    this.applications.add(app);
    return app;
  }

  async waitForChat(app: ElectronApplication): Promise<Page> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const chat = app.windows().find((window) => window.url().includes("chat.html"));
      if (chat) {
        await chat.locator("#codex-chat").waitFor({ state: "visible" });
        if (process.env.PESK_E2E_HEADED === "1") await this.showChat(app);
        return chat;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Electron chat window did not open");
  }

  async relaunch(app: ElectronApplication): Promise<{ app: ElectronApplication; chat: Page }> {
    try {
      await app.close();
    } catch {
      // Crash-recovery tests may already have terminated the process.
    }
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const menu = app.windows().find((window) => window.url().includes("menu.html"));
      if (menu) return menu;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Electron menu window did not open");
  }

  async dispose() {
    await Promise.all(
      [...this.applications].map(async (app) => {
        try {
          await app.close();
        } catch {
          // The application may already have been terminated by a crash test.
        }
      }),
    );
    this.applications.clear();
    await this.server.close();
    await removeDirectoryWithRetry(this.userDataDirectory);
  }
}

async function waitForProcessExit(process: ReturnType<ElectronApplication["process"]>) {
  if (process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function removeDirectoryWithRetry(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
