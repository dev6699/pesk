import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron Codex chat", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("sends a desktop prompt through the app-server and renders streamed events", async () => {
    harness.server.setStreamingDelay(250);
    let app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("hello from desktop");
    await input.press("Enter");
    await expect(chat.locator(".codex-message-user")).toContainText("hello from desktop");
    await expect.poll(() => harness.server.turnEvents).toContain("turn/started");
    await expect(chat.locator("#codex-history-content")).toContainText("Hello from fake ");
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
    expect(harness.server.streamDeltas).toEqual(["Hello from fake ", "Codex app-server."]);
    expect(harness.server.turnEvents).toEqual(["turn/started", "turn/completed"]);
    expect(harness.server.prompts).toEqual(["hello from desktop"]);

    await app.close();
    app = await harness.launch();
    const relaunchedChat = await harness.waitForChat(app);
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await expect(relaunchedChat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
  });

  test("removes the highlighted queued message with Delete", async () => {
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });

    await input.fill("active prompt");
    await input.press("Enter");
    await expect.poll(() => harness.server.turnEvents).toContain("turn/started");
    await expect.poll(() => harness.server.hasLongRunningTurn()).toBe(true);

    for (const prompt of ["queued one", "queued two", "queued three"]) {
      await input.fill(prompt);
      await input.press("Enter");
    }

    const queued = chat.locator(".codex-queued-submission");
    await expect(queued).toHaveCount(3);
    await expect(queued.nth(1)).toContainText("queued two");

    await input.press("Alt+ArrowDown");
    await input.press("Alt+ArrowDown");
    await expect(queued.nth(1)).toHaveClass(/codex-message-selected/);

    await chat.keyboard.press("Delete");
    await expect.poll(() => harness.server.methods).toContain("thread/queue/delete");
    await expect
      .poll(() => harness.server.queuedSubmissionTexts())
      .toEqual(["queued one", "queued three"]);
    await expect(queued).toHaveCount(2);
    await expect(chat.locator(".codex-queued-submissions")).toContainText("queued one");
    await expect(chat.locator(".codex-queued-submissions")).toContainText("queued three");
    await expect(chat.locator(".codex-queued-submissions")).not.toContainText("queued two");
  });

  test("removes one queued message with its button", async () => {
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });

    await input.fill("active prompt");
    await input.press("Enter");
    await expect.poll(() => harness.server.hasLongRunningTurn()).toBe(true);

    for (const prompt of ["queued one", "queued two"]) {
      await input.fill(prompt);
      await input.press("Enter");
    }

    const queued = chat.locator(".codex-queued-submission");
    await expect(queued).toHaveCount(2);
    await queued
      .nth(0)
      .getByRole("button", { name: /Remove queued message: queued one/ })
      .click();
    await expect.poll(() => harness.server.methods).toContain("thread/queue/delete");
    await expect.poll(() => harness.server.queuedSubmissionTexts()).toEqual(["queued two"]);
    await expect(queued).toHaveCount(1);
    await expect(chat.locator(".codex-queued-submissions")).toContainText("queued two");
    await expect(chat.locator(".codex-queued-submissions")).not.toContainText("queued one");
  });
});
