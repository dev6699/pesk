import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron Codex turn lifecycle", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("interrupts a long-running turn and leaves the composer usable", async () => {
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("keep working");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    await expect.poll(() => harness.server.turnEvents).toContain("turn/started");
    await input.press("Control+c");
    await expect(chat.locator("#codex-working-status")).toContainText("Conversation interrupted");
    expect(harness.server.methods).toContain("turn/interrupt");
    await expect(input).toBeEnabled();
    harness.server.disableLongRunning();
    await input.fill("start again");
    await input.press("Enter");
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
    expect(harness.server.prompts).toEqual(["keep working", "start again"]);
  });

  test("keeps a long-running turn responsive and completes its streamed response", async () => {
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("keep working");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    await expect(input).toBeEnabled();
    await expect.poll(() => harness.server.turnEvents).toContain("turn/started");

    harness.server.completeLongRunning();
    await expect(chat.locator("#codex-history-content")).toContainText(
      "Hello from fake Codex app-server.",
    );
    await expect(chat.locator("#codex-working-status")).toHaveClass(
      /codex-working-status-complete/,
    );
    await expect(chat.locator("#codex-working-status")).not.toContainText("Working");
    expect(harness.server.turnEvents).toEqual(["turn/started", "turn/completed"]);
  });

  test("steers an active desktop turn through the app-server", async () => {
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("start the task");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    await input.fill("also check the documentation");
    await input.press("Alt+Enter");
    await expect.poll(() => harness.server.methods).toContain("turn/steer");
    await expect(input).toHaveValue("");
  });

  test("keeps concurrent turns, events, and completions isolated by thread", async () => {
    harness.server.threads[0]!.preview = "Thread A";
    harness.server.threads.push({
      id: "concurrent-thread-b",
      preview: "Thread B",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
    });
    harness.server.setThreadResponse("e2e-thread-1", "Response from thread A");
    harness.server.setThreadResponse("concurrent-thread-b", "Response from thread B");
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await expect(trigger).toContainText("Thread A");

    await input.fill("run thread A");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();

    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Thread B/ })
      .click();
    await input.fill("run thread B");
    await input.press("Enter");
    await expect.poll(() => harness.server.prompts).toEqual(["run thread A", "run thread B"]);
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    await expect.poll(() => harness.server.turnEvents).toHaveLength(2);

    harness.server.completeLongRunning("e2e-thread-1");
    await expect.poll(() => harness.server.turnEvents).toHaveLength(3);
    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Thread A/ })
      .click();
    await expect(chat.locator("#codex-history-content")).toContainText("Response from thread A");
    await expect(chat.locator("#codex-history-content")).not.toContainText(
      "Response from thread B",
    );

    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Thread B/ })
      .click();
    await expect(chat.locator("#codex-working-status")).toBeVisible();
    harness.server.completeLongRunning("concurrent-thread-b");
    await expect.poll(() => harness.server.turnEvents).toHaveLength(4);
    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Thread B/ })
      .click();
    await expect(chat.locator("#codex-history-content")).toContainText("Response from thread B");
    await expect(chat.locator("#codex-history-content")).not.toContainText(
      "Response from thread A",
    );
    expect(harness.server.turnEvents).toEqual([
      "turn/started",
      "turn/started",
      "turn/completed",
      "turn/completed",
    ]);
  });
});
