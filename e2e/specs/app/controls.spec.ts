import { test, expect } from "playwright/test";
import { ElectronCodexHarness } from "../../helpers/electron-codex";

test.describe("Electron desktop controls", () => {
  let harness: ElectronCodexHarness;

  test.beforeEach(async () => {
    harness = new ElectronCodexHarness();
    await harness.start();
  });

  test.afterEach(async () => harness.dispose());

  test("toggles the desktop chat lock control", async () => {
    const app = await harness.launch();
    try {
      const chat = await expect
        .poll(() => app.windows().find((window) => window.url().includes("chat.html")))
        .toBeTruthy()
        .then(() => app.windows().find((window) => window.url().includes("chat.html"))!);
      const lock = chat.locator("#codex-chat-lock");
      await expect(lock).toHaveAttribute("aria-label", "Lock chat window");
      await lock.click();
      await expect(lock).toHaveAttribute("aria-label", "Unlock chat window");
      await lock.click();
      await expect(lock).toHaveAttribute("aria-label", "Lock chat window");
    } finally {
      await app.close();
    }
  });
});
