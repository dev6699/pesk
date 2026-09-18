import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

async function crashElectron(
  app: Awaited<ReturnType<ElectronCodexHarness["launch"]>>,
): Promise<void> {
  const process = app.process();
  await new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
    process.kill("SIGKILL");
  });
}

test.describe("Electron persistence", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("reconnects and restores the active session after an Electron relaunch", async () => {
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await app.close();

      ({ app, chat } = await harness.relaunch(app));
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
    } finally {
      await app.close();
    }
  });

  test("relaunches cleanly after an active turn and accepts a new prompt", async () => {
    harness.server.enableLongRunning();
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("leave this running");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-working-status")).toBeVisible({ timeout: 10_000 });
      await app.close();

      harness.server.disableLongRunning();
      ({ app, chat } = await harness.relaunch(app));
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-working-status")).toBeHidden();
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("start fresh");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
    } finally {
      await app.close();
    }
  });

  test("restores configured threads and projects without duplicating them", async () => {
    harness.server.projects.push({
      id: "persisted-project",
      name: "Persisted project",
      roots: [{ path: "/tmp/persisted" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
    });
    harness.server.threads.push({
      id: "persisted-thread",
      preview: "Persisted thread",
      cwd: "/tmp/persisted",
      projectId: "persisted-project",
    });
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      const trigger = chat.locator(".codex-session-trigger");
      await expect(trigger).toContainText("Fixture thread", { timeout: 10_000 });
      await trigger.click();
      await expect(chat.locator("#codex-session-menu")).toContainText("Persisted project");
      await expect(
        chat.locator("#codex-session-menu").getByRole("option", { name: /Persisted thread/ }),
      ).toHaveCount(1);

      await app.close();
      ({ app, chat } = await harness.relaunch(app));
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await chat.locator(".codex-session-trigger").click();
      const menu = chat.locator("#codex-session-menu");
      await expect(menu.getByRole("option", { name: /Fixture thread/ })).toHaveCount(1);
      await expect(menu.getByRole("option", { name: /Persisted thread/ })).toHaveCount(1);
      await expect(menu).toContainText("Persisted project");
      expect(harness.server.threads.map((thread) => thread.id)).toEqual([
        "e2e-thread-1",
        "persisted-thread",
      ]);
      expect(harness.server.projects.map((project) => project.id)).toEqual(["persisted-project"]);
    } finally {
      await app.close();
    }
  });

  test("relaunches cleanly after the Electron process is killed while idle", async () => {
    let app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await crashElectron(app);

      const relaunched = await harness.relaunch(app);
      app = relaunched.app;
      const relaunchedChat = relaunched.chat;
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Fixture thread",
        { timeout: 10_000 },
      );
      await expect(relaunchedChat.locator("#codex-error")).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test("clears an interrupted running turn after a crash and accepts a new prompt", async () => {
    harness.server.enableLongRunning();
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("crash during this turn");
      await input.press("Enter");
      await expect(chat.locator("#codex-working-status")).toBeVisible({ timeout: 10_000 });
      await crashElectron(app);

      harness.server.disableLongRunning();
      ({ app, chat } = await harness.relaunch(app));
      await expect(chat.locator("#codex-working-status")).toBeHidden({ timeout: 10_000 });
      await chat.getByRole("textbox", { name: "Message Codex" }).fill("recover after crash");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
    } finally {
      await app.close();
    }
  });

  test("does not restore a pending approval after a crash", async () => {
    harness.server.enableApproval();
    let app = await harness.launch();
    try {
      let chat = await harness.waitForChat(app);
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("crash while approval is pending");
      await input.press("Enter");
      await expect(chat.locator("#codex-user-input")).toContainText("echo approval-required", {
        timeout: 10_000,
      });
      await crashElectron(app);

      harness.server.disableApproval();
      ({ app, chat } = await harness.relaunch(app));
      await expect(chat.locator("#codex-user-input")).toBeHidden({ timeout: 10_000 });
      await chat
        .getByRole("textbox", { name: "Message Codex" })
        .fill("recover after approval crash");
      await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
    } finally {
      await app.close();
    }
  });

  test("reconnects cleanly after restarting while disconnected", async () => {
    const port = harness.server.port;
    let app = await harness.launch();
    let restarted: FakeCodexAppServer | undefined;
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      await harness.server.close();
      await expect(chat.locator(".codex-session-trigger")).toContainText("No active session", {
        timeout: 10_000,
      });
      await crashElectron(app);

      restarted = new FakeCodexAppServer({ port });
      await restarted.ready();
      harness.writeConfig({
        codexAppServerProfiles: [{ id: "e2e", name: "E2E", url: restarted.url }],
        activeCodexAppServerProfileId: "e2e",
      });
      app = await harness.launch();
      const relaunchedChat = await harness.waitForChat(app);
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Fixture thread",
        { timeout: 10_000 },
      );
      await expect(relaunchedChat.locator("#codex-error")).toBeHidden();
    } finally {
      await app.close();
      await restarted?.close();
    }
  });
});
