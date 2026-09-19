import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";
import { FakeCodexAppServer } from "../../servers/fake-codex/server";

test.describe("Electron persistence", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("reconnects and restores the active session after an Electron relaunch", async () => {
    let app = await harness.launch();
    let chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await app.close();

    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
  });

  test("relaunches cleanly after an active turn and accepts a new prompt", async () => {
    harness.server.enableLongRunning();
    let app = await harness.launch();
    let chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("leave this running");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    await app.close();

    harness.server.disableLongRunning();
    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await expect(chat.locator("#codex-working-status")).toBeHidden();
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("start fresh");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
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
    let chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    await trigger.click();
    await expect(chat.locator("#codex-session-menu")).toContainText("Persisted project");
    await expect(
      chat.locator("#codex-session-menu").getByRole("option", { name: /Persisted thread/ }),
    ).toHaveCount(1);

    await app.close();
    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
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
  });

  test("relaunches cleanly after the Electron process is killed while idle", async () => {
    let app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");

    const relaunched = await harness.relaunch(app);
    app = relaunched.app;
    const relaunchedChat = relaunched.chat;
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await expect(relaunchedChat.locator("#codex-error")).toBeHidden();
  });

  test("clears an interrupted running turn after a crash and accepts a new prompt", async () => {
    harness.server.enableLongRunning();
    let app = await harness.launch();
    let chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("crash during this turn");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();

    harness.server.disableLongRunning();
    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator("#codex-working-status")).toBeHidden();
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("recover after crash");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
  });

  test("does not restore a pending approval after a crash", async () => {
    harness.server.enableApproval();
    let app = await harness.launch();
    let chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("crash while approval is pending");
    await input.press("Enter");
    await expect(chat.locator("#codex-user-input")).toContainText("echo approval-required");

    harness.server.disableApproval();
    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator("#codex-user-input")).toBeHidden();
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("recover after approval crash");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
  });

  test("reconnects cleanly after restarting while disconnected", async () => {
    const port = harness.server.port;
    let app = await harness.launch();
    let chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await harness.server.close();
    await expect(chat.locator(".codex-session-trigger")).toContainText("No active session");

    const restarted = new FakeCodexAppServer({ port });
    await restarted.ready();
    harness.writeConfig({
      codexAppServerProfiles: [{ id: "e2e", name: "E2E", url: restarted.url }],
      activeCodexAppServerProfileId: "e2e",
    });
    ({ app, chat } = await harness.relaunch(app));
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await expect(chat.locator("#codex-error")).toBeHidden();
    await restarted?.close();
  });
});
