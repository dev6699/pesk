import { test, expect } from "../../helpers/electron-test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron Codex thread lifecycle", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async ({ electronProfile }) => {
    harness = new ElectronCodexHarness(electronProfile);
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("switches existing threads and deletes the selected thread", async () => {
    harness.server.threads.push({
      id: "e2e-thread-2",
      preview: "Second thread",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
    });
    let app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    await harness.showChat(app);
    await trigger.click();
    const secondThread = chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Second thread/ });
    await expect(secondThread).toBeVisible();
    await secondThread.click();
    await expect(trigger).toContainText("Second thread");

    await chat.getByRole("textbox", { name: "Message Codex" }).fill("/delete");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Escape");
    const send = chat.getByRole("button", { name: "Send" });
    await expect(send).toBeVisible();
    await send.click();
    await expect(trigger).toContainText("Fixture thread");
    expect(harness.server.methods).toContain("thread/delete");
    expect(harness.server.threads.map((thread) => thread.id)).toEqual(["e2e-thread-1"]);

    await app.close();
    app = await harness.launch();
    const relaunchedChat = await harness.waitForChat(app);
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await relaunchedChat.locator(".codex-session-trigger").click();
    await expect(relaunchedChat.locator("#codex-session-menu")).not.toContainText("Second thread");
  });

  test("archives the selected thread and removes it from the active list", async () => {
    let app = await harness.launch();
    const chat = await harness.waitForChat(app);
    await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread");
    await chat.getByRole("textbox", { name: "Message Codex" }).fill("/archive");
    await chat.getByRole("textbox", { name: "Message Codex" }).press("Escape");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => harness.server.methods).toContain("thread/archive");
    await expect(chat.locator(".codex-session-trigger")).toContainText("No active session");
    expect(harness.server.threads).toHaveLength(0);

    await app.close();
    app = await harness.launch();
    const relaunchedChat = await harness.waitForChat(app);
    await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
      "No active session",
    );
  });

  test("loads existing history and restores the selected thread when switching back", async () => {
    harness.server.threads.push({
      id: "history-thread",
      preview: "History thread",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
      turns: [
        {
          id: "history-turn",
          startedAt: 1,
          status: "completed",
          items: [
            {
              id: "history-user",
              type: "userMessage",
              content: [{ type: "text", text: "remember this prompt" }],
            },
            {
              id: "history-assistant",
              type: "agentMessage",
              text: "Remembered response",
            },
          ],
        },
      ],
    });
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /History thread/ })
      .click();
    await expect(trigger).toContainText("History thread");
    await expect(chat.locator("#codex-history-content")).toContainText("Remembered response");
    expect(harness.server.methods).toEqual(
      expect.arrayContaining(["thread/resume", "thread/read", "thread/turns/list"]),
    );

    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Fixture thread/ })
      .click();
    await expect(trigger).toContainText("Fixture thread");
    await expect(chat.locator("#codex-history-content")).not.toContainText("Remembered response");

    await harness.showChat(app);
    await trigger.click();
    await chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /History thread/ })
      .click();
    await expect(chat.locator("#codex-history-content")).toContainText("Remembered response");
  });

  test("keeps concurrent turns associated with their selected threads", async () => {
    harness.server.threads.push({
      id: "e2e-thread-2",
      preview: "Second thread",
      cwd: "/tmp/pesk-e2e-workspace",
      projectId: null,
    });
    harness.server.enableLongRunning();
    const app = await harness.launch();
    const chat = await harness.waitForChat(app);
    const trigger = chat.locator(".codex-session-trigger");
    await expect(trigger).toContainText("Fixture thread");
    const input = chat.getByRole("textbox", { name: "Message Codex" });
    await input.fill("work on the first thread");
    await input.press("Enter");
    await expect(chat.locator("#codex-working-status")).toBeVisible();

    await harness.showChat(app);
    await trigger.click();
    const secondThread = chat
      .locator("#codex-session-menu")
      .getByRole("option", { name: /Second thread/ });
    await expect(secondThread).toBeVisible();
    await secondThread.click();
    await input.fill("work on the second thread");
    await input.press("Enter");
    await expect.poll(() => harness.server.prompts).toHaveLength(2);
    expect(harness.server.methods.filter((method) => method === "turn/start")).toHaveLength(2);
  });
});
