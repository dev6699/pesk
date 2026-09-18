import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron Codex chat", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("sends a desktop prompt through the app-server and renders streamed events", async () => {
    harness.server.setStreamingDelay(250);
    let app = await harness.launch();
    try {
      const chat = await harness.waitForChat(app);
      await expect(chat.locator(".codex-session-trigger")).toContainText("Fixture thread", {
        timeout: 10_000,
      });
      const input = chat.getByRole("textbox", { name: "Message Codex" });
      await input.fill("hello from desktop");
      await input.press("Enter");
      await expect(chat.locator(".codex-message-user")).toContainText("hello from desktop");
      await expect.poll(() => harness.server.turnEvents).toContain("turn/started");
      await expect(chat.locator("#codex-history-content")).toContainText("Hello from fake ", {
        timeout: 10_000,
      });
      await expect(chat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
      expect(harness.server.streamDeltas).toEqual(["Hello from fake ", "Codex app-server."]);
      expect(harness.server.turnEvents).toEqual(["turn/started", "turn/completed"]);
      expect(harness.server.prompts).toEqual(["hello from desktop"]);

      await app.close();
      app = await harness.launch();
      const relaunchedChat = await harness.waitForChat(app);
      await expect(relaunchedChat.locator(".codex-session-trigger")).toContainText(
        "Fixture thread",
        { timeout: 10_000 },
      );
      await expect(relaunchedChat.locator("#codex-history-content")).toContainText(
        "Hello from fake Codex app-server.",
        { timeout: 10_000 },
      );
    } finally {
      await app.close();
    }
  });
});
